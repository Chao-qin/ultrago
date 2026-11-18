import { test } from "node:test";
import assert from "node:assert/strict";
import type { FlowGraph, FlowNode, FlowPort } from "./flow-types.js";
import type { ParamSchemaFragment } from "./param-runtime.js";
import { bookOutputPorts, checkOutputConsumption, collectPorts, subflowPorts, flowOutputKey, flowOutputPortId, mapPorts, paramsToInputPorts, portTypeLabel, projectSchema, propagateRouterSchemas, scriptInputPorts, validatePorts, type PortMap } from "./flow-ports.js";

function ports(...list: FlowPort[]): FlowPort[] {
  return list;
}
const inPort = (id: string, required: boolean, schema: ParamSchemaFragment | null = null): FlowPort => ({
  id,
  label: id,
  direction: "in",
  required,
  schema,
});
const outPort = (id: string, schema: ParamSchemaFragment | null = null): FlowPort => ({
  id,
  label: id,
  direction: "out",
  required: false,
  schema,
});

function graphOf(edges: FlowGraph["edges"], nodeIds = ["a", "b"]): FlowGraph {
  return {
    nodes: nodeIds.map((id) => ({ id, type: "transform" as const, position: { x: 0, y: 0 }, config: {} as never })),
    edges,
  };
}

test("two flow outputs sharing a public name is an error, because one product is silently dropped", () => {
  // `deriveOutputSchema` (the declared contract) and `finishRun` (the produced
  // value) both key by `flowOutputKey` unconditionally, so a duplicate does not
  // merge — the second write wins and the first node's product is gone. A
  // duplicate INPUT name stays a warn because it only asks for one value twice
  // and corrupts nothing; this one loses data, so it has to block the save.
  const out = (id: string, label?: string): FlowNode =>
    ({ id, type: "flowOutput", position: { x: 0, y: 0 }, label, config: {} } as unknown as FlowNode);
  const dupNames = (nodes: FlowNode[]) =>
    validatePorts({ nodes, edges: [] }, new Map()).filter((p) => p.message.includes("流程出参名重复"));

  const problems = dupNames([out("o1", "报告"), out("o2", "报告")]);
  assert.equal(problems.length, 1, "a duplicate output name must be reported exactly once");
  assert.equal(problems[0].level, "error", "it drops a product, so it must block the save");
  assert.equal(problems[0].at, "o2", "the later node is the one that overwrites");

  assert.equal(dupNames([out("o1", "报告"), out("o2", "汇总")]).length, 0, "distinct names are fine");

  // Fresh nodes carry no label and fall back to their id, which is already
  // unique — this must not fire on a canvas the author has not renamed yet.
  assert.equal(dupNames([out("o1"), out("o2")]).length, 0, "unlabelled nodes fall back to distinct ids");

  // The label and the id fallback share ONE namespace: renaming a node onto
  // another node's id collides just as surely as onto its label.
  assert.equal(dupNames([out("o1", "o2"), out("o2")]).length, 1, "a label may collide with an id fallback");
});

test("a required input with neither a wire nor a constant is an error", () => {
  const map: PortMap = new Map([["b", ports(inPort("message", true))]]);
  const problems = validatePorts(graphOf([], ["b"]), map);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.match(problems[0].message, /必填入参「message」/);
});

test("a constant satisfies a required input just as a wire does", () => {
  const graph = graphOf([], ["b"]);
  (graph.nodes[0] as { config: unknown }).config = { constants: { message: "你好" } };
  const map: PortMap = new Map([["b", ports(inPort("message", true))]]);
  assert.deepEqual(validatePorts(graph, map), []);
});

test("an optional input needs nothing", () => {
  const map: PortMap = new Map([["b", ports(inPort("optional", false))]]);
  assert.deepEqual(validatePorts(graphOf([], ["b"]), map), []);
});

test("an order edge does not satisfy a required data input", () => {
  // Ordering says "after you", not "here is your value".
  const graph = graphOf([{ id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "message", kind: "order" }]);
  const map: PortMap = new Map([
    ["a", ports(outPort("out"))],
    ["b", ports(inPort("message", true))],
  ]);
  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /必填入参/);
});

