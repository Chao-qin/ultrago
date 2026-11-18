import { test } from "node:test";
import assert from "node:assert/strict";
import { FLOW_NODE_GROUPS, FLOW_NODE_TYPES, isInstantNode, isWaitingNode, FLOW_NODE_TYPE_HINTS, FLOW_NODE_TYPE_LABELS, connectedInputs, deriveInputSchema, findCycle, flowInputParams, parseFlowGraph, topoOrder, validateGraphShape } from "./flow-types.js";
import type { FlowGraph, FlowNode } from "./flow-types.js";

function node(id: string, type: FlowNode["type"] = "transform"): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, config: {} as never };
}

function graph(nodes: FlowNode[], edges: Array<[string, string]>, kind?: "data" | "order"): FlowGraph {
  return {
    nodes,
    edges: edges.map(([source, target], i) => ({
      id: `e${i}`,
      source,
      sourceHandle: "out",
      target,
      targetHandle: "in",
      ...(kind ? { kind } : {}),
    })),
  };
}

// The node arrays below are deliberately in the OPPOSITE order to the expected
// result. With them listed in the answer's order, a topoOrder that ignored
// edges entirely would still return the right array — the assertion would pass
// for the wrong reason. Mutation testing caught exactly that: dropping order
// edges from the adjacency turned no test red until these were reversed.
test("a linear chain orders upstream before downstream", () => {
  const order = topoOrder(graph([node("c"), node("b"), node("a")], [["a", "b"], ["b", "c"]]));
  assert.deepEqual(order, ["a", "b", "c"]);
});

test("independent branches both appear, and each stays after its own source", () => {
  const order = topoOrder(graph([node("a"), node("b"), node("c"), node("d")], [["a", "b"], ["a", "c"], ["b", "d"], ["c", "d"]]));
  assert.ok(order);
  assert.equal(order![0], "a");
  assert.equal(order![order!.length - 1], "d");
  assert.equal(new Set(order).size, 4);
});

test("order edges constrain sequence exactly like data edges do", () => {
  // "close the window, THEN send the notification" carries no value but is
  // still a promise about sequence. Nodes listed b-then-a so that ignoring the
  // edge produces ["b","a"] and fails loudly.
  const order = topoOrder(graph([node("b"), node("a")], [["a", "b"]], "order"));
  assert.deepEqual(order, ["a", "b"]);
});

test("a cycle has no order, and is reported as the actual loop", () => {
  const g = graph([node("a"), node("b"), node("c")], [["a", "b"], ["b", "c"], ["c", "a"]]);
  assert.equal(topoOrder(g), null);
  const cycle = findCycle(g);
  assert.ok(cycle);
  // Named, not merely detected: the message has to point somewhere.
  assert.deepEqual([...new Set(cycle!)].sort(), ["a", "b", "c"]);
  assert.equal(cycle![0], cycle![cycle!.length - 1], "the reported path closes on itself");
});

test("a cycle off to one side does not hide the acyclic rest", () => {
  const g = graph([node("a"), node("b"), node("c"), node("d")], [["a", "b"], ["c", "d"], ["d", "c"]]);
  assert.equal(topoOrder(g), null);
  assert.deepEqual([...new Set(findCycle(g)!)].sort(), ["c", "d"]);
});

test("an empty graph is acyclic and ordered", () => {
  assert.deepEqual(topoOrder({ nodes: [], edges: [] }), []);
  assert.equal(findCycle({ nodes: [], edges: [] }), null);
});

test("shape validation refuses duplicate ids, dangling edges and self-loops", () => {
  const problems = validateGraphShape({
    nodes: [node("a"), node("a"), node("b")],
    edges: [
      { id: "e1", source: "a", sourceHandle: "o", target: "ghost", targetHandle: "i" },
      { id: "e2", source: "b", sourceHandle: "o", target: "b", targetHandle: "i" },
      { id: "e2", source: "a", sourceHandle: "o", target: "b", targetHandle: "i" },
    ],
  });
  const messages = problems.map((p) => p.message).join(" | ");
  assert.match(messages, /节点 id 重复：a/);
  assert.match(messages, /不存在的终点节点 ghost/);
  assert.match(messages, /不能连向自己/);
  assert.match(messages, /连线 id 重复：e2/);
  assert.ok(problems.every((p) => p.level === "error" || p.level === "warn"));
});

