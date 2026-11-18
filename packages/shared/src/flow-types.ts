/**
 * The flow graph: what the canvas draws, what the console stores, and what the
 * dispatcher walks. One definition for all three, because a graph the UI calls
 * valid and the runner cannot execute is the failure this file exists to avoid.
 *
 * A flow orchestrates ENDPOINTS. A book is one kind of endpoint — the
 * browser-automation kind — and scripts, transforms and (later) HTTP calls and
 * subflows are the others. Every endpoint answers the same two questions: what
 * shape do you take in, what shape do you give back. A flow answers them too,
 * which is what will let a flow become a node inside another flow.
 *
 * Implemented: `flowInput` / `book` / `script` / `transform` / `branch` /
 * `merge` / `map` / `collect` / `flowOutput`. `http`, `delivery` and `flow` (a
 * subflow) are deliberately absent rather than declared and unhandled — an unimplemented
 * member of this union would make every exhaustive switch lie about its
 * coverage. The same rule governs `FlowNode.onFail`, whose specified third
 * value `route` is left undeclared until the error port it needs exists.
 *
 * `branch` and `merge` arrived together on purpose. A branch without a join is
 * not half a feature, it is a trap: the paths it opens have to rejoin
 * somewhere, and until `merge` existed that somewhere was a node reading an
 * input its upstream never produced — silently, as `undefined`.
 */
import type { ParamSpec, ParamSchemaFragment } from "./param-runtime.js";
import type { ScriptLanguage } from "./script-skeleton.js";
import { jsonSchemaToParamSpecs } from "./param-schema-bridge.js";
import type { SchemaCitationInput } from "./schema-citation.js";

export const FLOW_NODE_TYPES = ["flowInput", "book", "script", "transform", "branch", "merge", "map", "collect", "flow", "flowOutput"] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export const FLOW_NODE_TYPE_LABELS: Record<FlowNodeType, string> = {
  flowInput: "流程入参",
  book: "Book",
  script: "本地脚本",
  transform: "数据映射",
  branch: "条件分支",
  merge: "分支汇合",
  map: "逐项处理",
  collect: "收集结果",
  flow: "子流程",
  flowOutput: "流程出参",
};

/** Node types that finish inside the tick that starts them: they are synchronous
 *  computation over values already in hand, with no process, no browser and no
 *  network. Nothing is gained by making them wait their turn. */
export const INSTANT_NODE_TYPES: readonly FlowNodeType[] = ["flowInput", "transform", "branch", "merge", "map", "collect", "flowOutput"];

export function isInstantNode(type: FlowNodeType): boolean {
  return INSTANT_NODE_TYPES.includes(type);
}

/**
 * Node types that take time but occupy NOTHING while they take it.
 *
 * There are two, and the distinction is not cosmetic. The scheduler allows one
 * ACTING node at a time because there is one browser; a node that is merely
 * WAITING must not hold that slot. A subflow is the case: it sits `running`
 * for as long as its child runs, and the child's own book and script nodes are
 * counted in their own right — the budget query spans every live flow run, not
 * just one. Count the parent too and it deadlocks instantly: the parent holds
 * the only slot, waiting for a child that can never get one.
 *
 * This is the deliberate exception to the rule stated on `ACTING_NODE_TYPES`
 * ("a new type is acting until someone declares it instant, the safe default").
 * For a waiting node, acting is not the safe default — it is the deadlock.
 */
export const WAITING_NODE_TYPES: readonly FlowNodeType[] = ["flow"];

export function isWaitingNode(type: FlowNodeType): boolean {
  return WAITING_NODE_TYPES.includes(type);
}

/** A single named port on a node, carrying the JSON Schema that decides which
 *  wires may land on it. `schema: null` means undeclared, which is a warning to
 *  connect through, never a refusal. */
export interface FlowPort {
  id: string;
  label: string;
  direction: "in" | "out";
  required: boolean;
  schema: ParamSchemaFragment | null;
  /** Where the schema came from, for the inspector to show. */
  schemaRef?: SchemaCitationInput;
  /** Rendering hint only — never consulted when judging a connection. */
  kind?: "data" | "artifact";
}

