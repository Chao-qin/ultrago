import { test } from "node:test";
import assert from "node:assert/strict";
import { NotFoundException } from "@nestjs/common";
import type { FlowGraph, FlowNode, ParamSchemaFragment, ParamSpec } from "@bcp/shared";
import { applyPreprocessConfigDefault, FlowsService, validateMaps } from "./flows.service.js";

/**
 * Where the derived contracts actually LAND.
 *
 * `flow-output-schema.test.ts` next door covers `deriveOutputSchema` as a pure
 * function — what the graph implies. Nothing covered the seam that writes the
 * answer to the row: deleting `data.outputSchema = out ? … : null` from
 * `update()` left the console suite at 181 passing, while every flow's stored
 * `Flow.outputSchema` quietly froze at whatever it said before the edit.
 *
 * A frozen contract is worse than a missing one, because it is what other
 * flows read when they embed this flow as a node: the canvas would show one
 * shape and the consumer would be typed against another.
 *
 * The `null` half matters just as much as the write half — see the test for
 * removing the last output node.
 */

const REPLY: ParamSchemaFragment = { type: "object", properties: { reply: { type: "string" } } };

const outputNode = (id: string, label: string, schema: ParamSchemaFragment): FlowNode => ({
  id, type: "flowOutput", position: { x: 0, y: 0 }, label, config: { schema },
});

const KEYWORD: ParamSpec = { name: "keyword", required: true };

test("missing preprocessConfig is filled from the selected SchemaRecord payload", () => {
  const specs: ParamSpec[] = [{
    name: "preprocessConfig",
    required: false,
    schemaRef: { name: "product-preprocess-config", version: 2 },
  }];
  const record = { data: JSON.stringify({ configId: "cfg-1", shopProfile: {}, pricing: { markup: 12 } }) };

  assert.deepEqual(
    applyPreprocessConfigDefault(specs, {}, record),
    { preprocessConfig: { configId: "cfg-1", shopProfile: {}, pricing: { markup: 12 } } },
  );
});

test("an explicit preprocessConfig is never overwritten by the default record", () => {
  const specs: ParamSpec[] = [{
    name: "preprocessConfig",
    required: false,
    schemaRef: { name: "product-preprocess-config", version: 2 },
  }];
  const explicit = { configId: "chosen", shopProfile: {} };
  const record = { data: JSON.stringify({ configId: "fallback", shopProfile: {} }) };

  assert.deepEqual(applyPreprocessConfigDefault(specs, { preprocessConfig: explicit }, record), { preprocessConfig: explicit });
});

const inputNode = (id: string, label: string): FlowNode => ({
  id, type: "flowInput", position: { x: 0, y: 0 }, label,
  // `as never` matches how flow-types.test.ts builds these: FlowNodeConfig is a
  // union whose flowInput arm is not separately nameable from here.
  config: { params: [KEYWORD] } as never,
});

const graphJson = (nodes: FlowNode[]): string => JSON.stringify({ nodes, edges: [] } satisfies FlowGraph);

function serviceOver(row: Record<string, unknown> = { id: "f1", name: "flow", deletedAt: null }) {
  const rows = [{ ...row }];
  const updated: Array<Record<string, unknown>> = [];
  const prisma = {
    flow: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) =>
        rows.find((r) => r.id === where.id && (where.deletedAt !== null || r.deletedAt === null)) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Record<string, unknown> }) => {
        const target = rows.find((r) => r.id === where.id);
        if (!target) throw Object.assign(new Error(`test double: update() on missing row ${where.id}`), { code: "P2025" });
        updated.push(data);
        Object.assign(target, data);
        return target;
      },
    },
  };
  // A flowOutput carrying an inline `schema` never cites the registry, so
  // SchemasService is never reached; a stub pretending to resolve refs would
  // just be another thing to keep true.
  return { svc: new FlowsService(prisma as never, undefined as never), rows, updated };
}

test("saving a graph writes the contract derived FROM that graph", async () => {
  const { svc, updated } = serviceOver();
  await svc.update("f1", { graphJson: graphJson([inputNode("i1", "关键词"), outputNode("o1", "产出", REPLY)]) });

  assert.equal(updated.length, 1);
  assert.deepEqual(
    JSON.parse(String(updated[0].outputSchema)),
    { type: "object", properties: { 产出: REPLY } },
    "Flow.outputSchema must carry the object-keyed-by-node contract, not the node's bare schema",
  );
  assert.deepEqual(
    JSON.parse(String(updated[0].inputSchema)),
    [KEYWORD],
    "the input contract lands in the same block, from the same graph",
  );
});

test("removing the last output node CLEARS the stored contract instead of leaving it stale", async () => {
  // The half a `if (out) data.outputSchema = …` would get wrong. The flow
  // starts out advertising `{产出: …}`; after the edit it produces nothing, and
  // the row has to say so — an explicit null, not an absent key.
  const { svc, updated, rows } = serviceOver({
    id: "f1", name: "flow", deletedAt: null,
    outputSchema: JSON.stringify({ type: "object", properties: { 产出: REPLY } }),
  });

  await svc.update("f1", { graphJson: graphJson([inputNode("i1", "关键词")]) });

  assert.ok("outputSchema" in updated[0], "the write must mention outputSchema at all");
  assert.equal(updated[0].outputSchema, null, "a flow with no output node advertises no contract");
  assert.equal(rows[0].outputSchema, null, "and the stale contract is gone from the row");
});

