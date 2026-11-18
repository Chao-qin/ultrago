import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { LlmCallsService } from "./llm-calls.service.js";
import type { PrismaService } from "../prisma/prisma.service.js";

/**
 * 这个模块里「坏了也看不出来」的地方就这几处，测试只钉这几处：
 *
 *  1. **摄入的宽容度**。推送端一次投递、不重试，每抛一次错就是一条日志永久消失。
 *     最要紧的具体形态是**没有 channel 的那条**——「有人把 model 写错了、网关回了
 *     404」正是最该被看见的一类，而那一刻根本还没有 channel。照搬 browser-events
 *     的「kind 必填」会把它挡在门外。
 *  2. **token 缺失必须保持缺失**。补成 0 不会报错，只会把所有均值和总量悄悄拽低，
 *     而 opencode 渠道一个 token 都不报。
 *  3. **list 与 stats 的 where 必须同源**。分叉了不会崩，只会让表头数字和表格行数
 *     对不上，那种偏差要盯着看才发现。
 *  4. **p95 取的是哪一行**。算错索引不会报错，只会给出一个看着合理的错数字。
 *
 * 一律用假 prisma：被测的是**服务发出的查询**和**它写进去的行**，不是 SQLite
 * 会不会执行过滤。
 */

type Row = Record<string, unknown>;

function fakes(latencies: number[] = []) {
  const created: Row[] = [];
  const wheres: Row[] = [];
  const sorted = [...latencies].sort((a, b) => a - b);

  const prisma = {
    llmCall: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `c${created.length + 1}`, receivedAt: new Date(), deletedAt: null, ...data };
        created.push(row);
        return row;
      },
      findMany: async ({ where, skip, take, select }: { where: Row; skip?: number; take?: number; select?: Row }) => {
        wheres.push(where);
        // p95 的那次查询：按 latencyMs 升序 skip 到某一行
        if (select && "latencyMs" in select) {
          return sorted.slice(skip ?? 0, (skip ?? 0) + (take ?? 1)).map((latencyMs) => ({ latencyMs }));
        }
        return [];
      },
      count: async ({ where }: { where: Row }) => {
        wheres.push(where);
        return "latencyMs" in where ? sorted.length : 0;
      },
      aggregate: async () => ({ _sum: { totalTokens: 0 } }),
      groupBy: async () => [],
    },
  } as unknown as PrismaService;

  return { prisma, created, wheres, service: new LlmCallsService(prisma) };
}

test("没有 channel 的调用也要落下来 —— 路由失败才是最该看见的那条", async () => {
  const f = fakes();
  await f.service.ingest({ status: "error", httpStatus: 404, errorMessage: 'unknown model "typo"' });
  assert.equal(f.created.length, 1, "不能因为缺 channel 就拒绝");
  assert.equal(f.created[0].channel, "(unrouted)");
  assert.equal(f.created[0].adapter, "(none)");
  assert.equal(f.created[0].status, "error");
});

test("空 body 也不抛 —— 拒绝一条脏数据等于制造一次数据丢失", async () => {
  const f = fakes();
  await assert.doesNotReject(f.service.ingest({}));
  assert.equal(f.created[0].channel, "(unrouted)");
  assert.equal(f.created[0].status, "ok");
});

test("token 缺失保持 null，绝不补零", async () => {
  const f = fakes();
  // opencode 渠道就是一个 token 都不报。
  await f.service.ingest({ channel: "oc", adapter: "opencode", model: "m" });
  assert.equal(f.created[0].promptTokens, null);
  assert.equal(f.created[0].totalTokens, null);
  // ttfb 同理：非流式调用没有首帧，0 会让 p95 失真。
  assert.equal(f.created[0].ttfbMs, null);
});

test("status 只认 error，拼错的值不该丢掉整条记录", async () => {
  const f = fakes();
  await f.service.ingest({ status: "ERROR" });
  await f.service.ingest({ status: "error" });
  assert.deepEqual(f.created.map((r) => r.status), ["ok", "error"]);
});

test("过长的预览被截断，空串归一成 null", async () => {
  const f = fakes();
  await f.service.ingest({ requestPreview: "x".repeat(9000), responsePreview: "   " });
  assert.equal(String(f.created[0].requestPreview).length, 4001);
  assert.equal(f.created[0].responsePreview, null);
});