export interface BookNodeConfig {
  bookId: string;
  resumePolicy?: 'retry' | 'verify-before-retry';
  /** Literal values typed into unconnected input ports. */
  constants?: Record<string, unknown>;
  mode?: "auto" | "assisted";
}

export interface ScriptNodeConfig {
  description?: string;
  /**
   * argv, e.g. ["python3", ".claude/skills/product-preprocess/preprocess.py"].
   * Never a shell string: the input arrives on stdin precisely so nothing has
   * to be quoted into a command line.
   *
   * Optional since a node may instead carry its code inline (`source`). The two
   * are alternatives and `source` wins when both are set — the editor keeps
   * them exclusive, so "both" only arises in a hand-edited graph, and the
   * inline body is the one its author last saw.
   */
  command?: string[];
  /**
   * The BODY of `handler`, written on the canvas. Not a whole program: the
   * signature and the stdin/stdout plumbing are derived from the two contracts
   * by `buildScriptSource`, so an author writes logic and never the boilerplate
   * whose subtly wrong forms are indistinguishable from a broken node.
   *
   * Stored inline in `graphJson` rather than in a table of its own, which is
   * what makes a FlowRun's `graphSnapshot` carry the code it actually ran — a
   * past run stays explicable without a second history to join against.
   */
  source?: string;
  /** Which interpreter `source` is written for. Ignored when `command` is used,
   *  since that argv names its own. */
  language?: ScriptLanguage;
  /** Repo-relative. Absolute paths and `..` escapes are refused. */
  cwd?: string;
  /**
   * Inline input contract — same shape as the schema registry would deliver via
   * `inputSchemaRef`, just kept on the node itself. `portsFor` reads
   * `inputSchema ?? schemaFor(inputSchemaRef)`, so inline wins over the cited
   * schema and an absent `inputSchema` falls back to the registry reference —
   * mirroring `FlowOutputNodeConfig` below and keeping the two modes strictly
   * exclusive on the canvas so a save cannot carry both.
   */
  inputSchema?: ParamSchemaFragment | null;
  /**
   * Inline output contract. Same precedence as `inputSchema` — the runner
   * fail-closes on whatever schema is in force, whether inline or cited, so a
   * script whose output violates its declared shape is a real failure either
   * way.
   */
  outputSchema?: ParamSchemaFragment | null;
  /**
   * Registry citation, used when there is no inline `inputSchema`. The
   * registry entry holds a reusable shape that several flows may cite; inline
   * exists for the one-flow, one-script case where dragging a new schema in is
   * more ceremony than the contract deserves.
   */
  inputSchemaRef?: { name: string; version?: number };
  outputSchemaRef?: { name: string; version?: number };
  timeoutMs?: number;
  constants?: Record<string, unknown>;
}

/** One declarative output of a transform node. No JavaScript — see the flow
 *  spec §2.3: a book once exposed "generate the code yourself" as a parameter
 *  and a plain Chinese greeting became `你好 is not defined`. Anything needing a
 *  conditional or a loop is a script endpoint, not a box on the canvas. */
export interface TransformOutput {
  /** The STABLE port id — the handle a wire remembers. Minted once when the
   *  output is added and never edited afterwards, so renaming the field cannot
   *  reach the wire. In graphs written before `label` was filled in it doubles
   *  as the name, which is why every reader spells it `label ?? id`. */
  id: string;
  /** What the author calls this field, and the key its value is stored under in
   *  the node's product — see `transformOutputKey`. */
  label?: string;
  /** `$.a.b` / `$.items[0]` against the node's single input, a literal, or a
   *  "{{token}}" template. */
  expr: string;
  /** Inline output contract, mutually exclusive with `schemaRef`. */
  schema?: ParamSchemaFragment;
  schemaRef?: SchemaCitationInput;
}

export interface TransformNodeConfig {
  outputs: TransformOutput[];
  constants?: Record<string, unknown>;
}

/**
 * What a branch may ask about its input. A CLOSED list, and it stays closed.
 *
 * The obvious alternative — one text box holding a boolean expression — is the
 * thing this repo has already been burned by: `doubao-ask` once exposed a
 * parameter whose value was JavaScript, and passing it a plain Chinese greeting
 * produced `你好 is not defined`. A flow is an outer caller of the same kind, so
 * the rule is stronger here, not weaker. Anything a comparison cannot express
 * belongs in a script node, which has a file, a contract and tests.
 */