test("a patch that does not touch the graph leaves the contract alone", async () => {
  // Renaming a flow must not recompute — or worse, blank — a contract the
  // caller never sent a graph for.
  const stored = JSON.stringify({ type: "object", properties: { 产出: REPLY } });
  const { svc, updated, rows } = serviceOver({ id: "f1", name: "flow", deletedAt: null, outputSchema: stored });

  await svc.update("f1", { description: "just a note" });

  assert.equal("outputSchema" in updated[0], false, "no graph in the patch, no contract in the write");
  assert.equal("inputSchema" in updated[0], false);
  assert.equal(rows[0].outputSchema, stored);
});

test("update() refuses a soft-deleted flow before writing anything", async () => {
  // `update()` opens with findById(), whose predicate is the guard; asserting
  // it here keeps the contract-writing block from ever running for a row the
  // user removed.
  const { svc, updated } = serviceOver({ id: "f1", name: "flow", deletedAt: new Date("2026-08-01") });
  await assert.rejects(() => svc.update("f1", { graphJson: graphJson([outputNode("o1", "产出", REPLY)]) }), NotFoundException);
  assert.deepEqual(updated, []);
});

/* ── a flowInput that CITES the registry ─────────────────────────────────────
 *
 * `flow-types.test.ts` covers `flowInputParams` / `deriveInputSchema` as pure
 * functions, GIVEN a resolver. Nothing covered the resolver this service
 * builds, nor the ports it derives from the same helper — the two seams that
 * turn a citation into something the runner and the canvas can act on.
 *
 * Measured before these were written: dropping `await this.flowInputRefs(graph)`
 * from `update()`, keying that cache on `ref.name` alone, deleting its
 * `cache.has` guard, and reverting `portsFor`'s flowInput case to the
 * pre-feature `config.params ?? []` ALL left the console suite green.
 */

const CITED = { type: "object", required: ["keyword"], properties: { keyword: { type: "string" }, limit: { type: "number" } } };
const CITED_V1 = { type: "object", properties: { legacy: { type: "string" } } };

/** A service over a registry holding two versions of one name, recording every
 *  citation it was asked to resolve. The call log is the only way to see the
 *  cache at all: it changes no answer, so an assertion on the answer alone
 *  would call a deleted cache correct. */
function serviceOverRegistry() {
  const rows = [{ id: "f1", name: "flow", deletedAt: null } as Record<string, unknown>];
  const updated: Array<Record<string, unknown>> = [];
  const asked: string[] = [];
  const prisma = {
    flow: {
      findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id && r.deletedAt === null) ?? null,
      update: async ({ data }: { data: Record<string, unknown> }) => { updated.push(data); Object.assign(rows[0], data); return rows[0]; },
    },
    // Present so the double is complete, not because this graph reaches it:
    // resolvePorts skips the query entirely when no node cites a book
    // (`bookIds.length ? … : []`). Saying otherwise would have this stub
    // justify itself with a behaviour the service does not have.
    book: { findMany: async () => [] },
  };
  const schemas = {
    resolve: async (name: string, version?: number) => {
      asked.push(`${name}@${version ?? "active"}`);
      if (name !== "book-input-x") throw new NotFoundException(`no active schema named "${name}"`);
      return { jsonSchema: JSON.stringify(version === 1 ? CITED_V1 : CITED) };
    },
  };
  return { svc: new FlowsService(prisma as never, schemas as never), updated, asked };
}

const citingNode = (id: string, ref: { name: string; version?: number }): FlowNode => ({
  id, type: "flowInput", position: { x: 0, y: 0 }, config: { params: [], schemaRef: ref } as never,
});

test("a flowInput that cites the registry lands the CITED fields in Flow.inputSchema", async () => {
  const { svc, updated } = serviceOverRegistry();
  await svc.update("f1", { graphJson: graphJson([citingNode("i1", { name: "book-input-x" })]) });
  const specs = JSON.parse(String(updated[0].inputSchema)) as ParamSpec[];
  assert.deepEqual(specs.map((s) => s.name), ["keyword", "limit"], "without the pre-resolver a citing flow advertises no parameters at all");
  assert.equal(specs[0].required, true, "the cited `required` list survives into the row");
});

test("the pre-resolver keys on name AND version, so a pin is not served the active document", async () => {
  // One name, two citations. Keyed on `ref.name` alone the second node is
  // handed the first node's document and the flow asks for the wrong
  // parameters — silently, because both citations still resolve.
  const { svc, updated, asked } = serviceOverRegistry();
  await svc.update("f1", {
    graphJson: graphJson([citingNode("pinned", { name: "book-input-x", version: 1 }), citingNode("live", { name: "book-input-x" })]),
  });
  assert.deepEqual(asked, ["book-input-x@1", "book-input-x@active"], "two distinct citations, two lookups");
  assert.deepEqual(
    (JSON.parse(String(updated[0].inputSchema)) as ParamSpec[]).map((s) => s.name),
    ["legacy", "keyword", "limit"],
    "the pinned node contributes v1's field, not the active version's",
  );
});

test("two identical citations are resolved once", async () => {
  const { svc, asked } = serviceOverRegistry();
  await svc.update("f1", { graphJson: graphJson([citingNode("a", { name: "book-input-x" }), citingNode("b", { name: "book-input-x" })]) });
  assert.deepEqual(asked, ["book-input-x@active"], "the cache exists to spare the registry one query per citing node");
});