test("list 与 stats 用的是同一个 where —— 否则表头和表格迟早对不上", async () => {
  const query = { channel: "local", status: "error", search: "boom", includeDeleted: false };
  const a = fakes();
  await a.service.list(query);
  const b = fakes();
  await b.service.stats(query);
  // list 的第一个 where 与 stats 的第一个 where 必须逐字相同。
  assert.deepEqual(a.wheres[0], b.wheres[0]);
  assert.deepEqual(a.wheres[0], {
    deletedAt: null,
    channel: "local",
    status: "error",
    OR: [
      { requestPreview: { contains: "boom" } },
      { responsePreview: { contains: "boom" } },
      { errorMessage: { contains: "boom" } },
    ],
  });
});

test("since 过滤打在 startedAt 上，不是 receivedAt", async () => {
  const f = fakes();
  await f.service.list({ since: "2026-09-09T00:00:00.000Z" });
  // 问的是"这次调用什么时候发生的"，不是"日志什么时候落的库"——两个时钟能差很远。
  assert.deepEqual(f.wheres[0].startedAt, { gte: new Date("2026-09-09T00:00:00.000Z") });
  assert.equal("receivedAt" in f.wheres[0], false);
});

test("坏日期被忽略而不是让整个查询变空", async () => {
  const f = fakes();
  await f.service.list({ since: "不是日期" });
  assert.equal("startedAt" in f.wheres[0], false);
});

test("since 同样进 stats 的 where —— 否则卡片和列表说的不是同一段时间", async () => {
  const q = { since: "2026-09-09T00:00:00.000Z", channel: "local" };
  const a = fakes(); await a.service.list(q);
  const b = fakes(); await b.service.stats(q);
  assert.deepEqual(a.wheres[0], b.wheres[0]);
});

test("includeDeleted 才放行软删行；默认排除", async () => {
  const on = fakes();
  await on.service.list({ includeDeleted: true });
  assert.equal("deletedAt" in on.wheres[0], false);

  const off = fakes();
  await off.service.list({});
  assert.equal(off.wheres[0].deletedAt, null);
});

test("p95 取的是升序第 95% 那一行，不是均值", async () => {
  // 1..100：p95 应是 95。均值是 50.5——一次 240s 超时就能把它拉成小说。
  const f = fakes(Array.from({ length: 100 }, (_, i) => i + 1));
  const stats = await f.service.stats({});
  assert.equal(stats.p95LatencyMs, 95);
});

test("没有任何一次调用测到延迟时，p95 是 null 而不是 0", async () => {
  const f = fakes([]);
  const stats = await f.service.stats({});
  assert.equal(stats.p95LatencyMs, null);
});

// --- caller / 成本 / 保留策略 -------------------------------------------

/** groupBy 可注入的假 prisma。上面的 fakes() 一律回空表，够不到这几条断言。 */
function groupFakes(groups: Record<string, Row[]>) {
  const wheres: Row[] = [];
  const deletes: Row[] = [];
  const prisma = {
    llmCall: {
      count: async () => 0,
      findMany: async () => [],
      aggregate: async () => ({ _sum: { totalTokens: 0 } }),
      // 同一个 by 会被查两次（一次总量、一次只数 error），靠 where.status 区分。
      // 不区分的话两次拿到同一份数据，errors 就会等于 count。
      groupBy: async ({ by, where }: { by: string[]; where: Row }) => {
        const key = `${by.join(",")}${where.status === "error" ? ":error" : ""}`;
        wheres.push({ by: by.join(","), key, where });
        return groups[key] ?? [];
      },
      deleteMany: async ({ where }: { where: Row }) => {
        deletes.push(where);
        return { count: 3 };
      },
    },
  } as unknown as PrismaService;
  return { wheres, deletes, service: new LlmCallsService(prisma) };
}

test("caller 空串归一成 null —— 「没报」和「报了个空的」是同一件事", async () => {
  const f = fakes();
  await f.service.ingest({ channel: "c", caller: "   " });
  assert.equal(f.created[0].caller, null);

  await f.service.ingest({ channel: "c", caller: "product-preprocess" });
  assert.equal(f.created[1].caller, "product-preprocess");
});