export const BRANCH_OPERATORS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "notContains",
  "startsWith",
  "endsWith",
  "isEmpty",
  "isNotEmpty",
  "isTrue",
  "isFalse",
] as const;
export type BranchOperator = (typeof BRANCH_OPERATORS)[number];

export const BRANCH_OPERATOR_LABELS: Record<BranchOperator, string> = {
  eq: "等于",
  ne: "不等于",
  gt: "大于",
  gte: "大于等于",
  lt: "小于",
  lte: "小于等于",
  contains: "包含",
  notContains: "不包含",
  startsWith: "以…开头",
  endsWith: "以…结尾",
  isEmpty: "为空",
  isNotEmpty: "不为空",
  isTrue: "为真",
  isFalse: "为假",
};

/** Operators that compare against nothing — the right-hand box is hidden for
 *  these, rather than accepted and ignored. */
export const UNARY_BRANCH_OPERATORS: readonly BranchOperator[] = ["isEmpty", "isNotEmpty", "isTrue", "isFalse"];

export function isUnaryBranchOperator(op: BranchOperator): boolean {
  return UNARY_BRANCH_OPERATORS.includes(op);
}

/** One case of a branch, and one output port. */
export interface BranchCase {
  /** The STABLE port id a wire remembers — minted once, never edited, for the
   *  same reason `TransformOutput.id` is. */
  id: string;
  label?: string;
  /** `$.a.b` / `$.items[0]` against the node's input. Bare text is compared as
   *  a literal, which is what someone branching on a constant expects. */
  left: string;
  op: BranchOperator;
  /** The value compared against — a `$`-path reads from the input like `left`
   *  does; anything else is the literal itself. Absent for unary operators. */
  right?: string;
}

export interface BranchNodeConfig {
  cases: BranchCase[];
  /** Expose an `otherwise` port for "no case matched". Without it, a run where
   *  nothing matches simply skips everything downstream, which is a legitimate
   *  outcome and not an error. */
  otherwise?: boolean;
  constants?: Record<string, unknown>;
}

/** The port id of a branch's fallback output. Fixed rather than minted, because
 *  there is exactly one and it is not something an author names. */
export const BRANCH_OTHERWISE_PORT = "otherwise";

export interface MergeNodeConfig {
  /** The input ports to expose. Two is the shape that follows a branch; more
   *  when several paths rejoin at once. */
  inputs: Array<{ id: string; label?: string }>;
}

/**
 * Run the nodes downstream of here ONCE PER ELEMENT of an array, then hand the
 * gathered results to a `collect`.
 *
 * The two arrive as a pair for the same reason `branch` and `merge` did: the
 * fan-out has to fan back in somewhere, and a `map` whose body simply ran off
 * the end of the graph would produce one node's worth of output for the last
 * item and silently drop the rest.
 *
 * ITERATION IS SEQUENTIAL, and that is not a limitation waiting to be lifted.
 * A flow run already permits at most one node that drives a browser or spawns a
 * process at a time, because Chrome stops rendering an occluded window — so
 * twenty items is twenty rounds either way. What a map buys is that nobody has
 * to sit there starting them.
 */
export interface MapNodeConfig {
  /** Values typed into the `items` port when nothing is wired to it. */
  constants?: Record<string, unknown>;
}

/** Where a `map`'s body hands each item's result back. One per map. */
export interface CollectNodeConfig {
  constants?: Record<string, unknown>;
}

/**
 * A whole other flow, used as one node.
 *
 * Its ports ARE the child's declared contract — `Flow.inputSchema` and
 * `Flow.outputSchema`, both already computed and stored when that flow is
 * saved. Nothing is declared twice, so a child that changes its parameters
 * changes this node's handles, and a wire that no longer fits stops fitting
 * visibly instead of at run time.
 *
 * That closure is the point: a flow is an endpoint like any other, which is
 * what makes composition work at all. It is also what makes a cycle possible —
 * A embedding B embedding A is infinite recursion, and no amount of
 * within-one-graph cycle checking sees it. `validateSubflows` walks the edges
 * BETWEEN flows for exactly this.
 */