test("resolvePorts gives a citing flowInput one output port per cited field", async () => {
  // These are the handles the canvas draws and the ones `validatePorts` matches
  // every wire against. Reverting this case to `config.params ?? []` leaves a
  // citing node with NO ports, so every wire out of it fails as 连线起点端口不
  // 存在 and the flow can no longer be triggered — while the browser, which
  // resolves the same citation itself, still draws the handles and saves fine.
  const { svc } = serviceOverRegistry();
  const ports = await svc.resolvePorts({ nodes: [citingNode("i1", { name: "book-input-x" })], edges: [] });
  assert.deepEqual(ports.get("i1")!.map((p) => p.id), ["keyword", "limit"]);
  assert.ok(ports.get("i1")!.every((p) => p.direction === "out"), "the flow's inputs LEAVE this node");
  assert.deepEqual(ports.get("i1")![0].schema, { type: "string" }, "the port carries the cited field's own schema, which is what wires are judged against");
});

test("an unresolvable citation renders without ports but blocks saving with an actionable error", async () => {
  // A schema deleted out from under a saved flow must remain renderable so it
  // can be repaired, but saving a graph that still cites it would create an
  // unusable flow and is therefore rejected.
  const { svc, updated } = serviceOverRegistry();
  const nodes = [citingNode("i1", { name: "not-registered" })];
  assert.deepEqual((await svc.resolvePorts({ nodes, edges: [] })).get("i1"), []);
  await assert.rejects(() => svc.update("f1", { graphJson: graphJson(nodes) }), /not-registered/);
  assert.equal(updated.length, 0);
});

test("inline params win over a citation, in the row AND on the ports", async () => {
  // The hand-edited / older-client graph flow-types.ts documents. Both seams
  // have to read the precedence the same way, or the canvas would show the
  // cited fields while the runner demanded the typed ones.
  const { svc, updated } = serviceOverRegistry();
  const node: FlowNode = {
    id: "i1", type: "flowInput", position: { x: 0, y: 0 },
    config: { params: [{ name: "typed", required: false }], schemaRef: { name: "book-input-x" } } as never,
  };
  await svc.update("f1", { graphJson: graphJson([node]) });
  assert.deepEqual((JSON.parse(String(updated[0].inputSchema)) as ParamSpec[]).map((s) => s.name), ["typed"]);
  assert.deepEqual((await svc.resolvePorts({ nodes: [node], edges: [] })).get("i1")!.map((p) => p.id), ["typed"]);
});

test("script: inline contract wins over registry citation on both ports and in storage", async () => {
  // Mirrors the flowInput case above. The script node has the same inline-first
  // rule (flow-types.ts documents it as `ScriptNodeConfig` next to
  // `FlowOutputNodeConfig`); both seams — the runner's input-port resolution
  // and the stored row — have to agree, or the canvas wires onto `typed` while
  // the runner dispatches with `keyword` and the input the script actually got
  // never matches what the author thinks it does.
  const { svc } = serviceOverRegistry();
  const node: FlowNode = {
    id: "s1", type: "script", position: { x: 0, y: 0 },
    config: {
      inputSchema: { type: "object", properties: { typed: { type: "string" } } },
      inputSchemaRef: { name: "book-input-x" },
      outputSchema: { type: "object", properties: { ok: { type: "boolean" } } },
      outputSchemaRef: { name: "book-input-x" },
    },
  } as never;
  const ports = await svc.resolvePorts({ nodes: [node], edges: [] });
  assert.deepEqual(ports.get("s1")!.filter((p) => p.direction === "in").map((p) => p.id), ["typed"]);
  const out = ports.get("s1")!.find((p) => p.direction === "out");
  assert.deepEqual(out?.schema, { type: "object", properties: { ok: { type: "boolean" } } });
});

// ── map 的三种歧义图形：宁可拒绝，也不默默挑一个 ──────────────────────────

const mapNode = (id: string, type: string) => ({ id, type, position: { x: 0, y: 0 }, config: {} }) as never;
const mapEdge = (id: string, s: string, sh: string, t: string, th: string) =>
  ({ id, source: s, sourceHandle: sh, target: t, targetHandle: th });

test("map: item 直连 collect —— 每一项没有要做的事,拒绝保存而不是运行时卡死", () => {
  // 恒等映射是任何人第一个会试的连法。此前它校验全绿,运行时 seedIteration 建
  // 零行、stepMap 每拍在同一行 return,run 永远停在 running,毫无诊断。
  const graph = { nodes: [mapNode("m", "map"), mapNode("c", "collect")], edges: [mapEdge("e0", "m", "item", "c", "result")] } as never;
  const problems = validateMaps(graph);
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.match(problems[0].message, /之间没有任何节点/);
});

test("map: 一个节点同时属于两个 map —— 拒绝,否则后写的那个静默覆盖前一个", () => {
  // mapOwners 是单值 Map,后处理的 map 直接覆盖。输的那个 map 从此每拍空转,
  // 而它自己那行还停在 success,于是整条 run 报成功、活儿只干了一半。
  const graph = {
    nodes: [mapNode("m1", "map"), mapNode("m2", "map"), mapNode("a", "transform"), mapNode("c", "collect")],
    edges: [mapEdge("e0", "m1", "item", "a", "x"), mapEdge("e1", "m2", "item", "a", "y"), mapEdge("e2", "a", "out", "c", "result")],
  } as never;
  const problems = validateMaps(graph);
  assert.ok(problems.some((p) => p.level === "error" && /同时属于 2 个/.test(p.message)), JSON.stringify(problems));
});

