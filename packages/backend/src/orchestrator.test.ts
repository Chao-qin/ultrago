import { test } from "node:test";
import assert from "node:assert/strict";
import type { PageState } from "@bcp/shared";
import { PlanRunner, normalizeRenderedText, type EvidenceReader } from "./orchestrator.js";

/** A settled page — textPresent refuses to judge an un-hydrated one. */
const settledPage = { url: "https://x/y", loading: false } as unknown as PageState;

// Minimal evidence mock. finishClaimed never touches evidence, and a
// `settled`-only step avoids readNetwork — only captureBaseline's
// networkBodies() is hit during create().
const evidence = {
  pageState: async () => {
    throw new Error("unused");
  },
  readContent: async () => ({ text: "" }),
  readNetwork: async () => ({ requests: [] }),
  snapshot: async () => ({ elements: [] }),
  evalJs: async () => ({ value: undefined }),
  setNetworkCapture: async () => {},
  networkBodies: () => ({ bodies: [], maxSeq: 0 }),
  screenshot: async () => ({ dataUrl: "" }),
  targetAvailable: () => true,
  waitSignal: async () => ({ satisfied: true }),
} satisfies EvidenceReader;

test("finishClaimed: exactly-once — true then always false", async () => {
  const runner = new PlanRunner(evidence);
  const { planId } = await runner.create("g", [{ goal: "s1", verify: { settled: true } }]);

  assert.equal(runner.finishClaimed(planId), true, "first claim succeeds");
  assert.equal(runner.finishClaimed(planId), false, "second claim is refused");
  assert.equal(runner.finishClaimed(planId), false, "third claim is refused");
});

test("finishClaimed: unknown planId returns true (resume can't reach it, so one fire is safe)", () => {
  const runner = new PlanRunner(evidence);
  assert.equal(runner.finishClaimed("plan_ghost"), true);
});

test("finishClaimed: independent plans don't share the flag", async () => {
  const runner = new PlanRunner(evidence);
  const a = await runner.create("a", [{ goal: "a1", verify: { settled: true } }]);
  const b = await runner.create("b", [{ goal: "b1", verify: { settled: true } }]);

  assert.equal(runner.finishClaimed(a.planId), true);
  assert.equal(runner.finishClaimed(b.planId), true, "a different plan still claims independently");
  assert.equal(runner.finishClaimed(a.planId), false);
});

test("advance: successful terminal close does not inspect the closed tab", async () => {
  const terminalEvidence = { ...evidence, targetAvailable: () => false } satisfies EvidenceReader;
  const runner = new PlanRunner(terminalEvidence);
  const { planId } = await runner.create("g", [{
    goal: "close",
    verify: { settled: true },
    action: { method: "browser.closeTab", params: {} },
  }]);
  runner.noteAction({ method: "browser.closeTab", params: {} }, { closed: true });
  const result = await runner.advance(planId);
  assert.equal(result.kind, "complete");
});

test("evalCheck 验证不算作这一步的动作 —— 出参步必须留在 results 里", async () => {
  // 真实事故：书的【最后一步】产出 outputSchema 声明的执行状态 + 商品链接，
  // 却从不出现在 results 里，run_playbook 于是把中间某一步当成「最后结果」返回。
  // 根因是 evalCheck 形式的 verify 本身就是一次 browser.eval RPC，被记成了第二个动作，
  // 而 results 只保留「恰好一个动作」的步。验证是观察，不是动作。
  const runner = new PlanRunner({
    ...evidence,
    // verify 期间的 evalJs 会经由同一条 RPC 通道回灌 noteAction
    evalJs: async () => {
      runner.noteAction({ method: "browser.eval", params: { code: "verify" } }, true);
      return { value: true };
    },
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{
    goal: "回执：产出商品 ID 与链接",
    verify: { evalCheck: { code: "1" } },
    action: { method: "browser.eval", params: { code: "output" } },
  }]);
  const output = { ok: true, productId: "3840460211819249884", status: "待提交" };
  runner.noteAction({ method: "browser.eval", params: { code: "output" } }, output);

  const result = await runner.advance(planId);
  assert.equal(result.kind, "complete");
  const results = runner.getResults(planId);
  assert.equal(results.length, 1, "出参步必须进 results");
  assert.deepEqual(results[0].value, output, "留下的必须是动作的值，不是 verify 的 true");

  // trace 是排障用的，跟 results 相反：两条都要留下，但必须能分辨哪条是取证。
  const trace = runner.getTrace(planId);
  assert.equal(trace.length, 2, "动作和 verify 的 eval 都要进 trace");
  assert.equal(trace[0].phase, undefined, "动作不带 phase");
  assert.equal(trace[1].phase, "verify", "verify 的 eval 必须标出来，否则排障时分不清");
});