export interface SubflowNodeConfig {
  /** Which flow to run. Nullable while the node is freshly dropped and nobody
   *  has chosen one — the canvas shows a node with no ports and says so. */
  flowId?: string;
  constants?: Record<string, unknown>;
}

/** The port a map emits the current element on, and the one a collect receives
 *  each result on. Fixed rather than minted: there is exactly one of each and
 *  neither is something an author names. */
export const MAP_ITEM_PORT = "item";
export const COLLECT_RESULT_PORT = "result";

export interface FlowInputNodeConfig {
  /** Declare the flow's parameters here, or cite the registry with
   *  `schemaRef`. A non-empty `params` wins when both are present, mirroring
   *  `FlowOutputNodeConfig` where the inline `schema` wins over its ref — see
   *  `deriveInputSchema` and `portsFor`, which both read it that way.
   *
   *  The editor keeps the two exclusive (picking the registry clears `params`),
   *  so "both present" only arises for a graph hand-edited or written by an
   *  older client. Inline winning is the safe answer there: it is what the
   *  author last saw on the canvas, and it resolves without the registry. */
  params: ParamSpec[];
  schemaRef?: SchemaCitationInput;
}

export interface FlowOutputNodeConfig {
  /**
   * The STABLE identity of this output, minted once and never edited.
   *
   * Nothing reads it yet, and that is the point of adding it now. A flow's
   * declared output is keyed by the node's NAME (`flowOutputKey`), which is the
   * right key for a public contract and the wrong one for a wire: the day a
   * flow becomes a node inside another flow, that key becomes a port handle,
   * and renaming an output would silently unhook every wire on it — the exact
   * defect `ParamSpec.portId` was introduced to end on the input side.
   *
   * Adding the field before there is a consumer costs nothing and needs no
   * migration: `flowOutputPortId` falls back to the node id, which is what a
   * graph written before today resolves to anyway, and the editor freezes that
   * fallback into a real value the first time it loads such a node. Adding it
   * afterwards would mean migrating every stored graph.
   */
  portId?: string;
  /** Cite the registry, or declare the shape here. `schema` wins when both are
   *  present — see `portsFor` (the port) and `deriveOutputSchema` (the Flow's
   *  recorded contract), which both read `config.schema ?? schemaFor(ref)`. */
  schemaRef?: SchemaCitationInput;
  schema?: ParamSchemaFragment | null;
  constants?: Record<string, unknown>;
}

export type FlowNodeConfig =
  | BookNodeConfig
  | ScriptNodeConfig
  | TransformNodeConfig
  | BranchNodeConfig
  | MergeNodeConfig
  | MapNodeConfig
  | CollectNodeConfig
  | SubflowNodeConfig
  | FlowInputNodeConfig
  | FlowOutputNodeConfig
  | Record<string, never>;

export interface FlowNode {
  id: string;
  type: FlowNodeType;
  position: { x: number; y: number };
  label?: string;
  /**
   * What a failure here means for the rest of the run. `stop` (the default)
   * ends it; `continue` fails only this node and the paths that depended on it,
   * leaving other branches to finish.
   *
   * A third value, `route`, was specified once and is deliberately NOT declared
   * here: it needs an error output port on every node type, and a member of
   * this union that the runner does not handle would make every exhaustive
   * switch over it lie about its coverage. Add the value when the port exists.
   */
  onFail?: "stop" | "continue";
  config: FlowNodeConfig;
}

export interface FlowEdge {
  id: string;
  source: string;
  /** Output port id on the source node. */
  sourceHandle: string;
  target: string;
  /** Input port id on the target node. */
  targetHandle: string;
  /** "data" carries a value AND implies ordering; "order" only orders. */
  kind?: "data" | "order";
  /** Take only part of the upstream value, e.g. "$.items[0].url". */
  srcPath?: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  edges: FlowEdge[];
  viewport?: { x: number; y: number; zoom: number };
}

export const EMPTY_GRAPH: FlowGraph = { nodes: [], edges: [] };

