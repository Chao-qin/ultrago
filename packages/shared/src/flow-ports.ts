/**
 * Turning nodes into ports, and judging the wires between them.
 *
 * Lives in shared because BOTH sides need the same answer: the canvas resolves
 * ports as you drag, so a node has handles before anything is saved, and the
 * server resolves them again when validating a save. Two implementations of
 * this would drift, and the drift would show up as a wire the UI drew and the
 * runner could not honour.
 *
 * What is NOT here is where a book or a registered schema comes from — the
 * server reads a database, the browser reads lists it already has. Only the
 * lookup differs; the rules do not.
 */
import { isAssignable } from "./schema-compat.js";
import { parseConsoleParamSchema } from "./console-types.js";
import { jsonSchemaToParamSpecs } from "./param-schema-bridge.js";
import { BRANCH_OPERATOR_LABELS, BRANCH_OTHERWISE_PORT, COLLECT_RESULT_PORT, MAP_ITEM_PORT, isUnaryBranchOperator, topoOrder } from "./flow-types.js";
import type { BranchCase, BranchNodeConfig, FlowEdge, FlowGraph, FlowNode, FlowNodeType, FlowPort, FlowProblem, MergeNodeConfig } from "./flow-types.js";
import { resolveParamSchema, type ParamSchemaFragment, type ParamSchemaResolver, type ParamSpec } from "./param-runtime.js";

/** Every port a node exposes, keyed by node id. Built by the service, which is
 *  the only layer that can look a book or a registered schema up. */
export type PortMap = Map<string, FlowPort[]>;

/** Output ports every book node carries beyond its declared data.
 *
 *  `artifacts` is not a nicety: four of the five books in this repo produce a
 *  file under reports/ and nothing in `outputs` at all, so a canvas that only
 *  understood data ports could not wire them to anything. It is described with
 *  ordinary JSON Schema so the compatibility check has a single dialect —
 *  `kind: "artifact"` only changes how the port is drawn. */
export const ARTIFACT_ITEM_SCHEMA: ParamSchemaFragment = {
  type: "object",
  properties: { path: { type: "string" }, mimeType: { type: "string" }, size: { type: "integer" } },
  required: ["path"],
};

export function bookOutputPorts(outputSchema: ParamSchemaFragment | null): FlowPort[] {
  return [
    { id: "outputs", label: "产出数据", direction: "out", required: false, schema: outputSchema, kind: "data" },
    {
      id: "artifacts",
      label: "产出文件",
      direction: "out",
      required: false,
      schema: { type: "array", items: ARTIFACT_ITEM_SCHEMA },
      kind: "artifact",
    },
    { id: "status", label: "运行状态", direction: "out", required: false, schema: { type: "string" }, kind: "data" },
  ];
}

/** A book's declared params become its input ports, one each, keeping the
 *  `required` flag so an unconnected required port is a real error rather than
 *  a guess. */
export function paramsToInputPorts(params: ParamSpec[], resolveCitation?: ParamSchemaResolver): FlowPort[] {
  return params.map((p) => ({
    id: p.name,
    label: p.name,
    direction: "in" as const,
    required: p.required,
    schema: resolveParamSchema(p, resolveCitation).schema,
    ...(p.schemaRef ? { schemaRef: p.schemaRef } : {}),
  }));
}

/**
 * A script's input ports: ONE PER FIELD of its declared input contract.
 *
 * It used to be a single port called `input`, and that one decision is what
 * made "how do I read my parameters?" unanswerable. `resolveInputs` keys a
 * node's product by the port a wire lands on, so a lone `input` port meant the
 * process received `{"input": <value>}` — one level deeper than the schema it
 * was handed, and nothing anywhere said so. Worse, a single port accepts
 * several wires and the last one silently wins, so two upstreams could not be
 * fed in at all.
 *
 * Expanding the contract fixes both by construction: the ports ARE the fields,
 * so what arrives on stdin is exactly the object the schema describes, and each
 * field is separately wireable. The runner needs no change for this — it
 * already sends `resolveInputs` verbatim; it is the ports that were wrong.
 *
 * The same `jsonSchemaToParamSpecs` a book's cited `paramSchemaRef` goes
 * through, so a script and a book derive their inputs one way, not two.
 *
 * With nothing declared there is nothing to expand, and the single `input` port
 * remains — the author is mid-edit, and refusing to draw a port would make the
 * node unwireable exactly when they are trying to wire it up. That case keeps
 * the old wrapped shape, which is honest: an undeclared contract cannot promise
 * what stdin looks like, and the panel says so.
 */
