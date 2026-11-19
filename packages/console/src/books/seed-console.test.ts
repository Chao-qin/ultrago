import { test } from "node:test";
import assert from "node:assert/strict";
// @ts-expect-error — plain ESM script outside the package, imported for its exported helpers.
import { seedConsole, seedPlan, SEEDED_FLOWS } from "../../../../scripts/seed-console.mjs";

test("首次启动（空库）补齐契约与两个内置流程，并索引剧本", () => {
  const plan = seedPlan({ schemaCount: 0, flowNames: [] });
  assert.deepEqual(plan.map((s: { label: string }) => s.label), ["注册契约", "索引剧本", ...SEEDED_FLOWS.map((f: { name: string }) => `同步流程「${f.name}」`)]);
});

test("已有的契约和流程不再覆盖（用户在工作台里的修改保留），只重新索引剧本", () => {
  const plan = seedPlan({ schemaCount: 12, flowNames: SEEDED_FLOWS.map((f: { name: string }) => f.name) });
  assert.deepEqual(plan.map((s: { label: string }) => s.label), ["索引剧本"]);
});

test("seedConsole 按工作台现状执行，并报告失败步骤", async () => {
  const original = globalThis.fetch;
  const hits: string[] = [];
  globalThis.fetch = (async (url: string, init?: { method?: string }) => {
    hits.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
    const { pathname, searchParams } = new URL(url);
    if (pathname === "/api/schemas") {
      assert.equal(searchParams.get("includeInactive"), "true", "停用的契约也算已有");
      return new Response(JSON.stringify([{ name: "s" }]));
    }
    if (pathname === "/api/flows") {
      assert.equal(searchParams.get("includeDeleted"), "true", "用户删掉的流程不该被每次启动重建");
      return new Response(JSON.stringify(SEEDED_FLOWS.map((f: { name: string }) => ({ name: f.name }))));
    }
    return new Response("{}", { status: 500 });
  }) as typeof fetch;
  try {
    const lines: string[] = [];
    const r = await seedConsole("http://console.test", { log: (l: string) => lines.push(l) });
    assert.deepEqual(hits, ["GET /api/schemas", "GET /api/flows", "POST /api/books/rescan"]);
    assert.equal(r.failed, 1);
    assert.match(lines.join("\n"), /索引剧本：失败（HTTP 500）/);
  } finally {
    globalThis.fetch = original;
  }
});