test("map: 下游两个 collect —— 报「有两个」,而不是诬告其中一个没人连", () => {
  // 旧行为取 collects[0],另一个 collect 于是收到「没有任何逐项处理通向它」——
  // 这句话是假的(有路径,只是没被选中),照着它排查会去找根本不存在的断线。
  const graph = {
    nodes: [mapNode("m", "map"), mapNode("a", "transform"), mapNode("b", "transform"), mapNode("c1", "collect"), mapNode("c2", "collect")],
    edges: [
      mapEdge("e0", "m", "item", "a", "x"), mapEdge("e1", "a", "out", "c1", "result"),
      mapEdge("e2", "m", "item", "b", "x"), mapEdge("e3", "b", "out", "c2", "result"),
    ],
  } as never;
  const problems = validateMaps(graph);
  assert.ok(problems.some((p) => /下游有 2 个/.test(p.message)), JSON.stringify(problems));
  assert.equal(problems.some((p) => /没有任何「逐项处理」通向它/.test(p.message)), false, "不能再诬告 c2");
});

test("map: 正常图形不报任何问题", () => {
  const graph = {
    nodes: [mapNode("m", "map"), mapNode("a", "transform"), mapNode("c", "collect")],
    edges: [mapEdge("e0", "m", "item", "a", "x"), mapEdge("e1", "a", "out", "c", "result")],
  } as never;
  assert.deepEqual(validateMaps(graph), []);
});

// ── 断点续跑 ──────────────────────────────────────────────────────────────

/**
 * A prisma double for `resumeRun`: one parent run whose rows are given, and a
 * capture of the child that gets created.
 *
 * `create` is captured rather than executed, because what is being tested IS
 * the row set handed to it — which rows are carried whole and which are reset
 * to `pending`. Running it would only re-assert Prisma's own behaviour.
 */
function resumeOver(parent: Record<string, unknown>, opts: {
  enabled?: boolean;
  liveChild?: Record<string, unknown> | null;
  delayReads?: boolean;
  failCreates?: number;
} = {}) {
  const created: Array<Record<string, unknown>> = [];
  const children: Array<Record<string, unknown>> = opts.liveChild ? [{ trigger: 'manual', ...opts.liveChild }] : [];
  const prisma = {
    flow: {
      // Present because `resumeRun` reads `enabled`. The double covering fewer
      // tables than the code touches is how a fake stops testing the code and
      // starts testing itself — this one grew a `flow` table the moment the
      // service started asking for one.
      findFirst: async () => ({ id: "f1", name: "flow", enabled: opts.enabled ?? true, deletedAt: null }),
    },
    flowRun: {
      findFirst: async ({ where }: { where: Record<string, unknown> }) => {
        if (where.parentFlowRunId !== undefined) {
          const statuses = (where.status as { in?: string[] } | undefined)?.in;
          const found = children.find((child) =>
            child.parentFlowRunId === where.parentFlowRunId &&
            (where.trigger === undefined || child.trigger === where.trigger) &&
            (!statuses || statuses.includes(String(child.status))) &&
            (where.deletedAt !== null || child.deletedAt == null),
          ) ?? null;
          if (opts.delayReads) await new Promise<void>((resolve) => setImmediate(resolve));
          return found;
        }
        if (opts.delayReads) await new Promise<void>((resolve) => setImmediate(resolve));
        return where.id === parent.id ? parent : null;
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (opts.failCreates) {
          opts.failCreates -= 1;
          throw new Error('create unavailable');
        }
        created.push(data);
        const child = { id: `child-${created.length}`, ...data, nodes: [] };
        children.unshift(child);
        return child;
      },
    },
  };
  return { svc: new FlowsService(prisma as never, undefined as never), created, children };
}

const MAP_GRAPH: FlowGraph = {
  nodes: [
    { id: "in", type: "flowInput", position: { x: 0, y: 0 }, config: { params: [] } as never },
    { id: "m", type: "map", position: { x: 0, y: 0 }, config: {} as never },
    { id: "s", type: "script", position: { x: 0, y: 0 }, config: {} as never },
    { id: "c", type: "collect", position: { x: 0, y: 0 }, config: {} as never },
    { id: "t", type: "script", position: { x: 0, y: 0 }, config: {} as never },
  ],
  edges: [
    { id: "e1", source: "in", sourceHandle: "p", target: "m", targetHandle: "items" },
    { id: "e2", source: "m", sourceHandle: "item", target: "s", targetHandle: "input" },
    { id: "e3", source: "s", sourceHandle: "output", target: "c", targetHandle: "result" },
    { id: "e4", source: "c", sourceHandle: "results", target: "t", targetHandle: "input" },
  ],
};

const parentRun = (nodes: Array<Record<string, unknown>>, status = "failed"): Record<string, unknown> => ({
  id: "r1",
  flowId: "f1",
  status,
  mode: "auto",
  paramsJson: '{"names":["A"]}',
  graphSnapshot: JSON.stringify(MAP_GRAPH),
  deletedAt: null,
  nodes,
});

const row = (nodeId: string, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  nodeId,
  nodeType: nodeId === "m" ? "map" : nodeId === "c" ? "collect" : nodeId === "in" ? "flowInput" : "script",
  iteration: null,
  status,
  inputJson: null,
  outputJson: null,
  runId: null,
  childFlowRunId: null,
  errorMessage: null,
  startedAt: null,
  finishedAt: null,
  durationMs: null,
  ...extra,
});