export function scriptInputPorts(schema: ParamSchemaFragment | null, resolveCitation?: ParamSchemaResolver): FlowPort[] {
  const properties = schema && typeof schema === "object" ? (schema as { properties?: unknown }).properties : undefined;
  if (!properties || typeof properties !== "object" || Object.keys(properties).length === 0) {
    return [{ id: "input", label: "输入", direction: "in", required: true, schema }];
  }
  return paramsToInputPorts(jsonSchemaToParamSpecs(schema as unknown as Parameters<typeof jsonSchemaToParamSpecs>[0]), resolveCitation);
}

/**
 * A branch's ports: one input, one output per case, and an optional
 * `otherwise`.
 *
 * Every output carries the INPUT's schema, because a branch routes rather than
 * transforms — whatever came in is what leaves on the port that matched. That
 * pass-through is what keeps the canvas's type checking alive across a branch;
 * without it every wire leaving one would read "undeclared" and the checking
 * would quietly stop at the first conditional in the graph.
 */
export function branchPorts(config: BranchNodeConfig, inputSchema: ParamSchemaFragment | null): FlowPort[] {
  const ports: FlowPort[] = [{ id: "input", label: "输入", direction: "in", required: true, schema: inputSchema }];
  for (const branchCase of config.cases ?? []) {
    ports.push({
      id: branchCase.id,
      label: branchCase.label ?? describeCase(branchCase),
      direction: "out",
      required: false,
      schema: inputSchema,
    });
  }
  if (config.otherwise) {
    ports.push({ id: BRANCH_OTHERWISE_PORT, label: "其它情况", direction: "out", required: false, schema: inputSchema });
  }
  return ports;
}

/** A case as a short human-readable line, for a port whose author has not named
 *  it. Reading `$.status 等于 done` off the canvas beats reading `case_3`. */
export function describeCase(branchCase: BranchCase): string {
  const op = BRANCH_OPERATOR_LABELS[branchCase.op] ?? branchCase.op;
  return isUnaryBranchOperator(branchCase.op)
    ? `${branchCase.left} ${op}`
    : `${branchCase.left} ${op} ${branchCase.right ?? ""}`.trim();
}

/**
 * A merge's ports: the declared inputs, and one output.
 *
 * NONE of the inputs is required, and that is the entire point. A merge sits
 * where a branch's paths rejoin, so by construction only some of its inputs
 * will ever carry a value — marking them required would make every branching
 * graph unsavable, which is the shape of "required" that made the join node
 * impossible to express before this node existed.
 */
export function mergePorts(config: MergeNodeConfig, upstreamSchema: ParamSchemaFragment | null): FlowPort[] {
  const inputs = config.inputs?.length ? config.inputs : [{ id: "a" }, { id: "b" }];
  return [
    ...inputs.map((input, index) => ({
      id: input.id,
      label: input.label ?? `输入 ${index + 1}`,
      direction: "in" as const,
      required: false,
      schema: upstreamSchema,
    })),
    { id: "output", label: "输出", direction: "out" as const, required: false, schema: upstreamSchema },
  ];
}

/**
 * A map's ports: the array in, one element out.
 *
 * `items` is required — a map with nothing to iterate is not a map, and letting
 * it save unwired would put a node on the canvas that can only ever produce an
 * empty result.
 *
 * The element port's schema is the array's `items`, which is the ONE place the
 * type goes down a level. `projectSchema(schema, "$[]")` already speaks that
 * step, so a body node wired to `item` type-checks against the element type
 * rather than against the array — without it every wire leaving a map would
 * report "array cannot feed object" and the canvas would be telling the truth
 * about the wrong thing.
 */
