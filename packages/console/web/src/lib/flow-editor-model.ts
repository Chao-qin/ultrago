/**
 * Graph-model helpers for the flow editor: config writes, schema/param
 * conversion, node subtitles and constant validation.
 *
 * Split out of FlowEditor.tsx — pure functions only, so the page and the
 * panels can share them without importing a component.
 */
import type { Edge } from "@xyflow/react";
import { validateParams } from "@bcp/shared";
import type { ParamSchemaFragment, ParamSpec, TransformOutput } from "@bcp/shared";
import type { FlowEdge, FlowGraph, FlowNode, FlowPort, FlowProblem } from "./types";

/**
 * Set one key on a node's config, keeping everything else it holds.
 *
 * Every panel field has to go through something like this, and the flowOutput
 * contract select used to be the exception: it wrote `config: {schemaRef}`
 * wholesale, which was harmless only because that node had nothing else to
 * lose. The script panel has a command sitting beside its two schema refs, and
 * wholesale writes there would erase it on every pick.
 *
 * Clearing DELETES the key rather than setting `undefined`: the graph is
 * compared and stored as JSON, and a key holding `undefined` is a key the
 * canvas can read back before `JSON.stringify` quietly drops it on save.
 */
export function withConfig(config: FlowNode["config"], key: string, value: unknown): FlowNode["config"] {
  const next = { ...(config as Record<string, unknown>) };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next as FlowNode["config"];
}

/** Literals typed into this node's unconnected input ports. */
export function constantsOf(config: FlowNode["config"]): Record<string, unknown> {
  return (config as { constants?: Record<string, unknown> }).constants ?? {};
}

/** One port's literal, written into `config.constants`. The map itself is
 *  dropped once the last entry goes, so a node nobody typed a constant into
 *  does not carry an empty object around in the saved graph. */
export function withConstant(config: FlowNode["config"], portId: string, value: unknown): FlowNode["config"] {
  const next = { ...constantsOf(config) };
  if (value === undefined) delete next[portId];
  else next[portId] = value;
  return withConfig(config, "constants", Object.keys(next).length > 0 ? next : undefined);
}

/** An inline object schema, read as the field list the editor shows. Anything
 *  that is not an object-with-properties yields no fields rather than a
 *  guess — a hand-written `{type:"array"}` is not a mistake to overwrite. */
export function paramsOfSchema(schema: ParamSchemaFragment | null | undefined): ParamSpec[] {
  const properties = (schema as { properties?: Record<string, ParamSchemaFragment> } | null | undefined)?.properties;
  if (!properties) return [];
  const required = new Set((schema as { required?: string[] }).required ?? []);
  return Object.entries(properties).map(([name, child]) => {
    const rawRef = child["x-bcp-schema-ref"] as { name?: unknown; version?: unknown } | undefined;
    const { ["x-bcp-schema-ref"]: _ref, description, ...rest } = child;
    return {
      name,
      required: required.has(name),
      ...(typeof description === "string" ? { description } : {}),
      ...(typeof rawRef?.name === "string" && Number.isInteger(rawRef.version)
        ? { schemaRef: { name: rawRef.name, version: rawRef.version as number } }
        : { schema: rest }),
    };
  });
}

export function subtitleOf(node: FlowNode, bookNames: Map<string, string>, booksLoaded: boolean): string | undefined {
  switch (node.type) {
    case "book": {
      const bookId = (node.config as { bookId?: string }).bookId;
      if (!bookId) return undefined;
      return bookNames.get(bookId) ?? (booksLoaded ? "（已删除的 book）" : undefined);
    }
    case "script": {
      const command = (node.config as { command?: string[] }).command ?? [];
      return command.length > 0 ? command.join(" ") : undefined;
    }
    case "transform": {
      const outputs = (node.config as { outputs?: TransformOutput[] }).outputs ?? [];
      return outputs.length > 0 ? outputs.map((o) => `${o.id}=${o.expr}`).join("，") : undefined;
    }
    case "flowOutput":
      return (node.config as { schemaRef?: { name: string } }).schemaRef?.name;
    default:
      return undefined;
  }
}

export function constantProblems(graph: FlowGraph, ports: Map<string, FlowPort[]>): FlowProblem[] {
  const problems: FlowProblem[] = [];
  for (const node of graph.nodes) {
    const values = constantsOf(node.config);
    for (const port of ports.get(node.id) ?? []) {
      if (port.direction !== "in" || !(port.id in values) || !port.schema) continue;
      const errors = validateParams([{ name: port.id, required: false, schema: port.schema }], { [port.id]: values[port.id] });
      for (const error of errors) problems.push({ level: "error", at: node.id, path: `constants.${port.id}`, tab: "inputs", message: `${node.label ?? node.id} / 入参 ${port.label}：${error.replace(`param "${port.id}" `, "")}` });
    }
  }
  return problems;
}

/** A stored edge, restored. It carries NO styling: how a wire looks is decided
 *  from the ports on every render (see `displayEdges`), so a graph reloaded
 *  from storage is judged and coloured exactly like one just drawn. Baking the
 *  colour in here was why reloading the page turned every verdict grey. */
export function toReactFlowEdge(e: FlowEdge): Edge {
  return {
    id: e.id,
    source: e.source,
    sourceHandle: e.sourceHandle,
    target: e.target,
    targetHandle: e.targetHandle,
    data: { kind: e.kind ?? "data", srcPath: e.srcPath },
  };
}
