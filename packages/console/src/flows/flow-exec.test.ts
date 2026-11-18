import { test } from "node:test";
import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { BRANCH_OTHERWISE_PORT, type BranchCase, type BranchNodeConfig, type FlowGraph, type FlowNode, type MergeNodeConfig } from "@bcp/shared";
import { matchesCase as sharedMatchesCase, readPath as sharedReadPath, selectBranch as sharedSelectBranch } from '@bcp/shared';
import {
  MAP_STATE_KEY,
  afterMapIteration,
  branchChoicesOf,
  currentMapItem,
  initialMapState,
  mapIsDone,
  mapOwners,
  mapScope,
  readMapState,
  evalExpr,
  matchesCase,
  mergeValue,
  planDispatch,
  readPath,
  readyNodeIds,
  resolveInputs,
  runVerdict,
  BRANCH_CHOSE_NOTHING,
  selectBranch,
  skippedNodeIds,
  toleratedFailures,
  type NodeStatus,
} from "./flow-exec.js";

function node(id: string, type: FlowNode["type"] = "transform", extra: Partial<FlowNode> = {}): FlowNode {
  return { id, type, position: { x: 0, y: 0 }, config: {} as never, ...extra };
}

test('backend branch exports are the same shared evaluator functions', () => {
  assert.equal(matchesCase, sharedMatchesCase);
  assert.equal(readPath, sharedReadPath);
  assert.equal(selectBranch, sharedSelectBranch);
});

function graphOf(nodes: FlowNode[], edges: Array<[string, string, ("data" | "order")?]> = []): FlowGraph {
  return {
    nodes,
    edges: edges.map(([source, target, kind], i) => ({
      id: `e${i}`,
      source,
      sourceHandle: "out",
      target,
      targetHandle: "in",
      ...(kind ? { kind } : {}),
    })),
  };
}

// ── the restricted path grammar ──────────────────────────────────────────

test("readPath walks keys and indexes, and gives up quietly", () => {
  const value = { data: { items: [{ url: "a" }, { url: "b" }] } };
  assert.equal(readPath(value, "$.data.items[1].url"), "b");
  assert.deepEqual(readPath(value, "$.data"), value.data);
  assert.equal(readPath(value, "$.missing.deeper"), undefined);
  assert.equal(readPath(null, "$.a"), undefined);
  assert.deepEqual(readPath(value, "$"), value);
});

test("evalExpr handles paths, templates and literals — and nothing else", () => {
  const input = { name: "报告", n: 3 };
  assert.equal(evalExpr("$.name", input), "报告");
  assert.equal(evalExpr("{{name}}-{{n}}.md", input), "报告-3.md");
  assert.equal(evalExpr("{{$.name}}.md", input), "报告.md");
  assert.equal(evalExpr("literal text", input), "literal text");
  // A missing token becomes empty rather than the string "undefined".
  assert.equal(evalExpr("{{nope}}.md", input), ".md");
  // Emphatically NOT an expression language: this is a literal, not code.
  assert.equal(evalExpr("1 + 1", input), "1 + 1");
});

// ── input resolution ─────────────────────────────────────────────────────

test("a wire supplies a port, and overrides a constant left on it", () => {
  const target = node("b");
  (target as { config: unknown }).config = { constants: { in: "typed earlier", other: "kept" } };
  const graph = graphOf([node("a"), target], [["a", "b"]]);
  const inputs = resolveInputs(target, graph, new Map([["a", { out: "from upstream" }]]));
  assert.equal(inputs.in, "from upstream");
  assert.equal(inputs.other, "kept");
});

test("srcPath narrows what a wire carries", () => {
  const graph: FlowGraph = {
    nodes: [node("a"), node("b")],
    edges: [{ id: "e", source: "a", sourceHandle: "out", target: "b", targetHandle: "url", srcPath: "$.items[0].url" }],
  };
  const inputs = resolveInputs(graph.nodes[1], graph, new Map([["a", { out: { items: [{ url: "u1" }] } }]]));
  assert.equal(inputs.url, "u1");
});

test("an order edge carries no value", () => {
  const graph = graphOf([node("a"), node("b")], [["a", "b", "order"]]);
  const inputs = resolveInputs(graph.nodes[1], graph, new Map([["a", { out: "value" }]]));
  assert.deepEqual(inputs, {});
});