export function mapPorts(itemsSchema: ParamSchemaFragment | null): FlowPort[] {
  return [
    { id: "items", label: "数组", direction: "in", required: true, schema: itemsSchema },
    { id: MAP_ITEM_PORT, label: "每一项", direction: "out", required: false, schema: projectSchema(itemsSchema, "$[]") },
  ];
}

/**
 * A collect's ports: one result in, the gathered array out.
 *
 * The mirror of `mapPorts`: this is where the type goes back UP a level, from
 * whatever one iteration produced to an array of it. `required: false` on the
 * input because an empty `items` means the body never runs and nothing ever
 * arrives — a legitimate outcome that produces `[]`, not a validation error.
 */
export function collectPorts(resultSchema: ParamSchemaFragment | null): FlowPort[] {
  return [
    { id: COLLECT_RESULT_PORT, label: "每项结果", direction: "in", required: false, schema: resultSchema },
    {
      id: "results",
      label: "全部结果",
      direction: "out",
      required: false,
      schema: resultSchema ? { type: "array", items: resultSchema } : null,
    },
  ];
}

/**
 * Give `branch` and `merge` nodes the schema of whatever flows into them.
 *
 * Neither declares a contract of its own — they route, they do not transform —
 * so their ports are only as typed as their upstream is. Resolving them in
 * isolation would leave every wire past the first conditional reading
 * "undeclared", and the canvas's type checking would quietly stop at exactly
 * the place a graph gets complicated enough to need it.
 *
 * Walked in topological order so a chain of them (branch → merge → branch)
 * carries the schema all the way through rather than one hop. A cyclic graph
 * has no order and is left alone: it is already a save-blocking error, and
 * guessing at ports for it would only add noise on top.
 */
export function propagateRouterSchemas(graph: FlowGraph, ports: PortMap): void {
  const order = topoOrder(graph);
  if (!order) return;
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  for (const nodeId of order) {
    const node = byId.get(nodeId);
    if (!node || !["branch", "merge", "map", "collect", "transform"].includes(node.type)) continue;
    const incoming = graph.edges.filter((e) => e.target === nodeId && e.kind !== "order");
    let inherited: ParamSchemaFragment | null = null;
    for (const edge of incoming) {
      const source = ports.get(edge.source)?.find((p) => p.id === edge.sourceHandle && p.direction === "out");
      const schema = edge.srcPath ? projectSchema(source?.schema ?? null, edge.srcPath) : (source?.schema ?? null);
      if (schema) {
        inherited = schema;
        break;
      }
    }
    if (!inherited) continue;
    // A branch or merge routes, so both sides carry the same shape. A map and a
    // collect CHANGE it by one level — element out of an array, array out of
    // elements — so they rebuild their ports from the inherited schema rather
    // than stamping it onto both ends.
    if (node.type === "map") {
      ports.set(nodeId, mapPorts(inherited));
      continue;
    }
    if (node.type === "collect") {
      ports.set(nodeId, collectPorts(inherited));
      continue;
    }
    // A transform inherits on its INPUT side only. Its outputs are whatever the
    // author's `expr` pulls out — a different shape by construction — so the
    // blanket "stamp it on every undeclared port" below would tell the canvas
    // that an output whose contract was left blank has the input's shape, and
    // `isAssignable` would then accept wires downstream on that false claim.
    // Without this branch the input port stayed `schema: null` forever, which
    // made isAssignable pass EVERY incoming wire (an unconstrained target
    // accepts anything) — type checking silently died at every mapping node.
    if (node.type === "transform") {
      ports.set(
        nodeId,
        (ports.get(nodeId) ?? []).map((port) =>
          port.direction === "in" && !port.schema ? { ...port, schema: inherited } : port,
        ),
      );
      continue;
    }
    ports.set(
      nodeId,
      (ports.get(nodeId) ?? []).map((port) => (port.schema ? port : { ...port, schema: inherited })),
    );
  }
}