test("a succeeded node is carried whole rather than re-run", async () => {
  // The entire point. The nodes this saves are the ones that drive a browser,
  // so a flow that scraped four products and broke on the fifth must not scrape
  // the four again. Copying is not a shortcut around running it — the node DID
  // run, in the parent, and its product is right there.
  const { svc, created } = resumeOver(
    parentRun([
      row("in", "success", { outputJson: '{"names":["A"]}' }),
      row("m", "success", { outputJson: '{"$map":{"index":1}}', durationMs: 71, startedAt: new Date(1) }),
      row("c", "success", { outputJson: '{"results":[1]}' }),
      row("t", "failed", { errorMessage: "boom" }),
    ]),
  );

  await svc.resumeRun("r1");
  const rows = (created[0].nodes as { create: Array<Record<string, unknown>> }).create;
  const byId = new Map(rows.filter((r) => r.iteration === null || r.iteration === undefined).map((r) => [r.nodeId, r]));

  assert.equal(byId.get("m")!.status, "success");
  assert.equal(byId.get("m")!.outputJson, '{"$map":{"index":1}}', "循环状态跟着走,否则 map 会重头再来");
  assert.equal(byId.get("m")!.durationMs, 71, "用时照抄,续跑后的历史才是完整的一条");
  assert.equal(byId.get("c")!.status, "success");
  assert.equal(byId.get("t")!.status, "pending", "失败的那个才重跑");
  assert.equal(byId.get("t")!.errorMessage, undefined, "重跑的行不该带着上次的错");
  assert.equal(created[0].parentFlowRunId, "r1");
  assert.equal(created[0].graphSnapshot, JSON.stringify(MAP_GRAPH), "用父 run 的快照——流程可能已经被改过");
});

test("a finished map's per-item rows come along, because they are the answer to which item failed", async () => {
  const { svc, created } = resumeOver(
    parentRun([
      row("in", "success"),
      row("m", "success", { outputJson: '{"$map":{"index":2}}' }),
      row("s", "success", { iteration: 0, outputJson: '{"output":1}' }),
      row("s", "failed", { iteration: 1, errorMessage: "第 2 项炸了" }),
      row("c", "success"),
      row("t", "failed"),
    ]),
  );

  await svc.resumeRun("r1");
  const rows = (created[0].nodes as { create: Array<Record<string, unknown>> }).create;
  const iters = rows.filter((r) => r.iteration !== null && r.iteration !== undefined);
  assert.equal(iters.length, 2, `逐项历史必须带过来: ${JSON.stringify(rows)}`);
  assert.deepEqual(iters.map((r) => [r.iteration, r.status]), [[0, "success"], [1, "failed"]]);
  assert.equal(iters[1].errorMessage, "第 2 项炸了", "失败项的原因保留,否则「哪一项失败」就答不出来了");
});

test("an unfinished map brings no per-item rows, because it is about to make those passes again", async () => {
  // Seeding rows for iterations the runner is about to mint would leave it
  // looking at rows it did not create — and the first of them says `success`
  // for a pass that has not happened yet in this run.
  const { svc, created } = resumeOver(
    parentRun([
      row("in", "success"),
      row("m", "failed", { outputJson: '{"$map":{"index":1}}', errorMessage: "第 2 项处理失败" }),
      row("s", "success", { iteration: 0, outputJson: '{"output":1}' }),
      row("s", "failed", { iteration: 1 }),
      row("c", "skipped"),
    ]),
  );

  await svc.resumeRun("r1");
  const rows = (created[0].nodes as { create: Array<Record<string, unknown>> }).create;
  assert.deepEqual(rows.filter((r) => r.iteration !== null && r.iteration !== undefined), []);
  const m = rows.find((r) => r.nodeId === "m")!;
  assert.equal(m.status, "pending");
  assert.equal(m.outputJson, undefined, "循环状态必须清掉,留着它 map 会以为自己已经跑完");
  assert.equal(rows.some((r) => r.nodeId === "s" && r.iteration === null), false, "map 体内的节点不预建行");
});

test("only a failed run can be resumed", async () => {
  for (const status of ["success", "cancelled", "running", "pending"]) {
    const { svc } = resumeOver(parentRun([row("in", "success")], status));
    await assert.rejects(svc.resumeRun("r1"), /只有失败的运行可以续跑/, `${status} 不该能续跑`);
  }
});

test("resuming a run that is not there is a 404, not a crash", async () => {
  const { svc } = resumeOver(parentRun([row("in", "success")]));
  await assert.rejects(svc.resumeRun("nope"), NotFoundException);
});

test("a disabled flow cannot be resumed either, because resuming starts a run", async () => {
  // The switch someone flips BECAUSE a flow is misbehaving has to stop the
  // button people reach for when a flow is misbehaving. `trigger` has always
  // checked this; resume produces the same pending row for the same dispatcher.
  const { svc, created } = resumeOver(parentRun([row("in", "success")]), { enabled: false });
  await assert.rejects(svc.resumeRun("r1"), /is disabled/);
  assert.deepEqual(created, [], "被拒绝时不该已经建了 run");
});

test("resuming twice returns the run already in flight instead of starting a second one", async () => {
  // A double click would otherwise mint two runs that each redo the same
  // unfinished nodes — and those nodes are the ones that drive a browser.
  // `dedupeKey` cannot help: it carries a timestamp, so it is unique per call
  // by construction and the index can never fire.
  const inFlight = { id: "child-1", status: "running", parentFlowRunId: "r1" };
  const { svc, created } = resumeOver(parentRun([row("in", "success"), row("t", "failed")]), { liveChild: inFlight });

  const result = await svc.resumeRun("r1");
  assert.equal((result as { id: string }).id, "child-1", "拿到的是已经在跑的那条,不是新的");
  assert.deepEqual(created, [], "没有建第二条");
});

