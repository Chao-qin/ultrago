/**
 * The decisions a flow run makes, separated from the I/O that carries them out.
 *
 * Everything here is a pure function of (graph, node states, upstream values),
 * so the ordering rules, the dispatch rule and the tiny expression grammar can be
 * tested without a database, a browser or a subprocess. The service next door
 * does the enqueueing and spawning and holds no logic of its own worth testing.
 */
import {
  BRANCH_CHOSE_NOTHING,
  readPath,
  isInstantNode,
  portOutputKey,
  type MergeNodeConfig,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
} from "@bcp/shared";
export { readPath, matchesCase, selectBranch, BRANCH_CHOSE_NOTHING } from '@bcp/shared';

export type NodeStatus = "pending" | "ready" | "running" | "success" | "failed" | "skipped";

const TEMPLATE = /\{\{([^}]+)\}\}/g;

/**
 * Evaluate one transform output.
 *
 * Three forms and no more: a `$`-path into the node's input, a `{{token}}`
 * template that interpolates such paths into a string, or a literal. There is
 * no expression language and there will not be one — a book once took
 * caller-written JavaScript as a parameter and a plain greeting became
 * `你好 is not defined`. Anything needing a conditional or a loop belongs in a
 * script endpoint, which has a file, a version and tests.
 */
export function evalExpr(expr: string, input: unknown): unknown {
  const trimmed = expr.trim();
  if (trimmed.startsWith("$")) return readPath(input, trimmed);
  if (TEMPLATE.test(trimmed)) {
    TEMPLATE.lastIndex = 0;
    return trimmed.replace(TEMPLATE, (_, token: string) => {
      const value = readPath(input, token.trim().startsWith("$") ? token.trim() : `$.${token.trim()}`);
      return value == null ? "" : String(value);
    });
  }
  return trimmed;
}

/**
 * Which port each finished branch took, read back out of what it stored.
 *
 * A branch's product is `{ [chosenPort]: value }` — one key, or none when
 * nothing matched — so the choice does not need a column of its own and
 * survives a restart for free, like every other piece of this state machine.
 * The empty-string sentinel is what "finished and chose nothing" looks like,
 * which `edgeIsDead` needs to tell apart from "not a branch".
 */
export function branchChoicesOf(graph: FlowGraph, outputs: Map<string, Record<string, unknown>>): BranchChoices {
  const choices: BranchChoices = new Map();
  for (const node of graph.nodes) {
    if (node.type !== "branch") continue;
    const product = outputs.get(node.id);
    if (!product) continue;
    choices.set(node.id, Object.keys(product)[0] ?? BRANCH_CHOSE_NOTHING);
  }
  return choices;
}

/**
 * What a merge passes on: the first of its inputs that actually carries a
 * value, in declared order.
 *
 * "First" rather than "combine" because of where a merge sits — after a branch,
 * exactly one path ran, and the join's job is to forget which. A merge whose
 * every input is dead never runs at all: `skippedNodeIds` settles it as skipped
 * before it can be dispatched, so "nothing arrived" is not a case this has to
 * invent an answer for.
 */