/**
 * A port's handle and the key its value travels under are TWO strings.
 *
 * They used to be one, and that is the whole bug this pair exists to end: a
 * flowInput port was identified by the parameter's name, so renaming the
 * parameter renamed the port, and every wire on it was left pointing at a
 * handle that no longer existed — invisible on the canvas (React Flow will not
 * draw an edge it cannot anchor) and fatal on every save. The name cannot
 * simply be frozen instead: it IS the flow's public contract, the key the
 * trigger dialog asks for and the runner stores the value under.
 *
 * So the wire remembers `portId`, the data travels under `name`, and the one
 * place the two meet is `portOutputKey` below.
 *
 * The fallback to `name` is not a convenience — it is what makes this change
 * need no migration. For a graph written before `portId` existed the two
 * strings are identical, so every stored wire keeps resolving to the same port
 * it always did; the editor freezes the fallback into a real `portId` when it
 * loads such a node, after which the handle never moves again.
 */
export function flowInputPortId(param: ParamSpec): string {
  return param.portId ?? param.name;
}

/**
 * The two strings a flowOutput has, kept apart on purpose.
 *
 * `flowOutputKey` is the PUBLIC one: it names the field in the flow's declared
 * output contract and the key its value lands under, so it follows the node's
 * label and changing it is a deliberate rename of a public field — the same
 * bargain a flowInput parameter's name makes.
 *
 * `flowOutputPortId` is the STABLE one: it is what a wire would remember if
 * this flow were a node inside another flow. It never moves.
 *
 * They were one string until now, spelled `node.label ?? node.id` in two places
 * that had to agree — `deriveOutputSchema` and the runner's `finishRun`. One
 * definition, two readers, so they cannot drift apart the way the declared and
 * produced shapes already did once.
 */
export function flowOutputKey(node: Pick<FlowNode, "id" | "label">): string {
  return node.label ?? node.id;
}

export function flowOutputPortId(node: Pick<FlowNode, "id" | "config">): string {
  return (node.config as { portId?: string }).portId ?? node.id;
}

/** A transform field's name, and the key its value is stored under in the
 *  node's product. `id` is the stable handle; it doubles as the name only in
 *  graphs written before the editor filled `label` in. */
export function transformOutputKey(out: { id: string; label?: string }): string {
  return out.label ?? out.id;
}

/**
 * Where to find a port's value inside its node's output.
 *
 * The runner reads `upstream[edge.sourceHandle]`, and for every port whose name
 * nobody can edit — a book's `outputs`, a script's `output`, a flowOutput's
 * `value` — the handle IS the key, so this is the identity function. It is not
 * for the two node types an author names by hand: a flowInput's product is the
 * flow's parameters keyed by NAME, and a transform's is its fields keyed by
 * name too. Translating here rather than emitting under the id keeps both
 * readable in the run inspector, which is where someone goes when a value is
 * wrong.
 */
export function portOutputKey(node: FlowNode | undefined, handle: string): string {
  if (node?.type === "flowInput") {
    const params = (node.config as { params?: ParamSpec[] }).params ?? [];
    return params.find((p) => flowInputPortId(p) === handle)?.name ?? handle;
  }
  if (node?.type === "transform") {
    const outputs = (node.config as { outputs?: Array<{ id: string; label?: string }> }).outputs ?? [];
    const out = outputs.find((o) => o.id === handle);
    return out ? transformOutputKey(out) : handle;
  }
  return handle;
}

export function parseParamSpecs(json: string | null | undefined): ParamSpec[] {
  if (!json) return [];
  try {
    return parseConsoleParamSchema(json);
  } catch {
    return [];
  }
}

function portOf(ports: FlowPort[] | undefined, id: string, direction: "in" | "out"): FlowPort | undefined {
  return ports?.find((p) => p.id === id && p.direction === direction);
}

/** Which input ports already have a literal typed into them. */
function constantsOf(node: FlowNode): Set<string> {
  const config = node.config as { constants?: Record<string, unknown> };
  return new Set(Object.keys(config?.constants ?? {}));
}

/**
 * The checks that need ports resolved: does every required input have either a
 * wire or a constant, and does every wire connect two compatible shapes.
 *
 * Only `error` blocks a save. `warn` and `unsupported` are surfaced and let
 * through, because the judgement is deliberately incomplete — a schema the
 * canvas cannot read is checked for real at runtime instead, and refusing the
 * wire would just push the author into deleting the contract to get their work
 * done.
 */