test("a wire between incompatible types is an error naming both ends", () => {
  const graph = graphOf([{ id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "count" }]);
  const map: PortMap = new Map([
    ["a", ports(outPort("out", { type: "string" }))],
    ["b", ports(inPort("count", true, { type: "number" }))],
  ]);
  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.match(problems[0].message, /out → count/);
  assert.match(problems[0].message, /类型不兼容/);
});

test("an undeclared upstream contract is a warning, so books without outputSchema stay wireable", () => {
  // Four of the five books in this repo declare no outputSchema. Refusing
  // those wires would ship an unusable canvas.
  const graph = graphOf([{ id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "text" }]);
  const map: PortMap = new Map([
    ["a", ports(outPort("out", null))],
    ["b", ports(inPort("text", true, { type: "string" }))],
  ]);
  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "warn");
});

test("a contract the canvas cannot judge stays `unsupported` rather than collapsing into a warning", () => {
  // One of these lands on every wire into such a contract, so the editor keeps
  // them in their own bucket and reports them as a count. Flattening them to
  // `warn` here is what put the same paragraph on three consecutive lines and
  // buried the one required input that was actually missing.
  const graph = graphOf([{ id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "text" }]);
  const map: PortMap = new Map([
    ["a", ports(outPort("out", { type: "object" }))],
    ["b", ports(inPort("text", true, { type: "object", properties: { x: { $ref: "#/$defs/y" } }, $defs: { y: { type: "string" } } }))],
  ]);
  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "unsupported");
});

test("a wire onto a port that does not exist is an error, not a crash", () => {
  const graph = graphOf([{ id: "e1", source: "a", sourceHandle: "nope", target: "b", targetHandle: "text" }]);
  const map: PortMap = new Map([
    ["a", ports(outPort("out"))],
    ["b", ports(inPort("text", false))],
  ]);
  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /起点端口不存在/);
});

test("a book's params become its input ports, keeping which are required", () => {
  const list = paramsToInputPorts([
    { name: "message", required: true, schema: { type: "string" } },
    { name: "outputFile", required: false },
  ]);
  assert.deepEqual(list.map((p) => [p.id, p.required, p.direction]), [
    ["message", true, "in"],
    ["outputFile", false, "in"],
  ]);
});

test("a field schemaRef is resolved by the injected resolver and retained on its port", () => {
  const ref = { name: "product", version: 1 };
  const ports = paramsToInputPorts(
    [{ name: "product", required: true, schemaRef: ref }],
    (citation) => citation.name === ref.name && citation.version === ref.version ? { type: "object", description: "商品" } : null,
  );
  assert.deepEqual(ports[0].schema, { type: "object", description: "商品" });
  assert.deepEqual(ports[0].schemaRef, ref);
  assert.equal(paramsToInputPorts([{ name: "missing", required: false, schemaRef: ref }], () => null)[0].schema, null);
});

test("every book exposes artifacts alongside data, described in the same dialect", () => {
  const list = bookOutputPorts(null);
  const artifacts = list.find((p) => p.id === "artifacts");
  assert.ok(artifacts, "a book that writes reports/ must be wireable");
  assert.equal(artifacts!.kind, "artifact");
  assert.equal(artifacts!.schema?.type, "array");
  // Rendering hint only — the schema is ordinary JSON Schema so the
  // compatibility check has one dialect, not two.
  assert.equal((artifacts!.schema!.items as ParamSchemaFragment).type, "object");
  assert.equal(list.find((p) => p.id === "outputs")!.schema, null);
});

test("projectSchema walks keys and array items", () => {
  const schema: ParamSchemaFragment = {
    type: "object",
    properties: { data: { type: "object", properties: { items: { type: "array", items: { type: "object", properties: { url: { type: "string" } } } } } } },
  };
  assert.equal(projectSchema(schema, "$.data.items[0].url")?.type, "string");
  assert.equal(projectSchema(schema, "$.data.items[].url")?.type, "string");
  assert.equal(projectSchema(schema, "$.data")?.type, "object");
  assert.deepEqual(projectSchema(schema, "$"), schema);
});