// ── the handle and the key are two strings ───────────────────────────────

/**
 * A wire remembers a port's STABLE id; the value sits under the port's NAME.
 * They part ways for exactly the two node types whose port names an author
 * types by hand, and this is the seam where they meet again — so a mistake here
 * does not fail, it delivers the wrong value, or `undefined`, quietly.
 *
 * They were one string until 2026-08-29, which is why renaming a parameter used
 * to unhook every wire on it.
 */
const wired = (source: string, sourceHandle: string, target: FlowNode): FlowGraph => ({
  nodes: [node(source, "flowInput"), target],
  edges: [{ id: "e", source, sourceHandle, target: target.id, targetHandle: "in" }],
});

test("a flowInput's value is found under the parameter's name, not under the wire's handle", () => {
  const graph = wired("a", "p_stable", node("b"));
  (graph.nodes[0] as { config: unknown }).config = { params: [{ name: "关键词", portId: "p_stable", required: false }] };
  // The node's product IS `paramsJson`, keyed the way the trigger dialog asked.
  const inputs = resolveInputs(graph.nodes[1], graph, new Map([["a", { 关键词: "连衣裙" }]]));
  assert.equal(inputs.in, "连衣裙");
});

test("renaming that parameter changes the key and not the wire, and the value still arrives", () => {
  const graph = wired("a", "p_stable", node("b"));
  (graph.nodes[0] as { config: unknown }).config = { params: [{ name: "keyword", portId: "p_stable", required: false }] };
  assert.equal(resolveInputs(graph.nodes[1], graph, new Map([["a", { keyword: "v" }]])).in, "v");
});

test("a parameter with no portId is its own handle, so graphs written before this still resolve", () => {
  const graph = wired("a", "keyword", node("b"));
  (graph.nodes[0] as { config: unknown }).config = { params: [{ name: "keyword", required: false }] };
  assert.equal(resolveInputs(graph.nodes[1], graph, new Map([["a", { keyword: "v" }]])).in, "v");
});

test("a transform's field is read under its label, falling back to the id that used to be its name", () => {
  for (const [what, output, product] of [
    ["renamed", { id: "o_stable", label: "url", expr: "$" }, { url: "u" }],
    ["never renamed", { id: "url", expr: "$" }, { url: "u" }],
  ] as const) {
    const graph: FlowGraph = {
      nodes: [node("a", "transform", { config: { outputs: [output] } as never }), node("b")],
      edges: [{ id: "e", source: "a", sourceHandle: output.id, target: "b", targetHandle: "in" }],
    };
    assert.equal(resolveInputs(graph.nodes[1], graph, new Map([["a", product]])).in, "u", what);
  }
});

test("a port nobody can rename is untouched by the translation", () => {
  // Books, scripts and the output node: handle and key are the same string, and
  // the lookup must not invent a difference. A flowInput node that cites the
  // registry is in the same position — its fields come from a schema, so they
  // have no portId and no way to be renamed from the canvas.
  const graph = graphOf([node("a", "book"), node("b")], [["a", "b"]]);
  assert.equal(resolveInputs(graph.nodes[1], graph, new Map([["a", { out: "v" }]])).in, "v");

  const citing = wired("a", "keyword", node("b"));
  (citing.nodes[0] as { config: unknown }).config = { params: [], schemaRef: { name: "book-input-x" } };
  assert.equal(resolveInputs(citing.nodes[1], citing, new Map([["a", { keyword: "v" }]])).in, "v");
});

// ── readiness ────────────────────────────────────────────────────────────

test("a node is ready only once every upstream has finished", () => {
  const graph = graphOf([node("a"), node("b"), node("c")], [["a", "c"], ["b", "c"]]);
  const statuses = new Map<string, NodeStatus>([["a", "success"], ["b", "running"], ["c", "pending"]]);
  assert.deepEqual(readyNodeIds(graph, statuses), []);
  statuses.set("b", "success");
  assert.deepEqual(readyNodeIds(graph, statuses), ["c"]);
});