export function validatePorts(graph: FlowGraph, ports: PortMap): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const wired = new Set<string>();
  // Counted, not just flagged: an input port holds ONE value, and `resolveInputs`
  // assigns them in edge order, so a second wire onto the same port does not
  // merge or conflict — it overwrites, silently, and the author sees a fully
  // connected canvas that quietly drops one of its upstreams. Nothing else in
  // the graph notices, which is why this has to be an error rather than a hint.
  const arrivals = new Map<string, FlowEdge[]>();
  for (const edge of graph.edges) {
    if (edge.kind === "order") continue;
    const key = `${edge.target}::${edge.targetHandle}`;
    wired.add(key);
    const list = arrivals.get(key);
    if (list) list.push(edge);
    else arrivals.set(key, [edge]);
  }
  for (const [key, edges] of arrivals) {
    if (edges.length < 2) continue;
    const [nodeId, handle] = key.split("::");
    const node = graph.nodes.find((n) => n.id === nodeId);
    const label = ports.get(nodeId)?.find((p) => p.id === handle && p.direction === "in")?.label ?? handle;
    problems.push({
      level: "error",
      at: edges[edges.length - 1].id,
      message: `${node?.label ?? nodeId}：入参「${label}」上接了 ${edges.length} 条线，运行时只会保留其中一条，其余的值会被丢掉`,
    });
  }

  // A flowOutput's public field name is `flowOutputKey`, and BOTH sides key by
  // it unconditionally — `deriveOutputSchema` when declaring the contract and
  // `finishRun` when collecting the products. Two outputs sharing a name
  // therefore overwrite each other in both places, and one node's product is
  // simply gone. That is unlike a duplicate INPUT name, which only asks for one
  // value twice and corrupts nothing (hence a warn there): this drops data, so
  // it has to block the save. New nodes carry no label and fall back to their
  // id, so this only ever fires once an author renames one onto another.
  const outputNames = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "flowOutput") continue;
    const key = flowOutputKey(node);
    if (outputNames.has(key)) {
      problems.push({
        level: "error",
        at: node.id,
        message: `流程出参名重复「${key}」，两个出参节点同名时只会保留一个，另一个的产出会被静默丢弃`,
      });
    }
    outputNames.add(key);
  }

  for (const node of graph.nodes) {
    const constants = constantsOf(node);
    for (const port of ports.get(node.id) ?? []) {
      if (port.direction !== "in" || !port.required) continue;
      if (wired.has(`${node.id}::${port.id}`) || constants.has(port.id)) continue;
      problems.push({ level: "error", at: node.id, message: `${node.label ?? node.id}：必填入参「${port.label}」既没有连线也没有填常量` });
    }
  }

  for (const edge of graph.edges) {
    if (edge.kind === "order") continue;
    problems.push(...checkEdge(edge, ports));
  }
  for (const node of graph.nodes) {
    problems.push(...checkOutputConsumption(graph, node, ports));
  }
  return problems;
}

/**
 * Per-source, per-field "nothing downstream reads this" hints.
 *
 * `checkEdge` already answers "can the upstream feed the downstream"; this
 * answer is the OTHER direction — "the upstream produced X, did anyone wire to
 * X?" — and the answer is the same `FlowProblem` shape so save + canvas can
 * surface both without a second pipeline.
 *
 * Limited to nodes whose output port carries an OBJECT schema with declared
 * `properties`. A script is the shape it is — declared inputs in, declared
 * object out, every field must reach a wire or it is a hint that something
 * the author meant to consume slipped through. A book or subflow has a single
 * blob output that callers intentionally take or leave, so the same check
 * there is just noise. Scoped to one type at a time so future expansion
 * (book/flow) is an opt-in call rather than a behaviour change.
 */