test("an unresolvable path yields unknown rather than an error", () => {
  const schema: ParamSchemaFragment = { type: "object", properties: { a: { type: "string" } } };
  assert.equal(projectSchema(schema, "$.missing.deeper"), null);
  assert.equal(projectSchema(null, "$.a"), null);
});

test("a projection drops `required`, which described the parent's obligations", () => {
  const schema: ParamSchemaFragment = {
    type: "object",
    properties: { child: { type: "object", properties: { a: { type: "string" } }, required: ["a"] } },
  };
  const projected = projectSchema(schema, "$.child");
  assert.ok(projected);
  assert.equal("required" in projected!, false);
  assert.equal(projected!.type, "object");
});

// ── script 入参：契约的字段就是端口 ─────────────────────────────────────────

test("a script's declared fields each become their own input port", () => {
  const declared: ParamSchemaFragment = {
    type: "object",
    properties: { title: { type: "string" }, price: { type: "number" } },
    required: ["title"],
  } as ParamSchemaFragment;

  const list = scriptInputPorts(declared).filter((p) => p.direction === "in");

  // 端口 id 就是字段名,而 resolveInputs 按端口 id 建 key —— 所以进程从 stdin
  // 收到的正是 {title, price},与契约同形。此前只有一个 `input` 端口,收到的是
  // 多包一层的 {"input": {...}},而没有任何地方写着这件事。
  assert.deepEqual(list.map((p) => p.id).sort(), ["price", "title"]);
  assert.equal(list.find((p) => p.id === "title")?.required, true, "required 跟着契约走");
  assert.equal(list.find((p) => p.id === "price")?.required, false);
  assert.deepEqual(list.find((p) => p.id === "price")?.schema, { type: "number" }, "每个端口带自己那一段 schema,连线才判得了型");
});

test("an undeclared script keeps one port, because a node you cannot wire is worse", () => {
  for (const undeclared of [null, { type: "string" } as ParamSchemaFragment, { type: "object" } as ParamSchemaFragment]) {
    const list = scriptInputPorts(undeclared);
    assert.equal(list.length, 1, `${JSON.stringify(undeclared)} 没有可展开的字段`);
    assert.equal(list[0].id, "input");
    assert.equal(list[0].required, true);
  }
});

// ── checkOutputConsumption: 脚本产物的消费提示 ──────────────────────────

test("checkOutputConsumption: unconsumed script output field produces a warn per field", () => {
  // script → consumer reads only `a` via srcPath; `b` 和 `c` 没人接
  const graph: FlowGraph = {
    nodes: [
      { id: "s", type: "script", position: { x: 0, y: 0 }, config: {} },
      { id: "cons", type: "merge", position: { x: 0, y: 0 }, config: { inputs: [{ id: "in" }] } },
    ],
    edges: [
      { id: "e", source: "s", sourceHandle: "output", target: "cons", targetHandle: "in", srcPath: "$.a", kind: "data" },
    ],
  };
  const outputSchema: ParamSchemaFragment = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "number" }, c: { type: "boolean" } },
  };
  const ports: PortMap = new Map([
    ["s", [
      { id: "input", label: "输入", direction: "in", required: false, schema: null },
      { id: "output", label: "输出", direction: "out", required: false, schema: outputSchema },
    ]],
    ["cons", [{ id: "in", label: "in", direction: "in", required: false, schema: null }]],
  ]);
  const problems = checkOutputConsumption(graph, graph.nodes[0], ports);
  const warns = problems.filter((p) => p.level === "warn");
  assert.equal(warns.length, 2, `expected 2 warns, got ${JSON.stringify(warns)}`);
  assert.ok(warns.some((w) => w.message.includes("b")), "b 应该被报");
  assert.ok(warns.some((w) => w.message.includes("c")), "c 应该被报");
  assert.ok(!warns.some((w) => w.message.includes("a")), "a 已被消费,不应被报");
});

