import "reflect-metadata";
import { test } from "node:test";
import assert from "node:assert/strict";
import { BrowserEventsService } from "./browser-events.service.js";
import { parseQuery } from "./browser-events.controller.js";
import type { PrismaService } from "../prisma/prisma.service.js";
import type { RecordsService } from "../records/records.service.js";

/**
 * 这个模块里「坏了也看不出来」的地方只有几处，测试就钉这几处：
 *
 *  1. **摄入的宽容度**。推送端一次投递、不重试，所以这里每抛一次错就是一条事件
 *     永久消失。最危险的具体形态是「一张坏截图带走整条通知」——那条路径上没有
 *     任何用户可见的症状，日志里也只有对面一行 warn。
 *  2. **`unacknowledged` 的三态**。缺席（都要）折叠成 false（只要已处理的）不会
 *     报错，只会让默认列表少一半内容。
 *  3. **list 与 stats 的 where 必须同源**。分叉了不会崩，只会让表头数字和表格
 *     行数对不上，而那种偏差要盯着看才发现。
 *
 * 一律用假 prisma：被测的是**服务发出的查询**和**它写进去的行**，不是 SQLite
 * 会不会执行过滤。
 */

type Row = Record<string, unknown>;

/** 记录下所有写入与查询条件的假 prisma。 */
function fakes(seed: Row[] = []) {
  const created: Row[] = [];
  const wheres: Row[] = [];
  const saved: Array<{ bytes: Buffer; filename: string; mimeType: string }> = [];

  const prisma = {
    browserEvent: {
      create: async ({ data }: { data: Row }) => {
        const row = { id: `ev${created.length + 1}`, receivedAt: new Date(), deletedAt: null, acknowledgedAt: null, ...data };
        created.push(row);
        return row;
      },
      findMany: async ({ where }: { where: Row }) => {
        wheres.push(where);
        return seed.map((r) => ({ ...r }));
      },
      count: async ({ where }: { where: Row }) => {
        wheres.push(where);
        return seed.length;
      },
      groupBy: async ({ where }: { where: Row }) => {
        wheres.push(where);
        return [{ kind: "captcha_appeared", _count: { _all: seed.length } }];
      },
      findUnique: async ({ where }: { where: { id: string } }) =>
        seed.find((r) => r.id === where.id) ?? null,
      update: async ({ where, data }: { where: { id: string }; data: Row }) => ({
        ...(seed.find((r) => r.id === where.id) ?? {}),
        ...data,
      }),
      delete: async ({ where }: { where: { id: string } }) => seed.find((r) => r.id === where.id),
    },
  } as unknown as PrismaService;

  const records = {
    save: (bytes: Buffer, filename: string, mimeType: string) => {
      saved.push({ bytes, filename, mimeType });
      return { fileName: `abc123-${filename}`, mimeType, size: bytes.length, url: `/api/records/abc123-${filename}` };
    },
  } as unknown as RecordsService;

  return { svc: new BrowserEventsService(prisma, records), created, wheres, saved };
}

const PNG_1PX =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