export type FlowRunStatus = "pending" | "running" | "success" | "failed" | "cancelled" | "paused";
export type FlowNodeRunStatus = "pending" | "ready" | "running" | "success" | "failed" | "skipped";

export interface FlowProblem {
  /**
   * `unsupported` is not a lesser warning — it is the canvas declining to
   * judge, with a full validator taking over at runtime. Kept distinct from
   * `warn` because it appears once per wire touching such a contract and would
   * otherwise bury the handful of problems an author can actually act on.
   * Only `error` blocks a save or a trigger.
   */
  level: "error" | "warn" | "unsupported";
  /** Node or edge id the problem belongs to, so the canvas can highlight it. */
  at?: string;
  /** Optional config/field path used to focus the inspector. */
  path?: string;
  /** Preferred inspector tab when the problem is opened. */
  tab?: "props" | "io" | "inputs";
  message: string;
}

/* ------------------------------------------------------------------ *
 * Graph algorithms — pure, so both the save path and the UI can run   *
 * them without a database.                                            *
 * ------------------------------------------------------------------ */

/** Adjacency built from BOTH edge kinds: a data edge carries a value and
 *  therefore also orders its endpoints, while an order edge only orders. */
function adjacency(graph: FlowGraph): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const node of graph.nodes) out.set(node.id, new Set());
  for (const edge of graph.edges) {
    if (!out.has(edge.source) || !out.has(edge.target)) continue; // dangling — reported separately
    out.get(edge.source)!.add(edge.target);
  }
  return out;
}

/**
 * Execution order, or null when the graph has a cycle.
 *
 * Kahn's algorithm, so the leftover nodes after the queue drains are exactly
 * the ones trapped in cycles — which is what `findCycle` reports on.
 */
export function topoOrder(graph: FlowGraph): string[] | null {
  const adj = adjacency(graph);
  const indegree = new Map<string, number>();
  for (const id of adj.keys()) indegree.set(id, 0);
  for (const targets of adj.values()) for (const t of targets) indegree.set(t, (indegree.get(t) ?? 0) + 1);

  const queue = [...indegree.entries()].filter(([, n]) => n === 0).map(([id]) => id);
  const order: string[] = [];
  while (queue.length > 0) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const left = (indegree.get(next) ?? 0) - 1;
      indegree.set(next, left);
      if (left === 0) queue.push(next);
    }
  }
  return order.length === adj.size ? order : null;
}

/** One concrete cycle, for an error message that names the loop instead of
 *  just asserting one exists. */
export function findCycle(graph: FlowGraph): string[] | null {
  const adj = adjacency(graph);
  const state = new Map<string, 0 | 1 | 2>(); // unvisited / on stack / done
  const stack: string[] = [];

  const walk = (id: string): string[] | null => {
    state.set(id, 1);
    stack.push(id);
    for (const next of adj.get(id) ?? []) {
      if (state.get(next) === 1) return [...stack.slice(stack.indexOf(next)), next];
      if (!state.get(next)) {
        const found = walk(next);
        if (found) return found;
      }
    }
    stack.pop();
    state.set(id, 2);
    return null;
  };

  for (const id of adj.keys()) {
    if (!state.get(id)) {
      const found = walk(id);
      if (found) return found;
    }
  }
  return null;
}

/** Which input ports have a wire landing on them. */
export function connectedInputs(graph: FlowGraph): Set<string> {
  const keys = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.kind === "order") continue;
    keys.add(`${edge.target}::${edge.targetHandle}`);
  }
  return keys;
}

/**
 * Structural checks that need no database: dangling edges, duplicate ids,
 * cycles, missing entry/exit nodes.
 *
 * Port-level checks (is this required input satisfied, are these two schemas
 * compatible) need the ports resolved first — a book's ports come from its
 * paramSchema — so they live in the service, which can look them up.
 */