// ── evalCheck 只读 / evalUntil 可动手 ──────────────────────────────────
// evalCheck 是证据，页面侧以只读方式执行（readOnly: true 交给 bcpReadOnlyGuard）；
// evalUntil 明确允许动手，必须以非只读方式执行，并且排在所有判据之后 —— 其余判据
// 读的是它动手之前的页面。两个字段的 readOnly 标志一旦传反，一个会把证据变成动作，
// 另一个会把内置剧本的推进循环全部拦死。
test("evalCheck 以只读方式求值，evalUntil 可动手且最后执行", async () => {
  const calls: Array<{ code: string; readOnly: boolean }> = [];
  const runner = new PlanRunner({
    ...evidence,
    evalJs: async (_planId, code, readOnly) => {
      calls.push({ code, readOnly });
      return { value: true };
    },
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{
    goal: "s",
    verify: { evalUntil: { code: "act()" }, evalCheck: { code: "read()" } },
  }]);
  const result = await runner.advance(planId);
  assert.equal(result.kind, "complete");
  assert.deepEqual(calls, [
    { code: "read()", readOnly: true },
    { code: "act()", readOnly: false },
  ]);
});

test("evalUntil 不成立时报出字段名，并按 onFail 重试", async () => {
  let round = 0;
  const runner = new PlanRunner({
    ...evidence,
    evalJs: async () => ({ value: ++round >= 2 }),
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "s", verify: { evalUntil: { code: "step()" } }, onFail: "retry", maxRetries: 3 }]);
  const first = await runner.advance(planId);
  assert.equal(first.kind, "retry");
  assert.match(JSON.stringify(first), /evalUntil failed/);
  assert.equal((await runner.advance(planId)).kind, "complete");
});

test("只有 evalUntil 的 verify 是有效判据，空 code 不是", async () => {
  const runner = new PlanRunner(evidence);
  await assert.doesNotReject(runner.create("g", [{ goal: "s", verify: { evalUntil: { code: "x()" } } }]));
  await assert.rejects(runner.create("g", [{ goal: "s", verify: { evalUntil: { code: " " } } }]));
});

// ── textPresent 的归一化 ────────────────────────────────────────────────
// 真实事故（2026-09-14）：doudian-image-text-publish step 12 把正文 paste 进抖店的
// editor-kit 编辑器，内容一字不差地落地了，它自己的 verify.textPresent 却报
// "not present"，21 步的 book 每次都挂在这一步。根因不在页面：editor-kit 把换行
// 存成零宽字符 U+200B，而 verify 拿含 "\n" 的原文做裸 includes。同一本 book 的
// step 11 和 step 16 早就各自手写了 .replace(/\u200b/g,'') —— 三处认知，两对一错。

test("normalizeRenderedText: 零宽字符与换行归一到同一形态", () => {
  assert.equal(normalizeRenderedText("a\n\nb"), "a b", "换行折叠成单空格");
  assert.equal(normalizeRenderedText("a\u200b\u200bb"), "a b", "零宽字符等价于换行");
  assert.equal(
    normalizeRenderedText("a\n\nb"),
    normalizeRenderedText("a\u200b\u200bb"),
    "作者写的换行与编辑器存的零宽字符必须比得上",
  );
  assert.equal(normalizeRenderedText("  a \t b  "), "a b", "多余空白折叠并去首尾");
  assert.equal(normalizeRenderedText(" \u200b \ufeff "), "", "全是空白/零宽 → 空串");
  assert.equal(normalizeRenderedText("干净文本"), "干净文本", "正常文本原样通过");
});

test("verify.textPresent: 编辑器把换行存成零宽字符时，多行正文仍算落地", async () => {
  const body = "第一段。\n\n第二段。\n· 列表项";
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    // 页面读回来的就是 editor-kit 的形态：换行位置是 U+200B
    readContent: async () => ({ text: "页面其他内容 第一段。\u200b\u200b第二段。\u200b· 列表项 页脚" }),
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "paste body", verify: { textPresent: body } }]);

  const result = await runner.advance(planId);
  assert.equal(result.kind, "complete", "内容确实在页面上，就不该判失败");
});