test("checkOutputConsumption: fully consumed script output produces no warns", () => {
  const graph: FlowGraph = {
    nodes: [
      { id: "s", type: "script", position: { x: 0, y: 0 }, config: {} },
      { id: "c1", type: "merge", position: { x: 0, y: 0 }, config: { inputs: [{ id: "in" }] } },
      { id: "c2", type: "merge", position: { x: 0, y: 0 }, config: { inputs: [{ id: "in" }] } },
    ],
    edges: [
      { id: "e1", source: "s", sourceHandle: "output", target: "c1", targetHandle: "in", srcPath: "$.a", kind: "data" },
      { id: "e2", source: "s", sourceHandle: "output", target: "c2", targetHandle: "in", srcPath: "$.b", kind: "data" },
    ],
  };
  const outputSchema: ParamSchemaFragment = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
  };
  const ports: PortMap = new Map([
    ["s", [{ id: "output", label: "输出", direction: "out", required: false, schema: outputSchema }]],
    ["c1", [{ id: "in", label: "in", direction: "in", required: false, schema: null }]],
    ["c2", [{ id: "in", label: "in", direction: "in", required: false, schema: null }]],
  ]);
  assert.deepEqual(checkOutputConsumption(graph, graph.nodes[0], ports), []);
});

test("checkOutputConsumption: no outputSchema on script node produces no warns", () => {
  const graph: FlowGraph = {
    nodes: [{ id: "s", type: "script", position: { x: 0, y: 0 }, config: {} }],
    edges: [],
  };
  const ports: PortMap = new Map([
    ["s", [{ id: "output", label: "输出", direction: "out", required: false, schema: null }]],
  ]);
  assert.deepEqual(checkOutputConsumption(graph, graph.nodes[0], ports), []);
});

test("checkOutputConsumption: whole-object wire silences every-field warning", () => {
  // 没有 srcPath → 整对象透传 → 不知道哪一格落地,默认当作全部都被接走
  const graph: FlowGraph = {
    nodes: [
      { id: "s", type: "script", position: { x: 0, y: 0 }, config: {} },
      { id: "c", type: "merge", position: { x: 0, y: 0 }, config: { inputs: [{ id: "in" }] } },
    ],
    edges: [
      { id: "e", source: "s", sourceHandle: "output", target: "c", targetHandle: "in", kind: "data" },
    ],
  };
  const outputSchema: ParamSchemaFragment = {
    type: "object",
    properties: { a: { type: "string" }, b: { type: "string" } },
  };
  const ports: PortMap = new Map([
    ["s", [{ id: "output", label: "输出", direction: "out", required: false, schema: outputSchema }]],
    ["c", [{ id: "in", label: "in", direction: "in", required: false, schema: null }]],
  ]);
  assert.deepEqual(checkOutputConsumption(graph, graph.nodes[0], ports), []);
});

test("two wires onto one input port is an error — the second silently overwrote the first", () => {
  const graph = graphOf(
    [
      { id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "title" },
      { id: "e2", source: "c", sourceHandle: "out", target: "b", targetHandle: "title" },
    ],
    ["a", "c", "b"],
  );
  const map: PortMap = new Map([
    ["a", ports(outPort("out"))],
    ["c", ports(outPort("out"))],
    ["b", ports(inPort("title", true))],
  ]);

  const problems = validatePorts(graph, map);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.equal(problems[0].at, "e2", "指向后到的那条线,它才是把值盖掉的那条");
  assert.match(problems[0].message, /接了 2 条线/);
});

test("an order edge does not count as a second arrival", () => {
  const graph = graphOf(
    [
      { id: "e1", source: "a", sourceHandle: "out", target: "b", targetHandle: "title" },
      { id: "e2", source: "c", sourceHandle: "out", target: "b", targetHandle: "title", kind: "order" },
    ],
    ["a", "c", "b"],
  );
  const map: PortMap = new Map([
    ["a", ports(outPort("out"))],
    ["c", ports(outPort("out"))],
    ["b", ports(inPort("title", true))],
  ]);
  assert.deepEqual(validatePorts(graph, map), [], "order 边不传值,盖不掉任何东西");
});

// ── flowOutput 的两个字符串 ────────────────────────────────────────────────

