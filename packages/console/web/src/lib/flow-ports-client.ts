import { bookOutputPorts, branchPorts, checkOutputConsumption, collectPorts, isAssignable, mapPorts, flowInputParams, flowInputPortId, mergePorts, paramsToInputPorts, parseParamSpecs, propagateRouterSchemas, resolveParamSchema, scriptInputPorts, subflowPorts, transformOutputKey } from "@bcp/shared";
import type { BranchNodeConfig, MergeNodeConfig, ParamSchemaFragment, ParamSpec, ScriptNodeConfig } from "@bcp/shared";
import type { Connection } from "@xyflow/react";
import type { FlowGraph, FlowNode, FlowPort, SchemaRow, BookWithSchedules } from "./types";

/**
 * Resolve every node's ports in the browser, from lists the page already has.
 *
 * The RULES come from @bcp/shared and are the same ones the server applies when
 * validating a save — only the lookup differs (it queries SQLite, this reads
 * the books and schemas already fetched). Doing it here is what lets a node
 * sprout handles the moment it is dropped on the canvas, instead of after a
 * round trip.
 */
export function resolvePortsClient(
  graph: FlowGraph,
  books: BookWithSchedules[],
  schemas: SchemaRow[],
  /** The other flows, for subflow nodes. Optional so the many callers that
   *  have no subflow in their graph need not fetch a list to prove it. */
  flows: Array<{ id: string; inputSchema?: string | null; outputSchema?: string | null }> = [],
): Map<string, FlowPort[]> {
  const bookById = new Map(books.map((b) => [b.id, b]));
  const flowById = new Map(flows.map((f) => [f.id, f]));
  const schemaFor = schemaLookup(schemas);
  const map = new Map<string, FlowPort[]>();
  for (const node of graph.nodes) map.set(node.id, portsFor(node, bookById, flowById, schemaFor));
  // Routers carry whatever flows into them, so they can only be typed once
  // every other node's ports exist. Same call the server makes, same rule.
  propagateRouterSchemas(graph, map);
  return map;
}

/**
 * Resolve a `name` / `name@version` citation against a fetched registry list:
 * newest matching version, parsed.
 *
 * Exported because THREE callers need the same answer — the canvas ports here,
 * the contract panel in FlowEditor and the trigger dialog's `deriveInputSchema`
 * — and the last two used to run a byte-equivalent copy of this function held
 * in agreement by a comment promising it "mirrors" this one. A promise in a
 * comment is not a guarantee; one function is. It also made the copy that feeds
 * the dialog unreachable from any test, since it was module-private in a page.
 *
 * It mirrors `SchemasService.resolve`: unpinned means the highest ACTIVE
 * version, a pin means that exact version. It cannot mirror the one case where
 * a pin outranks `active` (see `Schema.active` in schema.prisma: pinned lookups
 * deliberately drop the `active` filter so historic records stay readable),
 * because the list it reads is fetched without `includeInactive` and a retired
 * version is simply not in it. Nothing writes a pinned flowInput ref today —
 * `SchemaRefSelect` emits `{name}` only — so that case is unreachable rather
 * than handled, and is stated here so it is noticed if that changes.
 */
export function schemaLookup(schemas: SchemaRow[]) {
  return (ref?: { name: string; version?: number }): ParamSchemaFragment | null => {
    if (!ref?.name) return null;
    const candidates = schemas.filter((s) => !s.deletedAt && s.name === ref.name && (ref.version === undefined ? s.active : s.version === ref.version));
    const best = candidates.sort((a, b) => b.version - a.version)[0];
    return best ? parseJson(best.jsonSchema) : null;
  };
}

/** A stable port id, minted for a row that is about to exist. Short and
 *  opaque on purpose: it is never shown and never meant to be read, and the
 *  node ids on this canvas are minted the same way. */