test("order edges gate readiness exactly as data edges do", () => {
  const graph = graphOf([node("a"), node("b")], [["a", "b", "order"]]);
  const statuses = new Map<string, NodeStatus>([["a", "running"], ["b", "pending"]]);
  assert.deepEqual(readyNodeIds(graph, statuses), []);
  statuses.set("a", "success");
  assert.deepEqual(readyNodeIds(graph, statuses), ["b"]);
});

test("a skipped upstream counts as finished, so a dead branch cannot wedge the graph", () => {
  const graph = graphOf([node("a"), node("b")], [["a", "b"]]);
  const statuses = new Map<string, NodeStatus>([["a", "skipped"], ["b", "pending"]]);
  assert.deepEqual(readyNodeIds(graph, statuses), ["b"]);
});

test("a failure skips what depended on it — but not a join that still has a live path", () => {
  // `c` has two upstreams. The old rule was the transitive closure of
  // everything downstream of the failure, so failing `a` also killed `c` and
  // with it the whole rest of the flow — the exact reason a branch could not be
  // drawn before this changed.
  const graph = graphOf([node("a"), node("b"), node("c"), node("d")], [["a", "b"], ["b", "c"], ["d", "c"]]);
  const statuses = new Map<string, NodeStatus>([["a", "failed"], ["b", "pending"], ["c", "pending"], ["d", "pending"]]);
  assert.deepEqual(skippedNodeIds(graph, statuses), ["b"], "只有真正依赖失败节点的那个被跳过");
});

test("a join whose every path died is skipped too, and transitively", () => {
  const graph = graphOf([node("a"), node("b"), node("c")], [["a", "b"], ["b", "c"]]);
  const statuses = new Map<string, NodeStatus>([["a", "failed"], ["b", "pending"], ["c", "pending"]]);
  // b 因上游失败被跳过,c 的唯一入边随之变死 —— 需要迭代到不动点才看得出来。
  assert.deepEqual(skippedNodeIds(graph, statuses).sort(), ["b", "c"]);
});

test("a source node is never skipped, and neither is anything still pending upstream", () => {
  const graph = graphOf([node("a"), node("b")], [["a", "b"]]);
  assert.deepEqual(skippedNodeIds(graph, new Map<string, NodeStatus>([["a", "pending"], ["b", "pending"]])), []);
});

// ── dispatch: strictly serial, instant nodes exempt ─────────────────────

test("only one acting node starts at a time", () => {
  // The single shared resource is a real browser, and Chrome stops rendering an
  // occluded window — two book nodes at once is how a repeatable run becomes an
  // intermittent one.
  const books = [node("b1", "book"), node("b2", "book")];
  assert.deepEqual(planDispatch(books, false), ["b1"]);
});

test("nothing acting starts while something is already running", () => {
  assert.deepEqual(planDispatch([node("b1", "book"), node("s1", "script")], true), []);
});

test("instant nodes never queue, even behind a running book", () => {
  // Mapping a value is synchronous work over data already in hand; making it
  // wait would spend a tick per transform and buy nothing.
  const instant = [node("t1", "transform"), node("t2", "transform"), node("o1", "flowOutput"), node("i1", "flowInput")];
  assert.deepEqual(planDispatch(instant, true), ["t1", "t2", "o1", "i1"]);
});

test("instant nodes do not consume the single acting slot", () => {
  const mixed = [node("t1", "transform"), node("b1", "book"), node("t2", "transform"), node("s1", "script")];
  // t1 and t2 pass through; b1 takes the slot; s1 must wait its turn.
  assert.deepEqual(planDispatch(mixed, false), ["t1", "b1", "t2"]);
});

test("a script and a book contend for the same single slot", () => {
  assert.deepEqual(planDispatch([node("s1", "script"), node("b1", "book")], false), ["s1"]);
});

// ── the run's verdict ────────────────────────────────────────────────────

test("a run is done only when nothing is left to move", () => {
  const running = new Map<string, NodeStatus>([["a", "success"], ["b", "running"]]);
  assert.equal(runVerdict(running), "running");
  assert.equal(runVerdict(new Map([["a", "success"], ["b", "success"]])), "success");
  assert.equal(runVerdict(new Map([["a", "success"], ["b", "skipped"]])), "success");
  assert.equal(runVerdict(new Map([["a", "failed"], ["b", "skipped"]])), "failed");
});