export function validateGraphShape(graph: FlowGraph): FlowProblem[] {
  const problems: FlowProblem[] = [];
  const ids = new Set<string>();
  for (const node of graph.nodes) {
    if (ids.has(node.id)) problems.push({ level: "error", at: node.id, message: `节点 id 重复：${node.id}` });
    ids.add(node.id);
  }

  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) problems.push({ level: "error", at: edge.id, message: `连线 id 重复：${edge.id}` });
    edgeIds.add(edge.id);
    if (!ids.has(edge.source)) problems.push({ level: "error", at: edge.id, message: `连线指向不存在的起点节点 ${edge.source}` });
    if (!ids.has(edge.target)) problems.push({ level: "error", at: edge.id, message: `连线指向不存在的终点节点 ${edge.target}` });
    if (edge.source === edge.target) problems.push({ level: "error", at: edge.id, message: "节点不能连向自己" });
  }

  const cycle = findCycle(graph);
  if (cycle) {
    problems.push({ level: "error", at: cycle[0], message: `流程存在环：${cycle.join(" → ")}` });
  }

  // Two parameters with one name used to be self-punishing: the name was also
  // the port id, so the duplicate collapsed into a single handle and the author
  // saw it immediately. Now that a wire remembers a stable `portId`, both ports
  // survive, both read the same value out of `paramsJson`, and
  // `deriveInputSchema` silently keeps the first — a flow that looks wired and
  // is quietly asking for one value twice. Say so instead.
  for (const node of graph.nodes) {
    if (node.type !== "flowInput") continue;
    const seen = new Set<string>();
    for (const param of (node.config as FlowInputNodeConfig).params ?? []) {
      if (seen.has(param.name)) {
        problems.push({ level: "warn", at: node.id, message: `${node.label ?? node.id}：参数名重复「${param.name}」，触发时只会问一次，两个端口拿到同一个值` });
      }
      seen.add(param.name);
    }
  }

  if (graph.nodes.length > 0 && !graph.nodes.some((n) => n.type === "flowInput")) {
    problems.push({ level: "warn", message: "没有「流程入参」节点，这条流程无法从外部接收参数" });
  }
  if (graph.nodes.length > 0 && !graph.nodes.some((n) => n.type === "flowOutput")) {
    problems.push({ level: "warn", message: "没有「流程出参」节点，这条流程不会产出可被下游使用的数据" });
  }
  return problems;
}

/**
 * The flow's own input contract: every param declared on its flowInput nodes.
 *
 * Same `ParamSpec[]` shape a book uses, so the trigger dialog renders a flow's
 * parameters with the very same fields it renders a book's. It lives here
 * rather than beside the server's other derivations because the canvas needs it
 * too: the dialog must ask for exactly the parameters the runner will demand,
 * and two implementations of "which parameters" would eventually disagree about
 * a duplicate name or a param on a second entry node.
 */
export function deriveInputSchema(
  graph: FlowGraph,
  resolveSchemaRef?: SchemaRefResolver,
): ParamSpec[] {
  const specs: ParamSpec[] = [];
  const seen = new Set<string>();
  for (const node of graph.nodes) {
    if (node.type !== "flowInput") continue;
    for (const spec of flowInputParams(node.config, resolveSchemaRef)) {
      if (seen.has(spec.name)) continue;
      seen.add(spec.name);
      // Without the canvas handle. This list is the flow's PUBLIC contract —
      // it is stored on the Flow row and is what the trigger dialog renders and
      // a caller reads to learn what the flow takes — while `portId` exists
      // only so that renaming a parameter cannot unhook a wire. Nobody
      // triggering a flow has any business being shown it.
      const { portId: _canvasOnly, ...contract } = spec;
      specs.push(contract);
    }
  }
  return specs;
}

/** Look a `name@version` citation up in the Schema registry. Synchronous on
 *  purpose: the browser already holds the registry it fetched for the canvas,
 *  and the server pre-resolves its refs into a map before calling in. Making
 *  the derivation async to suit one caller would have pushed a `useMemo` in
 *  FlowEditor into state-and-effect for no gain. */
export type SchemaRefResolver = (
  ref: SchemaCitationInput,
) => ParamSchemaFragment | null | undefined;

/** The parameters ONE flowInput node contributes — the single place that
 *  decides what "this node declares" means, so the ports on the canvas, the
 *  flow's stored input contract and the trigger dialog cannot disagree about
 *  it. Inline `params` win; otherwise the cited schema's properties become the
 *  parameters, which is the same `jsonSchemaToParamSpecs` mapping a book's
 *  `paramSchemaRef` already goes through. */