test("a flowOutput's public key follows its label, and its port id never moves", () => {
  // 两者此前是同一个字符串,拼作 `node.label ?? node.id`,分别抄在
  // deriveOutputSchema 和 finishRun 里 —— 而那两处已经因为不一致炸过一次
  // (声明的形状与实际产出对不上)。现在是一个定义、两个读者。
  const node = { id: "out_1", label: "报告", config: { portId: "p_stable" } } as unknown as FlowNode;
  assert.equal(flowOutputKey(node), "报告", "对外契约里的字段名跟着显示名走");
  assert.equal(flowOutputPortId(node), "p_stable", "连线记住的是这个,改名碰不到它");

  const renamed = { ...node, label: "汇总" } as FlowNode;
  assert.equal(flowOutputKey(renamed), "汇总");
  assert.equal(flowOutputPortId(renamed), "p_stable", "改名之后仍然是同一个端口");
});

test("a flowOutput written before portId existed resolves to its node id, so nothing needs migrating", () => {
  const legacy = { id: "out_1", label: "报告", config: {} } as unknown as FlowNode;
  assert.equal(flowOutputPortId(legacy), "out_1");
  // 没有 label 的老节点,对外键就退回节点 id —— 与它一直以来解析出的字符串一致。
  assert.equal(flowOutputKey({ id: "out_2", config: {} } as unknown as FlowNode), "out_2");
});

// ── 端口上显示的类型 ──────────────────────────────────────────────────────

test("a port reports what its type IS, not only when it is missing", () => {
  // The canvas used to say `·未声明` for an unknown contract and NOTHING for a
  // known one, so "typed" and "untyped" looked the same on a card. The schemas
  // were there — `propagateRouterSchemas` fills every router port correctly —
  // they were just never displayed, which reads exactly like not having them.
  assert.equal(portTypeLabel({ type: "string" }), "文本");
  assert.equal(portTypeLabel({ type: "number" }), "数字");
  assert.equal(portTypeLabel({ type: "boolean" }), "是否");
  assert.equal(portTypeLabel({ type: "array", items: { type: "string" } }), "文本[]");
  assert.equal(portTypeLabel(null), null, "没有契约就没有类型可报,编一个「任意」是把缺失装扮成答案");
  assert.equal(portTypeLabel({}), null);
});

test("a schema's own title wins, because 商品 reads and 对象 does not", () => {
  const product = { title: "商品", type: "object", properties: { a: { type: "string" } } } as ParamSchemaFragment;
  assert.equal(portTypeLabel(product), "商品");
  assert.equal(portTypeLabel({ type: "array", items: product }), "商品[]", "一个 map 的入口就该读作「商品[]」");
});

test("an object without a title falls back to its field names, then to a count", () => {
  assert.equal(portTypeLabel({ type: "object", properties: { title: {}, price: {} } }), "{title, price}");
  const wide = { type: "object", properties: Object.fromEntries("abcdef".split("").map((k) => [k, {}])) } as ParamSchemaFragment;
  assert.equal(portTypeLabel(wide), "对象 6 字段");
});

test("a $ref schema says it has a contract rather than saying nothing", () => {
  // These are the ones that matter most — `canonical-product` is nine of them —
  // and `schemaToTs` deliberately gives up on them, so it cannot be reused here.
  assert.equal(portTypeLabel({ $ref: "#/$defs/x" } as ParamSchemaFragment), "有契约");
  assert.equal(portTypeLabel({ oneOf: [{ type: "string" }] } as ParamSchemaFragment), "有契约");
});

test("the label survives the propagation a real graph does", () => {
  // End to end over the shape that prompted this: an array of products in,
  // through map / branch / collect, and every port readable at each step.
  const product: ParamSchemaFragment = { title: "商品", type: "object", properties: { price: { type: "number" } } };
  const graph: FlowGraph = {
    nodes: [
      { id: "in", type: "flowInput", position: { x: 0, y: 0 }, config: {} as never },
      { id: "m", type: "map", position: { x: 0, y: 0 }, config: {} as never },
      { id: "c", type: "collect", position: { x: 0, y: 0 }, config: {} as never },
    ],
    edges: [
      { id: "e1", source: "in", sourceHandle: "p", target: "m", targetHandle: "items" },
      { id: "e2", source: "m", sourceHandle: "item", target: "c", targetHandle: "result" },
    ],
  };
  const map: PortMap = new Map([
    ["in", [outPort("p", { type: "array", items: product })]],
    ["m", mapPorts(null)],
    ["c", collectPorts(null)],
  ]);
  propagateRouterSchemas(graph, map);

  const label = (node: string, port: string): string | null =>
    portTypeLabel(map.get(node)!.find((p) => p.id === port)!.schema);
  assert.equal(label("m", "items"), "商品[]");
  assert.equal(label("m", "item"), "商品", "逐项处理把数组拆成一项 —— 端口上就该看得出来");
  assert.equal(label("c", "results"), "商品[]", "收集结果再合回去");
});