export function mergeValue(config: MergeNodeConfig, inputs: Record<string, unknown>): unknown {
  const ports = config.inputs?.length ? config.inputs : [{ id: "a" }, { id: "b" }];
  for (const port of ports) {
    const value = inputs[port.id];
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * A map's loop state, kept in the map row's own product rather than in columns
 * of its own.
 *
 * Same bargain a branch makes with its chosen port: the state machine already
 * lives in the database, so anything written here survives a restart for free
 * and a past run stays explicable from what it stored. The key is `$`-prefixed
 * so it can never collide with a port id — every port id is either minted or a
 * fixed identifier, and neither form starts with `$`.
 */
export const MAP_STATE_KEY = "$map";

export interface MapState {
  /** The array as it was when the map started. Snapshotted on purpose: the
   *  upstream that produced it may be re-read on a later tick, and an iteration
   *  whose length changed underneath it is not a loop anyone can reason about. */
  items: unknown[];
  /** Which element the body is working on right now. */
  index: number;
  /** One entry per finished item, in order. Shorter than `index` exactly when
   *  items have been skipped past (a tolerated failure). */
  results: unknown[];
  /** Indices whose body failed while `onFail: "continue"` let the loop go on.
   *  Kept so the run can say "17 of 20" instead of quietly returning 17. */
  failed: number[];
}

export function initialMapState(items: unknown[]): MapState {
  return { items, index: 0, results: [], failed: [] };
}

export function currentMapItem(state: MapState): unknown {
  return state.items[state.index];
}

export function mapIsDone(state: MapState): boolean {
  return state.index >= state.items.length;
}

/** The state after this iteration settled. A failure is recorded rather than
 *  dropped: whether it ENDS the map is the caller's decision (it reads the
 *  node's `onFail`), but either way the index moves so a caller that continues
 *  cannot loop forever on the same item. */
export function afterMapIteration(state: MapState, outcome: { failed: boolean; value: unknown }): MapState {
  return {
    items: state.items,
    index: state.index + 1,
    results: outcome.failed ? state.results : [...state.results, outcome.value],
    failed: outcome.failed ? [...state.failed, state.index] : state.failed,
  };
}

/** Read a map's state back out of what its row stored. Returns null for a row
 *  that has not started iterating, which is how the controller tells "begin"
 *  from "continue" without a second column. */
export function readMapState(product: Record<string, unknown> | undefined): MapState | null {
  const raw = product?.[MAP_STATE_KEY];
  if (!raw || typeof raw !== "object") return null;
  const state = raw as Partial<MapState>;
  if (!Array.isArray(state.items) || typeof state.index !== "number") return null;
  return {
    items: state.items,
    index: state.index,
    results: Array.isArray(state.results) ? state.results : [],
    failed: Array.isArray(state.failed) ? state.failed.filter((n): n is number => typeof n === "number") : [],
  };
}

/**
 * Which nodes belong to a map's body, and where that body hands its results
 * back.
 *
 * The body is the intersection of "reachable FROM the map" and "reaches the
 * collect" — everything on a path between the two. Nodes hanging off the map
 * that never reach a collect are NOT body: they would run once per item with
 * nowhere to put the result, which is the silent-drop this pairing exists to
 * prevent, so they are reported instead.
 *
 * Returns `collectId: null` when the map has no collect downstream at all,
 * which the save-time check turns into an error rather than a runtime surprise.
 */
export function mapScope(
  graph: FlowGraph,
  mapId: string,
): { collectId: string | null; collects: string[]; body: Set<string>; dangling: Set<string> } {
  const forward = reachable(graph, mapId, "forward");
  // ALL of them, not just the one used. A map that can reach two collects is
  // ambiguous, and picking the first quietly is how the other one ended up
  // being told "no map leads to you" — a sentence that was simply false.
  const collects = [...forward].filter((id) => graph.nodes.find((n) => n.id === id)?.type === "collect");
  if (collects.length === 0) return { collectId: null, collects, body: new Set(), dangling: forward };
  const collectId = collects[0];
  const backward = reachable(graph, collectId, "backward");
  const body = new Set([...forward].filter((id) => backward.has(id) && id !== collectId));
  // Everything past the collect is the map's RESULT being consumed — ordinary
  // downstream, not a dangling branch. Leaving it in would have flagged the
  // most normal shape a map has (`collect → 汇总 → 出参`) as a problem.
  const afterCollect = reachable(graph, collectId, "forward");
  const dangling = new Set(
    [...forward].filter((id) => !body.has(id) && id !== collectId && !afterCollect.has(id)),
  );
  return { collectId, collects, body, dangling };
}

function reachable(graph: FlowGraph, from: string, direction: "forward" | "backward"): Set<string> {
  const seen = new Set<string>();
  const queue = [from];
  while (queue.length > 0) {
    const id = queue.shift()!;
    for (const edge of graph.edges) {
      const [tail, head] = direction === "forward" ? [edge.source, edge.target] : [edge.target, edge.source];
      if (tail !== id || seen.has(head) || head === from) continue;
      seen.add(head);
      queue.push(head);
    }
  }
  return seen;
}

/** Every body node, keyed to the map that owns it. Built once per tick so the
 *  row filter and the dispatch skip-list read the same answer. */
export function mapOwners(graph: FlowGraph): Map<string, string> {
  const owners = new Map<string, string>();
  for (const node of graph.nodes) {
    if (node.type !== "map") continue;
    for (const id of mapScope(graph, node.id).body) owners.set(id, node.id);
  }
  return owners;
}

/** Nodes whose author said a failure here is not the end of the run. Read off
 *  the graph rather than tracked, because it is a property of the DESIGN, not
 *  of this particular run. */
export function toleratedFailures(graph: FlowGraph): Set<string> {
  return new Set(graph.nodes.filter((n) => n.onFail === "continue").map((n) => n.id));
}

/** A node's resolved inputs: wired values first, constants for whatever is
 *  left. A wire wins over a constant on the same port — the constant is the
 *  fallback you typed before connecting anything. */
export function resolveInputs(
  node: FlowNode,
  graph: FlowGraph,
  outputs: Map<string, Record<string, unknown>>,
): Record<string, unknown> {
  const constants = (node.config as { constants?: Record<string, unknown> }).constants ?? {};
  const resolved: Record<string, unknown> = { ...constants };
  for (const edge of graph.edges) {
    if (edge.target !== node.id || edge.kind === "order") continue;
    const upstream = outputs.get(edge.source);
    if (!upstream) continue;
    // The handle is the port's stable id; the value sits under the port's NAME,
    // which its author is free to change. The two are the same string for every
    // port nobody can rename, so this is the identity function almost
    // everywhere — see `portOutputKey`, which is the only place they meet.
    const value = upstream[portOutputKey(graph.nodes.find((n) => n.id === edge.source), edge.sourceHandle)];
    resolved[edge.targetHandle] = edge.srcPath ? readPath(value, edge.srcPath) : value;
  }
  return resolved;
}

/**
 * Which nodes may run now: still pending, and every upstream finished.
 *
 * Both edge kinds gate: a data edge because the value isn't there yet, an
 * order edge because the author said "after that one". A skipped upstream
 * counts as finished — a branch that didn't happen must not wedge the graph.
 */
export function readyNodeIds(graph: FlowGraph, statuses: Map<string, NodeStatus>): string[] {
  const ready: string[] = [];
  for (const node of graph.nodes) {
    if (statuses.get(node.id) !== "pending") continue;
    const upstreams = graph.edges.filter((e) => e.target === node.id);
    const blocked = upstreams.some((e) => {
      const status = statuses.get(e.source);
      return status !== "success" && status !== "skipped";
    });
    if (!blocked) ready.push(node.id);
  }
  return ready;
}

/** Which output port each branch node picked, by node id. Empty for a graph
 *  with no branches, which is why every reader treats "absent" as "this node
 *  does not choose" rather than as "nothing was chosen". */
export type BranchChoices = Map<string, string>;

/**
 * Whether a value will never arrive along this edge.
 *
 * Three ways: the source failed, the source was skipped, or the source is a
 * branch that chose a different port. Anything still pending or running is NOT
 * dead — it just has not happened yet, and treating "not yet" as "never" would
 * skip half a graph on the first tick.
 */
export function edgeIsDead(edge: FlowEdge, statuses: Map<string, NodeStatus>, choices: BranchChoices): boolean {
  const status = statuses.get(edge.source);
  if (status === "failed" || status === "skipped") return true;
  if (status !== "success") return false;
  const chosen = choices.get(edge.source);
  return chosen !== undefined && chosen !== edge.sourceHandle;
}

/**
 * Nodes that can never run, so they settle as `skipped` instead of sitting
 * pending forever.
 *
 * This USED to be the transitive closure of everything downstream of a failure,
 * which was right only while a graph was a chain. The moment two paths rejoin
 * it is wrong in the expensive direction: the join node has a live input on one
 * side and got skipped anyway, taking the whole rest of the flow with it. A
 * branch would have been unusable on its first real use.
 *
 * The rule instead is per-node and per-EDGE:
 *   - any incoming edge from a FAILED node → skip, because `readyNodeIds`
 *     requires every upstream to be success-or-skipped and a failure can never
 *     become either. Left alone it is not a survivor, it is a deadlock.
 *   - otherwise, skip only when EVERY incoming edge is dead — no live path can
 *     still deliver a value.
 *
 * A node with no incoming edges is never skipped: it is a source, and nothing
 * upstream can have gone wrong.
 *
 * Iterated to a fixpoint because skipping one node can be what makes the next
 * one's last live edge dead.
 */
export function skippedNodeIds(
  graph: FlowGraph,
  statuses: Map<string, NodeStatus>,
  choices: BranchChoices = new Map(),
): string[] {
  const effective = new Map(statuses);
  const skipped = new Set<string>();
  for (;;) {
    let changed = false;
    for (const node of graph.nodes) {
      if (effective.get(node.id) !== "pending") continue;
      const incoming = graph.edges.filter((e) => e.target === node.id);
      if (incoming.length === 0) continue;
      const doomed =
        incoming.some((e) => effective.get(e.source) === "failed") ||
        incoming.every((e) => edgeIsDead(e, effective, choices));
      if (!doomed) continue;
      effective.set(node.id, "skipped");
      skipped.add(node.id);
      changed = true;
    }
    if (!changed) return [...skipped];
  }
}

/**
 * Which ready nodes actually start this tick.
 *
 * A flow run is strictly serial: at most one node that DOES something — drives
 * a browser, spawns a process — runs at a time. This is not a limitation
 * pending removal, it is what the only shared resource allows. Chrome stops
 * rendering a window that is minimised or fully occluded, so two book nodes at
 * once is precisely how a repeatable run becomes an intermittent one.
 *
 * Instant nodes are exempt: mapping a value or reading the flow's parameters is
 * synchronous work over data already in hand. Making those queue would spend a
 * tick each on a chain of transforms and buy nothing.
 *
 * An earlier version of this had a per-node parallel/serial switch backed by
 * capacity-limited resource slots. It was removed because it could not do
 * anything: books queued regardless, instant nodes never waited, and the only
 * genuinely parallelisable case — several scripts — does not arise in a
 * pipeline whose steps feed each other.
 */
export function planDispatch(candidates: FlowNode[], somethingRunning: boolean): string[] {
  const starting: string[] = [];
  let busy = somethingRunning;
  for (const node of candidates) {
    if (isInstantNode(node.type)) {
      starting.push(node.id);
      continue;
    }
    if (busy) continue;
    busy = true;
    starting.push(node.id);
  }
  return starting;
}

/**
 * The run's verdict once no node can move.
 *
 * `tolerated` holds the nodes whose author marked them `onFail: "continue"` —
 * their failure is a branch of the design, not the end of the run, so it stops
 * the paths that depended on them (see `skippedNodeIds`) and leaves the rest
 * alone. Without it a "continue" node was a field the graph declared and the
 * runner ignored, which is the same as not having it.
 *
 * A run in which EVERY node is either fine or a tolerated failure succeeds. A
 * single untolerated failure fails it, but only once nothing is still moving —
 * an early failure must not cut short branches that are still going.
 */
export function runVerdict(
  statuses: Map<string, NodeStatus>,
  tolerated: ReadonlySet<string> = new Set(),
): "running" | "success" | "failed" {
  const entries = [...statuses.entries()];
  const moving = entries.some(([, s]) => s === "running" || s === "ready" || s === "pending");
  const fatal = entries.some(([id, s]) => s === "failed" && !tolerated.has(id));
  if (fatal) return moving ? "running" : "failed";
  if (entries.every(([id, s]) => s === "success" || s === "skipped" || (s === "failed" && tolerated.has(id)))) {
    return "success";
  }
  return "running";
}