export function flowInputParams(
  config: FlowNode["config"],
  resolveSchemaRef?: SchemaRefResolver,
): ParamSpec[] {
  const { params, schemaRef } = config as FlowInputNodeConfig;
  if (Array.isArray(params) && params.length > 0) return params;
  if (!schemaRef?.name || !resolveSchemaRef) return [];
  const doc = resolveSchemaRef(schemaRef);
  if (!doc) return [];
  // Through `unknown`: a registry document is a full JSON Schema while
  // ParamSchemaFragment is the loose per-field subset, and the two do not
  // overlap enough for a direct assertion.
  //
  // No shape check beyond the null test, deliberately. `jsonSchemaToParamSpecs`
  // reads only `properties` and `required` and treats both as absent when they
  // are, so anything that is not an object-with-properties already yields no
  // parameters. A `typeof doc !== "object"` guard here was removed on
  // 2026-08-29 after mutation testing showed deleting it changed no observable
  // behaviour — a branch no test can distinguish is a branch that reads as
  // protection while providing none.
  return jsonSchemaToParamSpecs(doc as unknown as Parameters<typeof jsonSchemaToParamSpecs>[0]);
}

/** Read a graph out of its stored JSON, tolerating anything that isn't one.
 *  A malformed graph must not take the whole flows page down with it. */
export function parseFlowGraph(json: string | null | undefined): FlowGraph {
  if (!json) return { nodes: [], edges: [] };
  try {
    const parsed = JSON.parse(json) as Partial<FlowGraph>;
    return {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
      ...(parsed.viewport ? { viewport: parsed.viewport } : {}),
    };
  } catch {
    return { nodes: [], edges: [] };
  }
}

/**
 * The four things a node can be, and the order they belong in.
 *
 * Nine buttons in one row is a list, not a menu — nothing about it says which
 * ones you reach for first, or that `逐项处理` and `收集结果` are two halves of
 * the same thing. The grouping is by WHAT THE NODE DOES TO THE RUN, which is
 * also the order a graph is usually built in: where values come in, what
 * actually goes and does something, how control moves between those, and where
 * the answer comes out.
 */
export const FLOW_NODE_GROUPS = [
  {
    id: "io",
    label: "出入口",
    hint: "流程与外界的接口",
    types: ["flowInput", "flowOutput"],
  },
  {
    id: "action",
    label: "执行",
    hint: "会真的去做事 —— 开浏览器、跑进程。同一时刻只允许一个在跑。",
    types: ["book", "script"],
  },
  {
    id: "control",
    label: "控制流",
    hint: "决定哪些节点跑、跑几次",
    types: ["branch", "merge", "map", "collect", "flow"],
  },
  {
    id: "data",
    label: "数据",
    hint: "不产生副作用，只把值换个形状",
    types: ["transform"],
  },
] as const satisfies ReadonlyArray<{ id: string; label: string; hint: string; types: readonly FlowNodeType[] }>;

export type FlowNodeGroupId = (typeof FLOW_NODE_GROUPS)[number]["id"];

/**
 * When to reach for each node — not what it is.
 *
 * "条件分支：按条件选一条路走" tells someone who already knows. The line that
 * helps is the one naming the situation they are in, so these say what you have
 * and what you want, and the ones that only work in pairs say so.
 */
export const FLOW_NODE_TYPE_HINTS: Record<FlowNodeType, string> = {
  flowInput: "流程从外面接收的值，每个参数一个出口",
  flowOutput: "流程最终交出去的值",
  book: "要操作网页时用：打开、点击、填表、抓数据",
  script: "要算一算或调接口时用，代码就地写，跑在沙箱里",
  transform: "字段改名、取子字段、拼成新形状，不跑进程",
  branch: "同一份数据要分情况走不同的路时用",
  merge: "几条分支各跑各的，之后要合回一条时用",
  map: "手上是一个数组，每一项都要跑一遍时用（配「收集结果」）",
  collect: "把「逐项处理」每一项的结果合成一个数组（必须配对）",
  flow: "把另一条流程整个当成一个节点用，出入参就是它的契约",
};