// ── 子流程的端口就是被引用流程的契约 ──────────────────────────────────────

test("a subflow's ports are the child's contract on BOTH sides", () => {
  // The node is the child. Two declared outputs must be two handles, not one
  // handle carrying an object — otherwise wiring just one of them downstream
  // means taking the whole product and picking a field back out of it, which
  // is the node failing to describe what it is.
  const ports = subflowPorts(
    [
      { name: "n", required: true, schema: { type: "number" } },
      { name: "label", required: false },
    ],
    { type: "object", properties: { 结果: { type: "object" }, 汇总: { type: "string" } } },
  );

  const ins = ports.filter((p) => p.direction === "in");
  const outs = ports.filter((p) => p.direction === "out");
  assert.deepEqual(ins.map((p) => [p.id, p.required]), [["n", true], ["label", false]]);
  assert.deepEqual(outs.map((p) => p.id), ["结果", "汇总"]);
  assert.deepEqual(outs.find((p) => p.id === "汇总")!.schema, { type: "string" }, "每个出口带自己那段契约,连线才判得了型");
});

test("a child that declares nothing on a side gives no ports on that side", () => {
  // Honest rather than convenient: a flow with no flowOutput produces nothing,
  // and a node with nowhere to wire FROM is the accurate picture of that. An
  // invented `output` port would be a handle promising a value that never comes.
  assert.deepEqual(subflowPorts([], null), []);
  assert.deepEqual(
    subflowPorts([{ name: "n", required: true }], null).map((p) => [p.id, p.direction]),
    [["n", "in"]],
  );
  assert.deepEqual(
    subflowPorts([], { type: "object", properties: { 结果: {} } }).map((p) => [p.id, p.direction]),
    [["结果", "out"]],
  );
});

test("数据映射节点的入口继承上游契约,但它的出口绝不继承", () => {
  // 两半都要断言,因为它们会朝相反的方向坏掉:
  //  · 入口不继承 → schema 恒为 null → isAssignable 对无约束目标一律放行,
  //    于是画布的类型检查在每个数据映射节点处静默失效;
  //  · 出口跟着继承 → 一个没填契约的输出会自称拥有「输入的形状」,而它的值是
  //    expr 取出来的、形状按构造就不同 —— 下游会基于这个假声明被判为可连。
  const product: ParamSchemaFragment = {
    type: "object",
    title: "商品",
    properties: { url: { type: "string" }, price: { type: "number" } },
  } as ParamSchemaFragment;

  const graph: FlowGraph = {
    nodes: [
      { id: "src", type: "book", position: { x: 0, y: 0 }, config: {} as never },
      { id: "t", type: "transform", position: { x: 0, y: 0 }, config: {} as never },
    ],
    edges: [{ id: "e1", source: "src", sourceHandle: "out", target: "t", targetHandle: "input" }],
  };
  const map: PortMap = new Map([
    ["src", ports(outPort("out", product))],
    // 出口 declared 自带契约,undeclared 故意留空 —— 后者正是会被错误盖章的那个
    ["t", ports(inPort("input", true, null), outPort("declared", { type: "string" } as ParamSchemaFragment), outPort("undeclared", null))],
  ]);

  propagateRouterSchemas(graph, map);
  const after = map.get("t")!;

  assert.deepEqual(
    after.find((p) => p.id === "input")?.schema,
    product,
    "入口必须拿到上游的契约,否则这里的连线永远无法被判定",
  );
  assert.deepEqual(
    after.find((p) => p.id === "declared")?.schema,
    { type: "string" },
    "已声明的出口不得被覆盖",
  );
  assert.equal(
    after.find((p) => p.id === "undeclared")?.schema,
    null,
    "未声明的出口必须保持未声明 —— 冒充成输入的形状比没有形状更坏",
  );
});