export function checkOutputConsumption(graph: FlowGraph, source: FlowNode, ports: PortMap): FlowProblem[] {
  if (source.type !== "script") return [];
  const outputPort = ports.get(source.id)?.find((p) => p.id === "output" && p.direction === "out");
  if (!outputPort) return [];
  // A scalar / array output has no `.properties` to enumerate, so there is
  // nothing to call "unconsumed". The same goes for an undeclared output —
  // judgement on absence is reserved for `checkEdge`, never for hints.
  const props = outputPort.schema?.type === "object" ? outputPort.schema.properties : undefined;
  if (!props) return [];
  const declaredKeys = Object.keys(props);
  if (declaredKeys.length === 0) return [];

  const consumed = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "order") continue;
    if (edge.source !== source.id) continue;
    // Anything that reaches a downstream `input` port is consumed in bulk; we
    // cannot say which fields flowed. The only accurate signal we have is
    // `srcPath`: `$.a.b` means "from the upstream output, take `.a.b`", so
    // `a` is consumed as a key.
    if (edge.sourceHandle !== "output") continue;
    if (!edge.srcPath) {
      // Whole-object wire — every declared key reaches SOMEONE, even if that
      // someone's downstream chooses to ignore it. Nothing left to warn about.
      return [];
    }
    const step = edge.srcPath.replace(/^\$/, "").match(/\.[A-Za-z_][A-Za-z0-9_]*/)?.[0];
    if (step) consumed.add(step.slice(1));
  }

  const problems: FlowProblem[] = [];
  for (const key of declaredKeys) {
    if (consumed.has(key)) continue;
    problems.push({
      level: "warn",
      at: source.id,
      message: `${source.label ?? source.id}：产出字段「${key}」没有任何下游消费`,
    });
  }
  return problems;
}

function checkEdge(edge: FlowEdge, ports: PortMap): FlowProblem[] {
  const source = portOf(ports.get(edge.source), edge.sourceHandle, "out");
  const target = portOf(ports.get(edge.target), edge.targetHandle, "in");
  if (!source) return [{ level: "error", at: edge.id, message: `连线起点端口不存在：${edge.source}.${edge.sourceHandle}` }];
  if (!target) return [{ level: "error", at: edge.id, message: `连线终点端口不存在：${edge.target}.${edge.targetHandle}` }];

  const projected = edge.srcPath ? projectSchema(source.schema, edge.srcPath) : source.schema;
  const verdict = isAssignable(projected, target.schema);
  if (verdict.level === "ok") return [];
  const where = verdict.at ? `（${verdict.at}）` : "";
  return [
    {
      level: verdict.level,
      at: edge.id,
      message: `${source.label} → ${target.label}${where}：${verdict.reason}`,
    },
  ];
}

/**
 * Narrow a schema to the part a path selects.
 *
 * Supports `.key` and `[n]` only — the same restricted grammar the transform
 * node speaks, and for the same reason: anything richer is a query language,
 * and a query language on the canvas is the JavaScript this design refuses.
 *
 * An unresolvable path yields null (unknown) rather than an error: the schema
 * may simply be undeclared, and treating "I can't see it" as "it's wrong"
 * would block wiring up the very books that have no output contract yet.
 */
export function projectSchema(schema: ParamSchemaFragment | null, path: string): ParamSchemaFragment | null {
  if (!schema) return null;
  const steps = path.replace(/^\$/, "").match(/\.[A-Za-z_][A-Za-z0-9_]*|\[\d*\]/g);
  if (!steps) return schema;
  let current: ParamSchemaFragment | null = schema;
  for (const step of steps) {
    if (!current) return null;
    if (step.startsWith("[")) {
      // A `$ref`-bearing items would have been rejected upstream by
      // isAssignable, so there is nothing to dereference here.
      const items: unknown = (current as { items?: unknown }).items;
      current = items && typeof items === "object" && !Array.isArray(items) ? (items as ParamSchemaFragment) : null;
      continue;
    }
    const key = step.slice(1);
    const props = (current as { properties?: Record<string, unknown> }).properties;
    const child = props && typeof props === "object" ? props[key] : undefined;
    current = child && typeof child === "object" && !Array.isArray(child) ? (child as ParamSchemaFragment) : null;
  }
  // `required` describes a parent's obligations about its children; carrying it
  // onto the extracted child would claim something the projection never says.
  if (current && "required" in current) {
    const { required: _dropped, ...rest } = current as Record<string, unknown>;
    return rest as ParamSchemaFragment;
  }
  return current;
}