const bookResumeParent = (
  nodes: Array<Record<string, unknown>>,
  { inMap = false, policy = 'verify-before-retry' }: { inMap?: boolean; policy?: string | null } = {},
): Record<string, unknown> => ({
  ...parentRun(nodes),
  graphSnapshot: JSON.stringify({
    ...MAP_GRAPH,
    nodes: MAP_GRAPH.nodes.map((node) => node.id === (inMap ? 's' : 't')
      ? { ...node, type: 'book', label: '发布商品', config: { bookId: 'publish', ...(policy ? { resumePolicy: policy } : {}) } }
      : node),
  }),
});

test('failed or running external writes are blocked before creating a resume', async () => {
  for (const status of ['failed', 'running']) {
    const { svc, created } = resumeOver(bookResumeParent([
      row('t', status, { nodeType: 'book', startedAt: new Date(1) }),
    ]));
    const detail = await svc.getRun('r1');
    assert.match(detail.resumeBlockReason ?? '', /核验/);
    await assert.rejects(svc.resumeRun('r1'), { message: detail.resumeBlockReason });
    assert.equal(created.length, 0);
  }
});

test('a protected book that never started may execute, preserving original execution inputs', async () => {
  const parent = bookResumeParent([row('t', 'pending', { nodeType: 'book' })]);
  parent.paramsJson = '{"token":"execution-secret"}';
  const { svc, created } = resumeOver(parent);
  const detail = await svc.getRun('r1');
  assert.equal(detail.resumeBlockReason, null);
  assert.equal(detail.paramsJson, '{"token":"execution-secret"}');
  assert.equal(detail.graphSnapshot, parent.graphSnapshot);
  await svc.resumeRun('r1');
  assert.equal(created.length, 1);
  assert.equal(created[0].paramsJson, '{"token":"execution-secret"}');
});

test('a successful top-level protected book is copied with its raw result', async () => {
  const parent = bookResumeParent([row('t', 'success', {
    nodeType: 'book', runId: 'published-run', inputJson: '{"token":"secret"}', outputJson: '{"receipt":"saved"}',
  })]);
  const { svc, created } = resumeOver(parent);
  const detail = await svc.getRun('r1');
  assert.equal(detail.resumeBlockReason, null);
  assert.deepEqual(detail.nodes, parent.nodes);
  await svc.resumeRun('r1');
  const copied = (created[0].nodes as { create: Array<Record<string, unknown>> }).create.find((node) => node.nodeId === 't');
  assert.equal(copied?.status, 'success');
  assert.equal(copied?.runId, 'published-run');
  assert.equal(copied?.inputJson, '{"token":"secret"}');
  assert.equal(copied?.outputJson, '{"receipt":"saved"}');
});

test('a successful protected book inside an unfinished map cannot be replayed', async () => {
  const { svc, created } = resumeOver(bookResumeParent([
    row('m', 'failed'),
    row('s', 'success', { nodeType: 'book', iteration: 0 }),
    row('s', 'pending', { nodeType: 'book', iteration: 1 }),
  ], { inMap: true }));
  const detail = await svc.getRun('r1');
  assert.match(detail.resumeBlockReason ?? '', /核验/);
  await assert.rejects(svc.resumeRun('r1'), { message: detail.resumeBlockReason });
  assert.equal(created.length, 0);
});

test('completed maps carry protected iteration history without reexecuting the books', async () => {
  const { svc, created } = resumeOver(bookResumeParent([
    row('m', 'success'),
    row('s', 'success', { nodeType: 'book', iteration: 0, outputJson: '{"saved":true}' }),
    row('s', 'failed', { nodeType: 'book', iteration: 1, runId: 'uncertain', errorMessage: 'timeout' }),
    row('t', 'failed'),
  ], { inMap: true }));
  assert.equal((await svc.getRun('r1')).resumeBlockReason, null);
  await svc.resumeRun('r1');
  const copied = (created[0].nodes as { create: Array<Record<string, unknown>> }).create.filter((node) => node.nodeId === 's');
  assert.deepEqual(copied.map((node) => [node.iteration, node.status, node.outputJson, node.runId, node.errorMessage]), [
    [0, 'success', '{"saved":true}', null, null],
    [1, 'failed', null, 'uncertain', 'timeout'],
  ]);
});

test('legacy started books require verification while explicitly retryable reads are allowed', async () => {
  const nodes = [row('t', 'failed', { nodeType: 'book', runId: 'book-run' })];
  const legacy = resumeOver(bookResumeParent(nodes, { policy: null }));
  await assert.rejects(legacy.svc.resumeRun('r1'), /旧.*快照.*核验/);
  assert.equal(legacy.created.length, 0);
  const read = resumeOver(bookResumeParent(nodes, { policy: 'retry' }));
  assert.equal((await read.svc.getRun('r1')).resumeBlockReason, null);
  await read.svc.resumeRun('r1');
  assert.equal(read.created.length, 1);
});

test('simultaneous resume requests with delayed reads create only one child', async () => {
  const { svc, created } = resumeOver(parentRun([row('t', 'failed')]), { delayReads: true });
  const results = await Promise.all([svc.resumeRun('r1'), svc.resumeRun('r1')]);
  assert.equal(results[0].id, results[1].id);
  assert.equal(created.length, 1);
});