export function mintPortId(): string {
  return `p${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * What a node dropped on the canvas starts life as.
 *
 * It arrives with ONE row rather than none: a node with no ports cannot be
 * connected to anything, which reads as "the canvas is broken" rather than
 * "configure me first".
 *
 * The row is minted with a `portId` here, at the only other place a parameter
 * can come into existence — `withFrozenPortIds` covers the ones that arrive
 * from storage, and between them no parameter ever exists without a stable id.
 * Seeding without one was a live bug for as long as this took to write: the
 * handle fell back to the NAME, so the first rename minted the id, moved the
 * handle, and `dropEdgesForGonePorts` — seeing an id that no longer existed —
 * deleted the wire outright. Strictly worse than the stranding it replaced,
 * and invisible to every test until the canvas was driven by hand.
 */
export function newNodeConfig(type: FlowNode["type"]): FlowNode["config"] {
  if (type === "transform") return { outputs: [{ id: mintPortId(), label: "out1", expr: "$" }] } as FlowNode["config"];
  if (type === "flowInput") return { params: [{ name: "param1", portId: mintPortId(), required: false, schema: { type: "string" } }] } as FlowNode["config"];
  // A branch with no case has one input and no outputs, which is the "cannot be
  // connected to anything" shape this function exists to avoid.
  if (type === "branch") return { cases: [{ id: mintPortId(), left: "$", op: "isNotEmpty" }], otherwise: true } as FlowNode["config"];
  if (type === "merge") return { inputs: [{ id: mintPortId() }, { id: mintPortId() }] } as FlowNode["config"];
  return {} as FlowNode["config"];
}

/**
 * A node loaded from storage, with its hand-named ports' ids pinned down.
 *
 * A parameter written before `portId` existed resolves its handle from its NAME
 * (see `flowInputPortId`), so the wires on it would still move the next time
 * somebody renamed it — the whole defect, surviving in every graph saved before
 * today. Freezing the fallback into a real `portId` on the way in ends that.
 *
 * It is a no-op on every value that matters, which is what makes it safe to do
 * silently and what makes a migration unnecessary: the id written IS the string
 * the port already resolved to, so the ports come out identical, every stored
 * edge finds the same handle, and the server — which resolves the SAVED graph
 * and may go on reading the un-frozen one for as long as the author does not
 * save — computes the same answer either way.
 *
 * Transform outputs need no equivalent: `id` was already their stable handle,
 * and the editor now writes the author's name to `label` instead of over it.
 */
export function withFrozenPortIds(node: FlowNode): FlowNode {
  // flowOutput freezes the SAME way and for the same reason — its `portId`
  // falls back to the node id, and pinning that down now is what makes the
  // fallback a one-time migration instead of a permanent branch. Written as a
  // separate early return rather than folded in below because the two node
  // types keep their ids in different places: a parameter each, versus one on
  // the node's own config.
  if (node.type === "flowOutput") {
    const config = node.config as { portId?: string };
    return config.portId ? node : { ...node, config: { ...config, portId: node.id } as FlowNode["config"] };
  }
  if (node.type !== "flowInput") return node;
  const params = (node.config as { params?: ParamSpec[] }).params ?? [];
  if (params.every((p) => p.portId)) return node;
  return {
    ...node,
    config: { ...(node.config as object), params: params.map((p) => (p.portId ? p : { ...p, portId: p.name })) } as FlowNode["config"],
  };
}

/** The part of an edge this module rewrites. Deliberately narrower than
 *  `FlowEdge`, so the same function serves the canvas's React Flow edges and a
 *  stored graph's without either being converted first. */
export interface SourceHandleEdge {
  source: string;
  sourceHandle?: string | null;
}

/**
 * The wires to keep after an author edited a node's output rows.
 *
 * A row deleted here is a PORT deleted, and a wire on a port that no longer
 * exists is worse than useless: React Flow will not draw an edge it cannot
 * anchor, so it disappears from the canvas while staying in the graph, where it
 * cannot be right-clicked, cannot be selected, and fails validation on every
 * save. It has to go with the row.
 *
 * A comparison of ID SETS is enough, and this function used to be much larger
 * because it wasn't. While a port's id was the parameter's name, a rename WAS a
 * delete plus an insert as far as this could see, so it matched rows by object
 * identity to tell the two apart and carried the wire across. `portId` retired
 * all of that: a rename does not change any id, so it does not reach this code
 * at all.
 *
 * Only the source side is considered: both node types name OUTPUTS. A book's
 * input ports are named by the book and a script's are fixed, so no editor on
 * this page can delete something a wire lands on.
 *
 * `before` matters — the empty `after` of a flowInput switched to 注册表 must
 * drop the inline ports' wires, while the empty `before` of one switched away
 * from it must not touch the wires on the ports the citation was resolving.
 *
 * @returns the same array when nothing was dropped, so React can skip the update
 */
export function dropEdgesForGonePorts<E extends SourceHandleEdge>(
  edges: E[],
  nodeId: string,
  before: readonly string[],
  after: readonly string[],
): E[] {
  const kept = new Set(after);
  const gone = new Set(before.filter((id) => !kept.has(id)));
  if (gone.size === 0) return edges;
  const doomed = (e: E) => e.source === nodeId && gone.has(e.sourceHandle ?? "");
  if (!edges.some(doomed)) return edges;
  return edges.filter((e) => !doomed(e));
}

/**
 * Build the field-level wires for a batch connection request.
 *
 * A batch action is deliberately conservative: labels must match exactly,
 * schemas must be assignable, and an input already occupied by any wire is
 * left alone. This makes the shortcut useful without silently replacing a
 * hand-authored mapping.
 */
export function matchingConnections(
  sourceNodeId: string,
  targetNodeId: string,
  ports: Map<string, FlowPort[]>,
  edges: ReadonlyArray<{ id?: string; source: string; sourceHandle?: string | null; target: string; targetHandle?: string | null }>,
): Connection[] {
  const sourcePorts = (ports.get(sourceNodeId) ?? []).filter((p) => p.direction === "out");
  const targetPorts = (ports.get(targetNodeId) ?? []).filter((p) => p.direction === "in");
  const occupiedTargets = new Set(
    edges.filter((e) => e.target === targetNodeId).map((e) => e.targetHandle ?? ""),
  );
  const existingPairs = new Set(
    edges
      .filter((e) => e.source === sourceNodeId && e.target === targetNodeId)
      .map((e) => `${e.sourceHandle ?? ""}→${e.targetHandle ?? ""}`),
  );
  const connections: Connection[] = [];
  for (const target of targetPorts) {
    if (occupiedTargets.has(target.id)) continue;
    const source = sourcePorts.find((p) => p.label === target.label && isAssignable(p.schema, target.schema).level !== "error");
    if (!source || existingPairs.has(`${source.id}→${target.id}`)) continue;
    connections.push({ source: sourceNodeId, sourceHandle: source.id, target: targetNodeId, targetHandle: target.id });
  }
  return connections;
}

function portsFor(
  node: FlowNode,
  bookById: Map<string, BookWithSchedules>,
  flowById: Map<string, { id: string; inputSchema?: string | null; outputSchema?: string | null }>,
  schemaFor: (ref?: { name: string; version?: number }) => ParamSchemaFragment | null,
): FlowPort[] {
  switch (node.type) {
    case "book": {
      const book = bookById.get((node.config as { bookId?: string }).bookId ?? "");
      if (!book) return [];
      return [...paramsToInputPorts(parseParamSpecs(book.paramSchema), schemaFor), ...bookOutputPorts(parseJson(book.outputSchema))];
    }
    case "script": {
      const config = node.config as ScriptNodeConfig;
      // Inline contract wins over the registry citation, mirroring `FlowOutputNodeConfig`
      // below. The schemaRef tag on the port is kept for display only — when an
      // inline schema is present the registry citation is dormant, so we do not
      // surface it as the source of truth.
      const inputSchema = config.inputSchema ?? schemaFor(config.inputSchemaRef);
      const outputSchema = config.outputSchema ?? schemaFor(config.outputSchemaRef);
      return [
        ...scriptInputPorts(inputSchema, schemaFor).map((p) =>
          config.inputSchema ? p : config.inputSchemaRef ? { ...p, schemaRef: config.inputSchemaRef } : p,
        ),
        {
          id: "output",
          label: "输出",
          direction: "out",
          required: false,
          schema: outputSchema,
          schemaRef: config.outputSchema ? undefined : config.outputSchemaRef,
        },
      ];
    }
    case "branch": {
      // Schemas are filled in by `propagateRouterSchemas` below, once every
      // other node's ports exist — a branch has none of its own.
      return branchPorts(node.config as BranchNodeConfig, null);
    }
    case "merge": {
      return mergePorts(node.config as MergeNodeConfig, null);
    }
    case "map":
      return mapPorts(null);
    case "collect":
      return collectPorts(null);
    case "flow": {
      // The child flow's own contract, off the list the page already fetched —
      // same rule the server applies, different lookup, which is the whole
      // arrangement this module exists for.
      const childId = (node.config as { flowId?: string }).flowId;
      const child = childId ? flowById.get(childId) : undefined;
      if (!child) return [];
       const childParams = parseParamSpecs(child.inputSchema);
       const childOutput = parseJson(child.outputSchema);
       return subflowPorts(childParams, childOutput ? resolveEmbeddedSchemaRefsClient(childOutput, schemaFor) : childOutput, schemaFor);
    }
    case "transform": {
      const outputs = (node.config as { outputs?: Array<{ id: string; label?: string; schema?: ParamSchemaFragment; schemaRef?: { name: string; version?: number } }> }).outputs ?? [];
      return [
        { id: "input", label: "输入", direction: "in", required: true, schema: null },
        ...outputs.map((out) => ({
          id: out.id,
          label: transformOutputKey(out),
          direction: "out" as const,
          required: false,
          schema: out.schema ? resolveEmbeddedSchemaRefsClient(out.schema, schemaFor) : schemaFor(out.schemaRef),
          ...(out.schema ? {} : out.schemaRef ? { schemaRef: out.schemaRef } : {}),
        })),
      ];
    }
    case "flowInput": {
      // The flow's own parameters leave this node, so they are outputs here.
      // Resolved through the shared helper rather than read straight off
      // `config.params`, because a node may cite the registry instead — and
      // the ports, the stored input contract and the trigger dialog all have to
      // agree on what this node declares.
      const config = node.config as { schemaRef?: { name: string; version?: number } };
      return flowInputParams(node.config, schemaFor).map((p) => ({
        // Handle and label part ways here: see `flowInputPortId`. A cited
        // schema's fields have no `portId` and cannot be renamed from this
        // page, so for those the two stay the same string.
        id: flowInputPortId(p),
        label: p.name,
        direction: "out" as const,
        required: false,
        schema: resolveParamSchema(p, schemaFor).schema,
        ...(p.schemaRef ? { schemaRef: p.schemaRef } : config.schemaRef ? { schemaRef: config.schemaRef } : {}),
      }));
    }
    case "flowOutput": {
      const config = node.config as { schemaRef?: { name: string; version?: number }; schema?: ParamSchemaFragment | null };
       return [{ id: "value", label: "流程产出", direction: "in", required: true, schema: config.schema ? resolveEmbeddedSchemaRefsClient(config.schema, schemaFor) : schemaFor(config.schemaRef), schemaRef: config.schemaRef }];
    }
    default:
      return [];
  }
}

function parseJson(json: string | null | undefined): ParamSchemaFragment | null {
  if (!json) return null;
  try {
    const parsed = JSON.parse(json);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as ParamSchemaFragment) : null;
  } catch {
    return null;
  }
}

function resolveEmbeddedSchemaRefsClient(schema: ParamSchemaFragment, resolve: (ref?: { name: string; version?: number }) => ParamSchemaFragment | null): ParamSchemaFragment {
  const visit = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(visit);
    if (!value || typeof value !== "object") return value;
    const object = value as Record<string, unknown>;
    const ref = object["x-bcp-schema-ref"];
    if (ref && typeof ref === "object" && typeof (ref as { name?: unknown }).name === "string") {
      const expanded = resolve(ref as { name: string; version?: number });
      if (!expanded) return value;
      const { ["x-bcp-schema-ref"]: _marker, ...annotations } = object;
      return { ...visit(expanded) as Record<string, unknown>, ...annotations };
    }
    return Object.fromEntries(Object.entries(object).map(([key, child]) => [key, visit(child)]));
  };
  return visit(schema) as ParamSchemaFragment;
}