test("a cycle is an error at save time, not a warning", () => {
  const problems = validateGraphShape(graph([node("a"), node("b")], [["a", "b"], ["b", "a"]]));
  const cycleProblem = problems.find((p) => p.message.includes("环"));
  assert.ok(cycleProblem);
  assert.equal(cycleProblem!.level, "error");
});

test("missing entry or exit nodes warn but do not block saving a work in progress", () => {
  const problems = validateGraphShape(graph([node("a", "book")], []));
  assert.equal(problems.filter((p) => p.level === "error").length, 0);
  assert.equal(problems.filter((p) => p.level === "warn").length, 2);
});

test("an empty canvas is not nagged about missing entry and exit", () => {
  assert.deepEqual(validateGraphShape({ nodes: [], edges: [] }), []);
});

test("two parameters sharing a name are called out, because nothing else notices any more", () => {
  // This used to be self-punishing: the name WAS the port id, so a duplicate
  // collapsed into one handle in front of the author. With a stable `portId`
  // both ports survive, both read the same value out of `paramsJson`, and
  // `deriveInputSchema` quietly keeps the first — a flow that looks correctly
  // wired and asks for one value twice.
  const entry = (params: Array<{ name: string; portId: string }>): FlowNode =>
    ({ id: "in1", type: "flowInput", position: { x: 0, y: 0 }, config: { params: params.map((p) => ({ ...p, required: false })) } } as never);

  const dupes = validateGraphShape({ nodes: [entry([{ name: "keyword", portId: "p1" }, { name: "keyword", portId: "p2" }])], edges: [] });
  const problem = dupes.find((p) => p.message.includes("参数名重复"));
  assert.ok(problem, "a duplicate must be reported");
  assert.equal(problem!.level, "warn", "it is answerable and does not corrupt anything, so it must not block a save");
  assert.equal(problem!.at, "in1");
  assert.deepEqual(deriveInputSchema({ nodes: [entry([{ name: "keyword", portId: "p1" }, { name: "keyword", portId: "p2" }])], edges: [] }).map((p) => p.name), ["keyword"], "the contract keeps one — which is exactly why the warning has to exist");

  const distinct = validateGraphShape({ nodes: [entry([{ name: "a", portId: "p1" }, { name: "b", portId: "p2" }])], edges: [] });
  assert.equal(distinct.filter((p) => p.message.includes("参数名重复")).length, 0);
});

test("the flow's public contract does not carry the canvas's port handles", () => {
  // `inputSchema` is stored on the Flow row and is what the trigger dialog and
  // any caller read to learn what this flow takes. `portId` is there so a
  // rename cannot unhook a wire — an editor detail, and nothing a caller should
  // be shown or start depending on.
  const entry: FlowNode = {
    id: "in1", type: "flowInput", position: { x: 0, y: 0 },
    config: { params: [{ name: "keyword", portId: "p_aaa", required: true, schema: { type: "string" } }] } as never,
  };
  const contract = deriveInputSchema({ nodes: [entry], edges: [] });
  assert.deepEqual(contract, [{ name: "keyword", required: true, schema: { type: "string" } }]);
  assert.ok(!("portId" in contract[0]), "absent, not merely undefined — this gets JSON.stringify'd onto the row");
});

test("connected inputs count data wires and ignore ordering wires", () => {
  const g: FlowGraph = {
    nodes: [node("a"), node("b")],
    edges: [
      { id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "message", kind: "data" },
      { id: "e2", source: "a", sourceHandle: "out", target: "b", targetHandle: "after", kind: "order" },
    ],
  };
  const connected = connectedInputs(g);
  assert.ok(connected.has("b::message"));
  assert.ok(!connected.has("b::after"), "an order edge supplies no value, so it satisfies no input");
});

// deriveInputSchema decides which fields the trigger dialog asks for AND which
// params the runner demands. The two must be the same list, so these pin the
// cases where "collect the params" could plausibly be written differently.
function entry(id: string, params: Array<{ name: string; required?: boolean }>): FlowNode {
  return { id, type: "flowInput", position: { x: 0, y: 0 }, config: { params } as never };
}