test("a failure does not end the run while other branches are still going", () => {
  // Cutting the run short here would abandon work that is already in flight,
  // including a browser tab someone would then have to close by hand.
  assert.equal(runVerdict(new Map([["a", "failed"], ["b", "running"]])), "running");
});

// ── script cwd containment ───────────────────────────────────────────────

test("a script's working directory cannot leave the repo", async () => {
  const { resolveInsideRepo } = await import("./flow-runner.service.js");
  const root = resolveInsideRepo(undefined);
  await access(join(root, "pnpm-workspace.yaml"));
  assert.ok(resolveInsideRepo(".claude/skills/product-preprocess").startsWith(root));

  // Refused, not normalised: a node able to pick any directory on the machine
  // is a different feature than the one that was asked for.
  assert.throws(() => resolveInsideRepo("/etc"), /绝对路径/);
  assert.throws(() => resolveInsideRepo("../../../etc"), /逃出了仓库目录/);
  assert.throws(() => resolveInsideRepo("packages/../../outside"), /逃出了仓库目录/);
});

// ── 分支 / 汇合 ────────────────────────────────────────────────────────────

const kase = (id: string, left: string, op: string, right?: string): BranchCase =>
  ({ id, left, op, ...(right === undefined ? {} : { right }) }) as BranchCase;
const branchOf = (cases: BranchCase[], otherwise = false): BranchNodeConfig => ({ cases, otherwise });

test("分支: 第一个命中的 case 赢,顺序就是 if/elif 的顺序", () => {
  const config = branchOf([kase("hot", "$.score", "gte", "90"), kase("warm", "$.score", "gte", "60")]);
  assert.equal(selectBranch(config, { score: 95 }), "hot");
  assert.equal(selectBranch(config, { score: 70 }), "warm", "第一条不中才轮到第二条");
});

test("分支: 都不中且没开 otherwise,就什么都不选 —— 这是合法结局不是错误", () => {
  const config = branchOf([kase("hot", "$.score", "gte", "90")]);
  assert.equal(selectBranch(config, { score: 10 }), "", "空串哨兵:下游全部变死");
  assert.equal(selectBranch(branchOf(config.cases, true), { score: 10 }), "otherwise");
});

test("分支: 右侧来自文本框,所以数字 3 和输入的 \"3\" 必须相等", () => {
  // 不这么做的话,最常见的用法反而是坏的:面板里只能敲字符串。
  assert.equal(matchesCase(kase("c", "$.n", "eq", "3"), { n: 3 }), true);
  assert.equal(matchesCase(kase("c", "$.n", "gt", "10"), { n: 42 }), true, "比较按数字走");
  assert.equal(matchesCase(kase("c", "$.d", "lt", "2026-09-01"), { d: "2026-08-29" }), true, "非数字按字典序,ISO 日期因此可比");
});

test("分支: contains 对数组看成员,对字符串看子串", () => {
  assert.equal(matchesCase(kase("c", "$.tags", "contains", "热销"), { tags: ["热销", "新品"] }), true);
  assert.equal(matchesCase(kase("c", "$.title", "contains", "耳夹"), { title: "kitty 耳夹" }), true);
  assert.equal(matchesCase(kase("c", "$.tags", "notContains", "下架"), { tags: ["热销"] }), true);
});

test("分支: 一元运算符不看右侧", () => {
  assert.equal(matchesCase(kase("c", "$.images", "isEmpty"), { images: [] }), true);
  assert.equal(matchesCase(kase("c", "$.images", "isNotEmpty"), { images: [1] }), true);
  assert.equal(matchesCase(kase("c", "$.ok", "isTrue"), { ok: true }), true);
  assert.equal(matchesCase(kase("c", "$.ok", "isFalse"), { ok: false }), true);
});