test("verify.elementName: 关着的菜单的分组容器不是控件，它拼起来的文字不能顶替一个叫这个名字的元素", async () => {
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    snapshot: async () => ({ elements: [{ ref: "e1", tag: "ul", role: "generic", name: "北京 上海 保存成功", container: true, hiddenGroup: true, hidden: true }] }),
  } as unknown as EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "save", verify: { elementName: "保存成功" } }]);
  const result = await runner.advance(planId);
  assert.notEqual(result.kind, "complete", "页面上没有叫「保存成功」的元素");
});

test("verify.textPresent: 归一化不放水 —— 页面真没有的文本照样失败", async () => {
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    readContent: async () => ({ text: "第一段。\u200b\u200b第二段。" }),
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "paste body", verify: { textPresent: "第三段。" } }]);

  const result = await runner.advance(planId);
  assert.notEqual(result.kind, "complete", "不在页面上的文本必须判失败");
});

test("verify.textPresent: 只有空白/零宽的期望不得变成永真", async () => {
  // includes("") 恒为 true —— 归一化后如果期望塌成空串，就成了一次
  // 什么都没证明的「✓ 已验证」。这比失败更危险（skill §7）。
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    readContent: async () => ({ text: "随便什么内容" }),
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "vacuous", verify: { textPresent: "\u200b" } }]);

  const result = await runner.advance(planId);
  assert.notEqual(result.kind, "complete", "空期望必须失败，不能永真通过");
});

test("verify.textAbsent: 零宽形态下「本该消失的文本」不能蒙混过关", async () => {
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    readContent: async () => ({ text: "旧文案\u200b还在这里" }),
  } satisfies EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "cleared", verify: { textAbsent: "旧文案\n还在这里" } }]);

  const result = await runner.advance(planId);
  assert.notEqual(result.kind, "complete", "文本还在页面上，textAbsent 必须失败");
});


test("asOneAction：组合动作内部的多次调用只记成这一步的一个动作", async () => {
  const runner = new PlanRunner({ ...evidence, pageState: async () => settledPage });
  const { planId } = await runner.create("g", [{ goal: "pick", verify: { settled: true } }, { goal: "next", verify: { settled: true } }]);
  assert.equal(runner.inComposite, false);
  const value = await runner.asOneAction({ method: "local.pickOption", params: { option: "北京" } }, async () => {
    assert.equal(runner.inComposite, true, "控制台通道靠它跳过内部调用");
    runner.noteAction({ method: "browser.click", params: { ref: "e0" } }, { ok: true });
    runner.noteAction({ method: "browser.click", params: { ref: "e7" } }, { ok: true });
    return { picked: "北京" };
  });
  assert.deepEqual(value, { picked: "北京" });
  assert.equal(runner.inComposite, false);
  await runner.advance(planId);
  assert.deepEqual(runner.getResults(planId).map((r) => r.method), ["local.pickOption"]);
});

test("同时声明 visualAssert 和 assert 时，两条都交给 agent 判断", async () => {
  const runner = new PlanRunner({ ...evidence, pageState: async () => settledPage, screenshot: async () => ({ dataUrl: "data:image/png;base64,AA" }) });
  const { planId } = await runner.create("g", [{ goal: "s", verify: { settled: true, visualAssert: "图片正常", assert: "标题已更新" } }]);
  const r = await runner.advance(planId);
  assert.equal(r.kind, "judgeVisual");
  assert.match((r as { claim: string }).claim, /图片正常.*标题已更新/);
});

test("verify.networkOk.bodyIncludes：响应体必须来自成功的那类响应 —— 同地址的 GET 200 加上 POST 500 的报错体不算保存成功", async () => {
  let phase: "before" | "after" = "before";
  const runner = new PlanRunner({
    ...evidence,
    pageState: async () => settledPage,
    readNetwork: async () => ({
      requests: phase === "before" ? [] : [
        { url: "https://x/api/save", status: 200, ts: 10 },
        { url: "https://x/api/save", status: 500, ts: 11 },
      ],
    }),
    networkBodies: () => ({ bodies: phase === "before" ? [] : [{ url: "https://x/api/save", status: 500, body: '{"msg":"保存成功?不,失败"}' }], maxSeq: phase === "before" ? 0 : 1 }),
  } as unknown as EvidenceReader);
  const { planId } = await runner.create("g", [{ goal: "save", verify: { networkOk: { urlIncludes: "/api/save", bodyIncludes: "保存成功" } } }]);
  phase = "after";
  const result = await runner.advance(planId);
  assert.notEqual(result.kind, "complete", "500 的响应体不能证明保存成功");
});