test("flow inputs come from flowInput nodes only, in declaration order", () => {
  const specs = deriveInputSchema({
    nodes: [node("t", "transform"), entry("a", [{ name: "url" }, { name: "depth" }]), node("b", "book")],
    edges: [],
  });
  assert.deepEqual(specs.map((s) => s.name), ["url", "depth"]);
});

test("a name declared on two entry nodes is asked for once, keeping the first", () => {
  // Two entry nodes are legal — someone splits their inputs across cards. The
  // runner takes one value per name, so the dialog must not render two fields
  // that write to the same key and silently let the second win.
  const specs = deriveInputSchema({
    nodes: [entry("a", [{ name: "url", required: true }]), entry("b", [{ name: "url", required: false }, { name: "tag" }])],
    edges: [],
  });
  assert.deepEqual(specs.map((s) => s.name), ["url", "tag"]);
  assert.equal(specs[0].required, true, "the first declaration wins, not the last");
});

test("a flow with no entry node asks for nothing rather than throwing", () => {
  assert.deepEqual(deriveInputSchema({ nodes: [node("b", "book")], edges: [] }), []);
  assert.deepEqual(deriveInputSchema({ nodes: [entry("a", [])], edges: [] }), []);
});

test("a malformed stored graph degrades to empty instead of taking the page down", () => {
  assert.deepEqual(parseFlowGraph("not json"), { nodes: [], edges: [] });
  assert.deepEqual(parseFlowGraph(null), { nodes: [], edges: [] });
  assert.deepEqual(parseFlowGraph('{"nodes":"nope"}'), { nodes: [], edges: [] });
  const good = parseFlowGraph('{"nodes":[{"id":"a"}],"edges":[],"viewport":{"x":1,"y":2,"zoom":3}}');
  assert.equal(good.nodes.length, 1);
  assert.deepEqual(good.viewport, { x: 1, y: 2, zoom: 3 });
});

// ── a flowInput node may cite the registry instead of listing fields ────────
// Until 2026-08-29 only the flowOutput node could do that, so every flow that
// consumed a registered contract retyped its fields by hand. `flowInputParams`
// is the single place that decides what a node declares; the ports, the flow's
// stored input contract and the trigger dialog all read it, so a disagreement
// between them is not expressible.

const CITED = {
  type: "object",
  required: ["keyword"],
  properties: {
    keyword: { type: "string", minLength: 1, description: "搜索词" },
    limit: { type: "number" },
  },
} as never;

const registry = (doc: unknown) => () => doc as never;

function citingEntry(id: string, ref: { name: string; version?: number }): FlowNode {
  return { id, type: "flowInput", position: { x: 0, y: 0 }, config: { params: [], schemaRef: ref } as never };
}

test("a cited contract becomes the node's parameters", () => {
  const specs = deriveInputSchema(
    { nodes: [citingEntry("a", { name: "book-input-baidu-hot-search", version: 1 })], edges: [] },
    registry(CITED),
  );
  assert.deepEqual(specs.map((s) => s.name), ["keyword", "limit"]);
  assert.equal(specs[0].required, true, "the schema's `required` list must survive the conversion");
  assert.equal(specs[1].required, false);
  assert.equal(specs[0].description, "搜索词");
});

test("inline params win over a citation when a graph somehow carries both", () => {
  // The editor keeps the modes exclusive, so this only arises for a graph that
  // was hand-edited or written by an older client. Inline is the safe answer:
  // it is what the author last saw, and it resolves with no registry at all.
  const node: FlowNode = {
    id: "a", type: "flowInput", position: { x: 0, y: 0 },
    config: { params: [{ name: "typed" }], schemaRef: { name: "book-input-baidu-hot-search" } } as never,
  };
  assert.deepEqual(flowInputParams(node.config, registry(CITED)).map((s) => s.name), ["typed"]);
});