test("分支: 没走的那一支,下游必须死掉", () => {
  const graph: FlowGraph = {
    nodes: [node("br", "branch"), node("left"), node("right"), node("join", "merge")],
    edges: [
      { id: "e0", source: "br", sourceHandle: "hot", target: "left", targetHandle: "in" },
      { id: "e1", source: "br", sourceHandle: "cold", target: "right", targetHandle: "in" },
      { id: "e2", source: "left", sourceHandle: "out", target: "join", targetHandle: "a" },
      { id: "e3", source: "right", sourceHandle: "out", target: "join", targetHandle: "b" },
    ],
  };
  const statuses = new Map<string, NodeStatus>([["br", "success"], ["left", "pending"], ["right", "pending"], ["join", "pending"]]);
  // 分支的产物就是 { <选中端口>: 值 },选择因此不用单独一列,重启也还原得回来。
  const choices = branchChoicesOf(graph, new Map([["br", { hot: { score: 99 } }]]));
  assert.equal(choices.get("br"), "hot");

  assert.deepEqual(skippedNodeIds(graph, statuses, choices), ["right"], "没选中的那支被跳过");
  // 关键:汇合点不能跟着一起死 —— 它还有活着的一路。
  assert.equal(skippedNodeIds(graph, statuses, choices).includes("join"), false);
});

test("分支: 一支都没选中时,两支连同汇合点一起跳过", () => {
  const graph: FlowGraph = {
    nodes: [node("br", "branch"), node("left"), node("join", "merge")],
    edges: [
      { id: "e0", source: "br", sourceHandle: "hot", target: "left", targetHandle: "in" },
      { id: "e1", source: "left", sourceHandle: "out", target: "join", targetHandle: "a" },
    ],
  };
  const statuses = new Map<string, NodeStatus>([["br", "success"], ["left", "pending"], ["join", "pending"]]);
  const choices = branchChoicesOf(graph, new Map([["br", {}]]));
  assert.equal(choices.get("br"), "", "空产物 = 什么都没选中");
  assert.deepEqual(skippedNodeIds(graph, statuses, choices).sort(), ["join", "left"]);
});

test("汇合: 按声明顺序取第一个真的有值的入参", () => {
  const config: MergeNodeConfig = { inputs: [{ id: "a" }, { id: "b" }] };
  assert.deepEqual(mergeValue(config, { b: { from: "右路" } }), { from: "右路" }, "左路没走就取右路");
  assert.deepEqual(mergeValue(config, { a: 1, b: 2 }), 1, "都有值时按顺序取第一个");
});

// ── onFail ────────────────────────────────────────────────────────────────

test("onFail: continue 的节点失败不拖垮整条流程", () => {
  const graph = graphOf([node("a", "transform", { onFail: "continue" }), node("b")], [["a", "b"]]);
  assert.deepEqual([...toleratedFailures(graph)], ["a"]);
  const statuses = new Map<string, NodeStatus>([["a", "failed"], ["b", "skipped"]]);
  assert.equal(runVerdict(statuses, toleratedFailures(graph)), "success", "它的下游跳过,别的分支照常收工");
});

test("onFail: 默认的 stop 仍然让整条流程失败", () => {
  const graph = graphOf([node("a"), node("b")], [["a", "b"]]);
  assert.deepEqual([...toleratedFailures(graph)], []);
  assert.equal(runVerdict(new Map<string, NodeStatus>([["a", "failed"], ["b", "skipped"]]), toleratedFailures(graph)), "failed");
});

// ── map / collect ──────────────────────────────────────────────────────────

test("map 状态: 逐项推进,结果按序累积", () => {
  const s0 = initialMapState(["a", "b"]);
  assert.equal(currentMapItem(s0), "a");
  assert.equal(mapIsDone(s0), false);

  const s1 = afterMapIteration(s0, { failed: false, value: "A" });
  assert.equal(currentMapItem(s1), "b");
  assert.deepEqual(s1.results, ["A"]);

  const s2 = afterMapIteration(s1, { failed: false, value: "B" });
  assert.equal(mapIsDone(s2), true);
  assert.deepEqual(s2.results, ["A", "B"]);
});

test("map 状态: 失败的那一项被记下来而不是悄悄丢掉,且下标照样前进", () => {
  // 下标必须前进,否则 onFail:continue 会在同一项上死循环。
  const s = afterMapIteration(initialMapState(["a", "b"]), { failed: true, value: undefined });
  assert.deepEqual(s.failed, [0], "记下是第几项挂的,才能说「17/20」而不是默默返回 17");
  assert.deepEqual(s.results, [], "挂掉的不进结果数组");
  assert.equal(s.index, 1, "下标前进,不会卡在同一项");
});

test("map 状态: 空数组直接就是完成态,产出空数组", () => {
  const s = initialMapState([]);
  assert.equal(mapIsDone(s), true);
  assert.deepEqual(s.results, []);
});