test('a previously resumed terminal parent cannot start another lineage, including deleted children', async () => {
  for (const status of ['failed', 'success', 'cancelled']) {
    for (const deletedAt of [null, new Date(1)]) {
      const { svc, created } = resumeOver(parentRun([row('t', 'failed')]), {
        liveChild: { id: 'latest-child', parentFlowRunId: 'r1', status, deletedAt },
      });
      await assert.rejects(svc.resumeRun('r1'), /latest-child/);
      assert.equal(created.length, 0);
    }
  }
});

test('resolved resume operations release their lock and observe subsequent child failure', async () => {
  const { svc, created, children } = resumeOver(parentRun([row('t', 'failed')]));
  await svc.resumeRun('r1');
  children[0].status = 'failed';
  await assert.rejects(svc.resumeRun('r1'), /child-1/);
  assert.equal(created.length, 1);
});

test('completed nested subflows do not count as an existing resume lineage', async () => {
  const { svc, created } = resumeOver(parentRun([row('t', 'failed')]), {
    liveChild: { id: 'nested-child', parentFlowRunId: 'r1', trigger: 'flow', status: 'success' },
  });
  const child = await svc.resumeRun('r1');
  assert.equal(child.id, 'child-1');
  assert.equal(created.length, 1);
});

test('rejected concurrent resumes propagate the error and permit a later request', async () => {
  const { svc, created } = resumeOver(parentRun([row('t', 'failed')]), { delayReads: true, failCreates: 1 });
  const results = await Promise.allSettled([svc.resumeRun('r1'), svc.resumeRun('r1')]);
  assert.deepEqual(results.map((result) => result.status), ['rejected', 'rejected']);
  for (const result of results) {
    if (result.status === 'rejected') assert.match(String(result.reason), /create unavailable/);
  }
  assert.equal(created.length, 0);
  await svc.resumeRun('r1');
  assert.equal(created.length, 1);
});

const subflowResumeParent = (nodes: Array<Record<string, unknown>>, inMap = false): Record<string, unknown> => ({
  ...parentRun(nodes),
  graphSnapshot: JSON.stringify({
    ...MAP_GRAPH,
    nodes: MAP_GRAPH.nodes.map((node) => node.id === (inMap ? 's' : 't')
      ? { ...node, type: 'flow', label: '发布子流程', config: { flowId: 'publish-flow' } }
      : node),
  }),
});

test('a failed outer subflow cannot start a fresh child that may repeat a protected inner book', async () => {
  const { svc, created } = resumeOver(subflowResumeParent([
    row('t', 'failed', { nodeType: 'flow', childFlowRunId: 'prior-child' }),
  ]), {
    liveChild: { id: 'prior-child', parentFlowRunId: 'r1', trigger: 'flow', status: 'failed' },
  });
  const detail = await svc.getRun('r1');
  assert.match(detail.resumeBlockReason ?? '', /子流程.*核验.*prior-child/);
  await assert.rejects(svc.resumeRun('r1'), { message: detail.resumeBlockReason });
  assert.equal(created.length, 0);
});

test('a successful subflow inside an unfinished map cannot be triggered again', async () => {
  const { svc, created } = resumeOver(subflowResumeParent([
    row('m', 'failed'),
    row('s', 'success', { nodeType: 'flow', iteration: 0, childFlowRunId: 'prior-child' }),
  ], true));
  await assert.rejects(svc.resumeRun('r1'), /子流程.*核验/);
  assert.equal(created.length, 0);
});

test('a successful top-level subflow is reused and a never-started subflow can start', async () => {
  for (const status of ['success', 'pending']) {
    const { svc, created } = resumeOver(subflowResumeParent([
      row('t', status, { nodeType: 'flow', childFlowRunId: status === 'success' ? 'prior-child' : null }),
    ]));
    assert.equal((await svc.getRun('r1')).resumeBlockReason, null);
    await svc.resumeRun('r1');
    const copied = (created[0].nodes as { create: Array<Record<string, unknown>> }).create.find((node) => node.nodeId === 't');
    assert.equal(copied?.status, status);
    assert.equal(copied?.childFlowRunId, status === 'success' ? 'prior-child' : undefined);
  }
});

// ── 子流程 ───────────────────────────────────────────────────────────────

/** A prisma double holding several flows, so the cross-flow walk has edges to
 *  walk. `graphJson` is the only thing that matters — that is where the subflow
 *  edges live. */
function flowsOver(flows: Array<{ id: string; name: string; enabled?: boolean; nodes?: FlowNode[] }>) {
  const rows = flows.map((f) => ({
    id: f.id,
    name: f.name,
    enabled: f.enabled ?? true,
    deletedAt: null,
    graphJson: JSON.stringify({ nodes: f.nodes ?? [], edges: [] } satisfies FlowGraph),
    inputSchema: null,
    outputSchema: null,
  }));
  const prisma = {
    flow: {
      findFirst: async ({ where }: { where: { id: string } }) => rows.find((r) => r.id === where.id) ?? null,
      update: async () => rows[0],
    },
  };
  return { svc: new FlowsService(prisma as never, undefined as never), rows };
}

const subflowNode = (id: string, flowId?: string): FlowNode =>
  ({ id, type: "flow", position: { x: 0, y: 0 }, label: id, config: flowId ? { flowId } : {} }) as unknown as FlowNode;

/** `validateSubflows` is private — reached the way the only caller does. */
const checkSubflows = (svc: FlowsService, selfId: string, graph: FlowGraph): Promise<Array<{ level: string; message: string }>> =>
  (svc as unknown as { validateSubflows(id: string, g: FlowGraph): Promise<Array<{ level: string; message: string }>> })
    .validateSubflows(selfId, graph);

