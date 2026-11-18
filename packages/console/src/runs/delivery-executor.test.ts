import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { matchesConclusion, executeDelivery, normalizeReportPath, renderTemplate, type DeliveryContext } from "./delivery-executor.js";

test("normalizeReportPath accepts nested and dot-prefixed reports while rejecting traversal", () => {
  assert.equal(normalizeReportPath("reports/..report.md"), "..report.md");
  assert.equal(normalizeReportPath("子目录\\商品.json"), "子目录/商品.json");
  for (const file of ["../outside.md", "reports/../../outside.md", "reports/."])
    assert.throws(() => normalizeReportPath(file), /escapes reports/);
});

const ctx: DeliveryContext = {
  runId: "run_1",
  planId: "plan_1",
  bookName: "baidu-hot-search",
  status: "success",
  ranSteps: 3,
  totalSteps: 3,
  durationMs: 100,
  outputs: "hello markdown",
};

test("matchesConclusion: on×status 分流", () => {
  assert.equal(matchesConclusion("success", "success"), true);
  assert.equal(matchesConclusion("success", "failed"), false);
  assert.equal(matchesConclusion("failure", "escalated"), true);
  assert.equal(matchesConclusion("failure", "failed"), true);
  assert.equal(matchesConclusion("cancelled", "cancelled"), true);
  assert.equal(matchesConclusion("any", "cancelled"), true);
});

test("executeDelivery: on 不匹配 → skipped", async () => {
  const r = await executeDelivery({ kind: "print", on: "failure", format: "markdown" }, ctx, 0);
  assert.equal(r.status, "skipped");
});

test("executeDelivery: print 渲染 outputs string → ok", async () => {
  const r = await executeDelivery({ kind: "print", on: "success", format: "markdown" }, ctx, 0);
  assert.equal(r.status, "ok");
  assert.equal(r.detail, "hello markdown");
});

test("executeDelivery: print 无 outputs → ok(undefined detail)", async () => {
  const r = await executeDelivery(
    { kind: "print", on: "success", format: "markdown" },
    { ...ctx, outputs: undefined },
    0,
  );
  assert.equal(r.status, "ok");
  assert.equal(r.detail, undefined);
});

test("executeDelivery: print renders scalar and message templates use outputs", async () => {
  const print = await executeDelivery(
    { kind: "print", on: "success", format: "text" },
    { ...ctx, outputs: 42 },
    0,
  );
  assert.equal(print.detail, "42");
  assert.equal(renderTemplate("value={{outputs.value}}", { ...ctx, outputs: { value: "ok" } }), "value=ok");
});

test("executeDelivery: file 只认这次运行自己写的文件", async () => {
  // The ownership half of verifyFile, and the reason the deleted Artifact
  // table's contents had to move rather than disappear: a stale same-named file
  // from an earlier run must NOT be reported as this run's delivery. Asserted
  // on the error message so removing the check turns this red rather than
  // leaving it green on a filesystem that happens to have the file.
  const r = await executeDelivery({ kind: "file", artifact: "not-mine.json", on: "success" }, { ...ctx, artifacts: [] }, 0);
  assert.equal(r.status, "error");
  assert.match(r.detail ?? "", /not owned by this run/);
});

test("delivery-executor 不持有 WeclawManager(per-process 生命周期面)", () => {
  // getManager() is a module-level singleton. The console's copy would report
  // phase "stopped" / pid null for a daemon the BACKEND process owns and is
  // happily running, while the account/version fields of the same object stay
  // correct and make the lie look checked. Nothing catches that at runtime —
  // the console only touches the process-agnostic half today — so the guard is
  // structural. Mutation check: restore the `getManager as getWeclawManager`
  // import and this goes red.
  const src = readFileSync(new URL("./delivery-executor.ts", import.meta.url), "utf8");
  // Comments stripped first: the import is accompanied by a note explaining why
  // it is NOT getManager(), and matching the bare identifier would fire on that
  // prose — a guard that fails because of the sentence describing it.
  const code = src.replace(/^\s*(\/\/|\*|\/\*).*$/gm, "");
  assert.doesNotMatch(code, /getManager/, "console must not hold a WeclawManager — see the getManager() doc in weclaw-manager.ts");
});

test("executeDelivery: webhook body carries the run id", async () => {
  // Asserted on the BODY a receiver actually gets, because nothing else could
  // see this break: runId was an optional positional arg (so dropping it
  // typechecks), and the delivery's success path only reads res.ok, which says
  // nothing about what was posted. That is how dfc88a3 shipped webhooks with no
  // runId and stayed green.
  //
  // 203.0.113.1 is RFC 5737 TEST-NET-3: public enough to clear
  // assertSafeWebhookUrl, and an IP literal so `isIP` short-circuits the DNS
  // lookup — no network. A localhost receiver is impossible by design here; the
  // SSRF guard rejects loopback, which is why fetch is stubbed instead.
  const realFetch = globalThis.fetch;
  let sent: Record<string, unknown> | undefined;
  globalThis.fetch = (async (_url: unknown, init: { body: string }) => {
    sent = JSON.parse(init.body);
    return new Response(null, { status: 204 });
  }) as unknown as typeof fetch;
  try {
    const r = await executeDelivery(
      { kind: "webhook", url: "http://203.0.113.1/hook", method: "POST", on: "success" },
      ctx,
      0,
    );
    assert.equal(r.status, "ok");
    assert.equal(sent?.runId, "run_1");
  } finally {
    globalThis.fetch = realFetch;
  }
});