/**
 * A port's type, short enough to sit on a node card.
 *
 * The canvas had no positive type display at all: a port whose contract was
 * missing said `·未声明`, and a port whose contract was KNOWN said nothing —
 * so the two cases a reader most needs to tell apart looked identical, and the
 * types this graph actually carries were invisible. Schemas propagate through
 * branch, merge, map and collect correctly (`propagateRouterSchemas`); they
 * were simply never shown, which is indistinguishable from not having them.
 *
 * `title` wins when a schema has one, because `商品` is what the author called
 * it and `对象` is what a validator calls everything. That is the difference
 * between a graph you can read and a graph of identically-labelled boxes.
 *
 * Returns null for a schema that constrains nothing — there is no type to
 * report, and inventing `任意` would dress up an absence as an answer.
 */
export function portTypeLabel(schema: ParamSchemaFragment | null | undefined): string | null {
  if (!schema || typeof schema !== "object") return null;
  if (typeof schema.title === "string" && schema.title.trim() !== "") return schema.title.trim();
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum.length <= 3 ? schema.enum.map(String).join("/") : "枚举";
  switch (schema.type) {
    case "string":
      return "文本";
    case "number":
      return "数字";
    case "integer":
      return "整数";
    case "boolean":
      return "是否";
    case "array": {
      const item = portTypeLabel(schema.items as ParamSchemaFragment | undefined);
      return item ? `${item}[]` : "数组";
    }
    case "object": {
      const props = schema.properties;
      if (props && typeof props === "object") {
        const keys = Object.keys(props);
        // The field names ARE the type when there are few of them, and they are
        // what someone wiring the port needs to know.
        if (keys.length > 0 && keys.length <= 3) return `{${keys.join(", ")}}`;
        if (keys.length > 0) return `对象 ${keys.length} 字段`;
      }
      return "对象";
    }
    default:
      // No `type`, but something else constrains it — `$ref` and `oneOf` both
      // land here. Saying "有契约" beats saying nothing, and beats guessing.
      return Object.keys(schema).some((k) => k === "$ref" || k === "oneOf" || k === "anyOf" || k === "allOf") ? "有契约" : null;
  }
}

/**
 * A subflow's ports: the child flow's own contract, verbatim, on BOTH sides.
 *
 * One input port per declared parameter, and one OUTPUT port per declared
 * output. The second half was collapsed into a single `output` carrying the
 * whole product, which made the node asymmetric with itself: a child declaring
 * 结果 and 汇总 offered two handles going in and one coming out, so wiring只
 * 汇总 downstream meant taking the whole object and picking a field out of it
 * with a transform. The child says it produces two things; the node should say
 * so too.
 *
 * The input side is `ParamSpec[]`, NOT a JSON Schema — `Flow.inputSchema` holds
 * what `deriveInputSchema` produced, the same list a book declares its
 * parameters with, so it goes through `paramsToInputPorts` and a subflow node's
 * handles are made the way a book node's are. Reading that column as a JSON
 * Schema yields an empty object and no ports at all, silently, which is how it
 * was written the first time.
 *
 * The output side IS a JSON Schema — `deriveOutputSchema` builds
 * `{type: "object", properties: {<每个 flowOutput 的名字>: …}}` — so its keys
 * are exactly the child's output names, and each becomes a port.
 *
 * A child that declares nothing on a side yields no ports on that side. That is
 * correct and readable: a flow with no `flowOutput` produces nothing, and a
 * node with nowhere to wire FROM is the honest picture of that.
 */
export function subflowPorts(params: ParamSpec[], outputSchema: ParamSchemaFragment | null, resolveCitation?: ParamSchemaResolver): FlowPort[] {
  const props = outputSchema && typeof outputSchema === "object" ? outputSchema.properties : null;
  const outs: FlowPort[] =
    props && typeof props === "object"
      ? Object.entries(props).map(([name, schema]) => ({
          id: name,
          label: name,
          direction: "out" as const,
          required: false,
           schema: (schema ?? null) as ParamSchemaFragment | null,
        }))
      : [];
  return [...paramsToInputPorts(params, resolveCitation), ...outs];
}