test("成本与 attempt 缺失保持 null —— 0 会让「免费」和「算不出来」变成同一件事", async () => {
  const f = fakes();
  await f.service.ingest({ channel: "oc", adapter: "opencode" });
  assert.equal(f.created[0].costMicros, null);
  assert.equal(f.created[0].costCurrency, null);
  assert.equal(f.created[0].attempt, null);

  await f.service.ingest({ channel: "v", costMicros: 10500, costCurrency: "USD", attempt: 2 });
  assert.equal(f.created[1].costMicros, 10500);
  assert.equal(f.created[1].costCurrency, "USD");
  assert.equal(f.created[1].attempt, 2);
});

test("按 caller 筛进的是同一个 where —— 表头和表格不能各算各的", async () => {
  const f = fakes();
  await f.service.list({ caller: "product-preprocess" });
  assert.equal(f.wheres[0].caller, "product-preprocess");
});

test("花费按货币分开给，绝不合成一个数", async () => {
  const f = groupFakes({
    costCurrency: [
      { costCurrency: "USD", _count: { _all: 2 }, _sum: { costMicros: 10_500 } },
      { costCurrency: "CNY", _count: { _all: 1 }, _sum: { costMicros: 30_000 } },
      // 有成本但渠道单价没填 currency。
      { costCurrency: null, _count: { _all: 1 }, _sum: { costMicros: 7 } },
    ],
  });
  const stats = await f.service.stats({});
  // USD 和 CNY 加起来得到的数看着完全正常，却没有任何意义。
  assert.deepEqual(stats.costByCurrency, [
    { currency: "CNY", costMicros: 30_000, count: 1 },
    { currency: "USD", costMicros: 10_500, count: 2 },
    { currency: "(未标货币)", costMicros: 7, count: 1 },
  ]);

  // 算不出成本的行被排除在外，而不是当成 0 拉低任何一格。
  const currencyQuery = f.wheres.find((w) => w.by === "costCurrency");
  assert.deepEqual((currencyQuery?.where as Row).costMicros, { not: null });
});

test("按调用方分组，没报的落进一个显式的「未标注」", async () => {
  const f = groupFakes({
    caller: [
      { caller: "product-preprocess", _count: { _all: 9 }, _sum: { totalTokens: 900, costMicros: 90 } },
      { caller: null, _count: { _all: 2 }, _sum: { totalTokens: null, costMicros: null } },
    ],
    // 错误是单独 group 一次再合回去的：条件计数塞不进同一个 groupBy。
    "caller:error": [{ caller: "product-preprocess", _count: { _all: 4 } }],
  });
  const stats = await f.service.stats({});
  assert.deepEqual(stats.byCaller, [
    { caller: "product-preprocess", count: 9, errors: 4, totalTokens: 900, costMicros: 90 },
    // null 而不是 0：这一格里没有任何一次调用能算出成本。
    { caller: "(未标注)", count: 2, errors: 0, totalTokens: null, costMicros: null },
  ]);
});

test("保留策略按 startedAt 硬删 —— 留墓碑行一件事都没解决", async () => {
  const f = groupFakes({});
  const before = Date.now();
  assert.equal(await f.service.purgeOlderThan(30), 3);

  const where = f.deletes[0] as { startedAt: { lt: Date } };
  // 按「这次调用什么时候发生的」删，不按落库时间——网关离线补推时两者能差很远。
  assert.ok(where.startedAt.lt instanceof Date);
  const expected = before - 30 * 24 * 60 * 60 * 1000;
  assert.ok(Math.abs(where.startedAt.lt.getTime() - expected) < 5_000);
  // 不是软删：这些行没人再会看，留着只会让表继续长。
  assert.equal("deletedAt" in where, false);
});

test("保留天数 <= 0 是关掉清理，不是删光", async () => {
  const f = groupFakes({});
  assert.equal(await f.service.purgeOlderThan(0), 0);
  assert.equal(await f.service.purgeOlderThan(-1), 0);
  assert.equal(await f.service.purgeOlderThan(Number.NaN), 0);
  assert.equal(f.deletes.length, 0, "一条 deleteMany 都不该发出去");
});