test("一条完整事件原样落库，截图交给 RecordsService 并存回访问路径", async () => {
  const { svc, created, saved } = fakes();
  await svc.ingest({
    kind: "captcha_appeared",
    tabId: 635522251,
    ts: 1788945715353,
    seq: 76,
    browser: "66b969d0",
    summary: "possible challenge — x",
    detail: { evidence: ["x"] },
    screenshot: PNG_1PX,
  });

  const row = created[0];
  assert.equal(row.kind, "captcha_appeared");
  assert.equal(row.tabId, 635522251);
  assert.equal(row.seq, 76);
  assert.equal(row.browser, "66b969d0");
  // occurredAt 是来源时钟，必须是 ts 本身而不是落库时刻。
  assert.deepEqual(row.occurredAt, new Date(1788945715353));
  // detail 存 JSON 文本、不拆列：拆了就等于作废推送端「加字段不用改接收方」的承诺。
  assert.equal(row.detail, '{"evidence":["x"]}');
  assert.equal(row.screenshotUrl, "/api/records/abc123-captcha_appeared.png");
  assert.equal(row.screenshotName, "abc123-captcha_appeared.png");
  // 真的解了 base64，而不是把 data URL 整个当字节存下去。
  assert.equal(saved.length, 1);
  assert.equal(saved[0].mimeType, "image/png");
  assert.deepEqual(saved[0].bytes.subarray(0, 4), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
});

test("坏截图只丢图，不丢事件", async () => {
  for (const bad of ["data:image/png;base64,@@@not-base64@@@", "https://example.com/a.png", "data:image/png;base64,"]) {
    const { svc, created, saved } = fakes();
    // 不抛：抛出去就是 500，而 500 在这条链路上等于事件永久消失。
    await svc.ingest({ kind: "captcha_appeared", summary: "blocked", screenshot: bad });
    assert.equal(created.length, 1, `事件应仍然落库：${bad}`);
    assert.equal(created[0].screenshotUrl, null);
    assert.equal(created[0].screenshotName, null);
    assert.equal(saved.length, 0, "坏图不该写进 records/");
  }
});

test("缺字段一律给默认值，只有 kind 缺席才拒绝", async () => {
  const { svc, created } = fakes();
  await svc.ingest({ kind: "browser_offline" });
  const row = created[0];
  // -1 是推送端「与 tab 无关」的既定取值；用 0 兜底会伪造出一个真实存在过的 tabId。
  assert.equal(row.tabId, -1);
  assert.equal(row.seq, null);
  assert.equal(row.detail, null);
  assert.equal(row.summary, "browser_offline (无摘要)");
  assert.ok(row.occurredAt instanceof Date);

  await assert.rejects(() => svc.ingest({ summary: "无 kind" }), /kind/);
  await assert.rejects(() => svc.ingest({ kind: "   " }), /kind/);
});

test("tabId 为 0 不能被当成缺席", async () => {
  // 0 是合法 tabId，而 `Number(x) || -1` 这种写法会把它变成 -1。
  const { svc, created } = fakes();
  await svc.ingest({ kind: "captcha_appeared", tabId: 0 });
  assert.equal(created[0].tabId, 0);
});

test("列表默认排除软删行，includeDeleted 才带上", async () => {
  const { svc, wheres } = fakes();
  await svc.list({});
  assert.deepEqual(wheres[0].deletedAt, null);
  wheres.length = 0;
  await svc.list({ includeDeleted: true });
  assert.ok(!("deletedAt" in wheres[0]), "includeDeleted 时不该再有 deletedAt 约束");
});

test("unacknowledged 是三态：缺席 ≠ false", async () => {
  const { svc, wheres } = fakes();
  await svc.list({});
  assert.ok(!("acknowledgedAt" in wheres[0]), "不传时两种都要");
  wheres.length = 0;
  await svc.list({ unacknowledged: true });
  assert.deepEqual(wheres[0].acknowledgedAt, null);
  wheres.length = 0;
  await svc.list({ unacknowledged: false });
  assert.deepEqual(wheres[0].acknowledgedAt, { not: null });
});

test("query string 的 unacknowledged 缺席不会被折叠成 false", () => {
  assert.ok(!("unacknowledged" in parseQuery({})));
  assert.equal(parseQuery({ unacknowledged: "true" }).unacknowledged, true);
  assert.equal(parseQuery({ unacknowledged: "false" }).unacknowledged, false);
  assert.equal(parseQuery({ includeDeleted: "true" }).includeDeleted, true);
  assert.equal(parseQuery({ includeDeleted: undefined }).includeDeleted, false);
  assert.equal(parseQuery({ page: "3", pageSize: "20" }).page, 3);
});

test("搜索同时覆盖 summary 与 detail", async () => {
  const { svc, wheres } = fakes();
  await svc.list({ search: "红色球体" });
  // 题面落在 detail.evidence 里，只搜 summary 会搜不到自己刚看过的那条。
  assert.deepEqual(wheres[0].OR, [
    { summary: { contains: "红色球体" } },
    { detail: { contains: "红色球体" } },
  ]);
});

test("stats 与 list 用同一个 where，筛选一变两边一起变", async () => {
  const { svc, wheres } = fakes();
  await svc.list({ kind: "captcha_appeared", search: "x" });
  const listWhere = wheres[0];
  wheres.length = 0;
  const s = await svc.stats({ kind: "captcha_appeared", search: "x" });
  // stats 打三个查询，第一个是 total 的 count，它的 where 必须与 list 的一致。
  assert.deepEqual(wheres[0], listWhere);
  // unacknowledged 那一路是在共同 where 之上再叠条件，不是另起一套。
  assert.deepEqual(wheres[1], { ...listWhere, acknowledgedAt: null });
  assert.equal(s.byKind[0].kind, "captcha_appeared");
});

test("pageSize 被夹在 1..200，page 最小为 1", async () => {
  const { svc } = fakes();
  assert.equal((await svc.list({ pageSize: 9999 })).pageSize, 200);
  assert.equal((await svc.list({ pageSize: 0 })).pageSize, 50);
  assert.equal((await svc.list({ page: -3 })).page, 1);
  assert.equal((await svc.list({})).pageSize, 50);
});

test("取不到的 id 是 404 而不是 500", async () => {
  const { svc } = fakes([{ id: "ev1", deletedAt: null }]);
  await assert.rejects(() => svc.findById("nope"), /not found/);
  // update 一个不存在的 id 会让 Prisma 抛 P2025 → 500，所以 ack/remove 必须先查。
  await assert.rejects(() => svc.setAcknowledged("nope", true), /not found/);
  await assert.rejects(() => svc.remove("nope"), /not found/);
});

test("重复删除是 no-op，不报错", async () => {
  const deletedAt = new Date("2026-09-09T00:00:00Z");
  const { svc } = fakes([{ id: "ev1", deletedAt }]);
  const row = await svc.remove("ev1");
  assert.deepEqual(row.deletedAt, deletedAt, "已删的行原样返回，不该盖上新的删除时间");
});

test("软删的行仍能按 id 取到详情", async () => {
  // 列表默认藏起它们，但拿着 id 问「这条是什么」时，墓碑不是拒答的理由。
  const { svc } = fakes([{ id: "ev1", deletedAt: new Date(), kind: "captcha_appeared" }]);
  assert.equal((await svc.findById("ev1")).kind, "captcha_appeared");
});