test("a citation with no resolver, or one that resolves to nothing, yields no params", () => {
  // Degrade, never throw: the registry can be empty on a fresh database, and a
  // flow whose canvas is mid-edit must still render.
  const node = citingEntry("a", { name: "not-registered" });
  assert.deepEqual(flowInputParams(node.config), [], "no resolver at all");
  assert.deepEqual(flowInputParams(node.config, registry(null)), [], "resolver found nothing");
  assert.deepEqual(flowInputParams(node.config, registry("not an object")), [], "resolver returned junk");
});

test("a citing node and a listing node still de-duplicate against each other", () => {
  // The de-dup in deriveInputSchema has to see BOTH shapes, or the dialog would
  // render two fields writing to one key.
  const specs = deriveInputSchema(
    {
      nodes: [entry("a", [{ name: "keyword", required: true }]), citingEntry("b", { name: "x" })],
      edges: [],
    },
    registry(CITED),
  );
  assert.deepEqual(specs.map((s) => s.name), ["keyword", "limit"]);
  assert.equal(specs[0].required, true, "the inline declaration came first and keeps its own required flag");
});

// ── palette 的分组与说明 ──────────────────────────────────────────────────

test("every node type belongs to exactly one group", () => {
  // A palette that quietly drops a node type is a node type nobody can add,
  // and one listed twice is a menu that lies about how many there are. Both
  // are the kind of thing that survives review and dies in use.
  const grouped = FLOW_NODE_GROUPS.flatMap((g) => g.types);
  assert.deepEqual([...grouped].sort(), [...FLOW_NODE_TYPES].sort());
  assert.equal(new Set(grouped).size, grouped.length, "同一个节点不能出现在两组里");
});

test("every node type has a line saying when to reach for it", () => {
  for (const type of FLOW_NODE_TYPES) {
    const hint = FLOW_NODE_TYPE_HINTS[type];
    assert.ok(hint && hint.length > 0, `${type} 缺少说明`);
    assert.ok(hint.length <= 30, `${type} 的说明 ${hint.length} 字，palette 里放不下`);
    // The label already says what it is. A hint that repeats it is a hint that
    // taught nobody anything — "条件分支：条件分支" is the failure mode.
    assert.notEqual(hint, FLOW_NODE_TYPE_LABELS[type]);
  }
});

test("the two halves of a loop each say they need the other", () => {
  // The single most confusing thing on this canvas: a map without a collect
  // validates and then hangs, and nothing on the palette said they came as a
  // pair. Now both lines do.
  assert.match(FLOW_NODE_TYPE_HINTS.map, /收集结果/);
  assert.match(FLOW_NODE_TYPE_HINTS.collect, /逐项处理|配对/);
});

test("the acting node types are the ones the group says are acting", () => {
  // The group's own hint promises "同一时刻只允许一个在跑", which is a claim
  // about which nodes the scheduler treats as acting. If the two ever disagree
  // the hint becomes a lie about scheduling — the sort nobody re-reads.
  //
  // Derived the way the scheduler derives it, not copied: a second literal list
  // would be the thing that drifts. It caught the drift the moment `flow` was
  // added — a subflow is not instant, so the old two-way split put it in the
  // acting group, and the group's hint promises "同一时刻只允许一个在跑", which
  // for a subflow would be the deadlock `WAITING_NODE_TYPES` exists to avoid.
  const acting = FLOW_NODE_GROUPS.find((g) => g.id === "action")!.types;
  assert.deepEqual(
    [...acting].sort(),
    FLOW_NODE_TYPES.filter((t) => !isInstantNode(t) && !isWaitingNode(t)).sort(),
  );
});

test("a node type is instant, waiting or acting — exactly one of the three", () => {
  // The three are what the scheduler branches on, and the branch that matters
  // is the budget: one acting node at a time because there is one browser.
  // A type in two categories, or in none, makes that budget mean something
  // different depending on which check runs first.
  for (const type of FLOW_NODE_TYPES) {
    const memberships = [isInstantNode(type), isWaitingNode(type)].filter(Boolean).length;
    assert.ok(memberships <= 1, `${type} 同时属于 instant 和 waiting`);
  }
  // And the one that would deadlock: a subflow holds the only slot while
  // waiting for a child that needs it.
  assert.equal(isWaitingNode("flow"), true);
  assert.equal(isInstantNode("flow"), false, "子流程不是瞬时的 —— 它要等子 run 跑完");
});