test("a flow embedding itself is refused at save time", async () => {
  // Not a wrong answer — infinite recursion. And on this scheduler that means
  // a chain of parents each holding a slot and waiting for a child.
  const { svc } = flowsOver([{ id: "a", name: "甲" }]);
  const problems = await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "a")], edges: [] });
  assert.equal(problems.length, 1);
  assert.equal(problems[0].level, "error");
  assert.match(problems[0].message, /不能把自己当子流程|无限递归/);
});

test("a cycle drawn across three flows is refused, and the message names the path", async () => {
  // `validateGraphShape` cannot see this: each of the three graphs is a
  // perfectly good DAG on its own. The cycle only exists between documents.
  const { svc } = flowsOver([
    { id: "a", name: "甲", nodes: [subflowNode("n1", "b")] },
    { id: "b", name: "乙", nodes: [subflowNode("n1", "c")] },
    { id: "c", name: "丙", nodes: [subflowNode("n1", "a")] },
  ]);
  const problems = await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "b")], edges: [] });
  assert.equal(problems.length, 1);
  assert.match(problems[0].message, /乙/, `路径要说清楚绕了哪几条：${problems[0].message}`);
  assert.match(problems[0].message, /丙/);
});

test("two nodes embedding the same child is a diamond, not a cycle", async () => {
  // The `seen` set has to distinguish "visited already" from "came back round".
  // Refusing this would refuse the ordinary case of reusing a subflow twice.
  const { svc } = flowsOver([
    { id: "a", name: "甲" },
    { id: "b", name: "乙", nodes: [subflowNode("x", "d"), subflowNode("y", "d")] },
    { id: "d", name: "丁" },
  ]);
  assert.deepEqual(await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "b")], edges: [] }), []);
});

test("a subflow with nothing chosen, pointing at a deleted flow, or at a disabled one, each says which", async () => {
  const { svc } = flowsOver([
    { id: "a", name: "甲" },
    { id: "off", name: "停用的", enabled: false },
  ]);
  const none = await checkSubflows(svc, "a", { nodes: [subflowNode("n1")], edges: [] });
  assert.match(none[0].message, /还没选/);

  const gone = await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "nope")], edges: [] });
  assert.match(gone[0].message, /不存在或已删除/);

  const off = await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "off")], edges: [] });
  // An error rather than a warning: triggering this flow would fail at the
  // node, and a graph that cannot run should not save clean.
  assert.equal(off[0].level, "error");
  assert.match(off[0].message, /已停用/);
});

test("the walk reads each flow once, however many nodes point at it", async () => {
  // Replaced a test asserting "an empty graph queries nothing", which mutation
  // testing showed asserts nothing at all: a `for` over an empty array queries
  // nothing whether or not the early return exists. This is the property that
  // is actually load-bearing — `seen` is what stops a diamond from re-reading
  // the same flow, and on a deep graph re-reading is quadratic.
  const seenIds: string[] = [];
  const graphs: Record<string, FlowNode[]> = {
    b: [subflowNode("x", "d"), subflowNode("y", "d"), subflowNode("z", "d")],
    d: [],
  };
  const prisma = {
    flow: {
      findFirst: async ({ where }: { where: { id: string } }) => {
        seenIds.push(where.id);
        if (!(where.id in graphs)) return null;
        return {
          id: where.id,
          name: where.id,
          enabled: true,
          deletedAt: null,
          graphJson: JSON.stringify({ nodes: graphs[where.id], edges: [] } satisfies FlowGraph),
        };
      },
    },
  };
  const svc = new FlowsService(prisma as never, undefined as never);
  assert.deepEqual(await checkSubflows(svc, "a", { nodes: [subflowNode("n1", "b")], edges: [] }), []);

  // `d` is pointed at three times and must be read once. `b` is read twice —
  // once to check it exists, once as the walk's first frontier — which is the
  // shape of the code, not an accident worth pinning tighter than this.
  assert.equal(seenIds.filter((id) => id === "d").length, 1, `d 被读了 ${seenIds.filter((id) => id === "d").length} 次：${seenIds}`);
});

test("getRun returns nodes in actual execution-time order, not alphabetical", async () => {
  // The original bug: the SQL orderBy was [{ nodeId: "asc" }, { iteration: "asc" }],
  // which sorted flow-input AFTER book-capture and script-preprocess even though
  // flow-input always runs first. The execution timeline depends on this order
  // being the real order of occurrence.
  const nodesInDbOrder = [
    row("flow-input", "success", { startedAt: new Date(1_789_173_042_856) }),
    row("script-preprocess", "running", { startedAt: new Date(1_789_173_051_086) }),
    row("book-capture", "success", { startedAt: new Date(1_789_173_043_050) }),
    row("deliver", "pending"), // no startedAt — must trail
  ];
  const runRow = {
    id: "r1",
    flowId: "f1",
    status: "running",
    graphSnapshot: JSON.stringify({ nodes: [], edges: [] }),
    paramsJson: "{}",
    deletedAt: null,
    nodes: nodesInDbOrder,
  };
  const prisma = {
    flowRun: {
      findFirst: async () => ({ ...runRow, flow: { name: "test" } }),
    },
  };
  const svc = new FlowsService(prisma as never, undefined as never);
  const detail = await svc.getRun("r1");
  assert.deepEqual(
    detail.nodes.map((n) => n.nodeId),
    ["flow-input", "book-capture", "script-preprocess", "deliver"],
    "execution timeline must reflect actual start time, with pending rows last",
  );
});