test("map 状态: 存进产物再读回来,重启也还原得回", () => {
  const s = afterMapIteration(initialMapState([1, 2, 3]), { failed: false, value: "x" });
  const stored = JSON.parse(JSON.stringify({ item: 2, [MAP_STATE_KEY]: s }));
  const back = readMapState(stored);
  assert.deepEqual(back, s);
  assert.equal(readMapState({ item: 1 }), null, "没开始迭代的行读出 null —— 这就是「开始」与「继续」的分界");
  assert.equal(readMapState(undefined), null);
});

test("map 作用域: body 是「从 map 出发」与「能到 collect」的交集", () => {
  const graph: FlowGraph = {
    nodes: [node("m", "map"), node("a"), node("b"), node("c", "collect"), node("after")],
    edges: [
      { id: "e0", source: "m", sourceHandle: "item", target: "a", targetHandle: "in" },
      { id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "in" },
      { id: "e2", source: "b", sourceHandle: "out", target: "c", targetHandle: "result" },
      { id: "e3", source: "c", sourceHandle: "results", target: "after", targetHandle: "in" },
    ],
  };
  const scope = mapScope(graph, "m");
  assert.equal(scope.collectId, "c");
  assert.deepEqual([...scope.body].sort(), ["a", "b"], "collect 本身不算 body,collect 下游更不算");
  assert.deepEqual([...scope.dangling], []);
  assert.deepEqual([...mapOwners(graph).entries()].sort(), [["a", "m"], ["b", "m"]]);
});

test("map 作用域: 挂在 map 上却到不了 collect 的分支被单独报出来", () => {
  // 这种节点会每项跑一遍,结果却无处可去 —— 正是 map/collect 成对存在要防的那种
  // 静默丢弃,所以宁可报出来也不当成 body。
  const graph: FlowGraph = {
    nodes: [node("m", "map"), node("a"), node("c", "collect"), node("orphan")],
    edges: [
      { id: "e0", source: "m", sourceHandle: "item", target: "a", targetHandle: "in" },
      { id: "e1", source: "a", sourceHandle: "out", target: "c", targetHandle: "result" },
      { id: "e2", source: "m", sourceHandle: "item", target: "orphan", targetHandle: "in" },
    ],
  };
  const scope = mapScope(graph, "m");
  assert.deepEqual([...scope.body], ["a"]);
  assert.deepEqual([...scope.dangling], ["orphan"]);
});

test("map 作用域: 没有 collect 就没有 body —— 交给保存期报错,而不是运行时才炸", () => {
  const graph: FlowGraph = {
    nodes: [node("m", "map"), node("a")],
    edges: [{ id: "e0", source: "m", sourceHandle: "item", target: "a", targetHandle: "in" }],
  };
  const scope = mapScope(graph, "m");
  assert.equal(scope.collectId, null);
  assert.deepEqual([...scope.body], []);
});

test("a numeric operand compares as a number instead of throwing", () => {
  // `BranchCase.right` is typed as a string and the editor's box produces one,
  // but the value arrives out of `graphJson` — a parsed JSON column that a
  // graph posted to the API fills directly — and `100` is the obvious thing to
  // type next to `大于`. It used to reach `.trim()` and throw, which did not
  // fail the node: it hung the entire run at `running` forever, logging one
  // line every 200ms to a file nobody was watching.
  const config = {
    otherwise: true,
    cases: [{ id: "hi", left: "$", op: "gt", right: 100 as unknown as string }],
  } as BranchNodeConfig;

  assert.equal(selectBranch(config, 150), "hi");
  assert.equal(selectBranch(config, 20), BRANCH_OTHERWISE_PORT);
  // Numerically, not as text — "9" > "100" lexicographically, and getting that
  // wrong is what keeping the number a number avoids.
  assert.equal(selectBranch(config, 9), BRANCH_OTHERWISE_PORT);
});

test("a boolean operand is handled rather than crashing", () => {
  const isTrue = { cases: [{ id: "yes", left: "$", op: "eq", right: true as unknown as string }] } as BranchNodeConfig;
  assert.equal(selectBranch(isTrue, true), "yes");
  assert.equal(selectBranch(isTrue, false), BRANCH_CHOSE_NOTHING);
});
