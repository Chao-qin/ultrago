import { test } from "node:test";
import assert from "node:assert/strict";
import type { BookPageDefinition, PageState, PlanStep, SignalCondition } from "@bcp/shared";
import { PlanRunner, type EvidenceReader } from "./orchestrator.js";
import { runAutoPlayback, type CallFn } from "./playback.js";
import { RunBrowserContext } from "./run-browser-context.js";

const pages: Record<string, BookPageDefinition> = {
  source1688: {
    signals: {
      pageReady: { condition: { selector: "#app" } },
      productCaptured: { condition: { textPresent: "done" }, timeoutMs: 15_000 },
    },
  },
  doudian: {
    signals: {
      formReady: { condition: { settled: true }, timeoutMs: 5_000 },
    },
  },
};

const settledPageState: PageState = {
  url: "https://example.com",
  title: "",
  readyState: "complete",
  loading: false,
  interactableCount: 1,
  scroll: { y: 0, height: 100, viewport: 800, moreBelow: false, moreAbove: false },
  focus: { focused: false },
  forms: { controls: 1, filled: 0, emptyRequired: 0, invalid: 0, dirty: 0 },
  dialogs: 0,
  scrollLocked: false,
  overlay: false,
  busy: 0,
  errorCount: 0,
  tabId: 404,
  active: false,
};

/** Evidence mock that records every waitSignal call. */
function makeEvidence(opts?: {
  waitSignal?: (
    planId: string,
    page: string,
    condition: SignalCondition,
    timeoutMs: number,
  ) => Promise<{ satisfied: boolean; timedOut?: boolean; failedPaths?: string[]; blocked?: string; url?: string }>;
  pageStateCalls?: Array<string | undefined>;
}) {
  const waits: Array<{ page: string; condition: SignalCondition; timeoutMs: number }> = [];
  const pageStates: Array<string | undefined> = opts?.pageStateCalls ?? [];
  const evidence: EvidenceReader = {
    pageState: async (_planId, page) => {
      pageStates.push(page);
      return settledPageState;
    },
    readContent: async () => ({ text: "done" }),
    readNetwork: async () => ({ requests: [] }),
    snapshot: async () => ({ elements: [] }),
    evalJs: async () => ({ value: true }),
    setNetworkCapture: async () => {},
    networkBodies: () => ({ bodies: [], maxSeq: 0 }),
    screenshot: async () => ({ dataUrl: "" }),
    targetAvailable: () => true,
    waitSignal: async (planId, page, condition, timeoutMs) => {
      waits.push({ page, condition, timeoutMs });
      return opts?.waitSignal ? opts.waitSignal(planId, page, condition, timeoutMs) : { satisfied: true };
    },
  };
  return { evidence, waits, pageStates };
}

const openStep: PlanStep = {
  goal: "在独立窗口打开 1688 详情页",
  page: "source1688",
  verify: { settled: true },
  action: { method: "browser.newWindow", params: { url: "https://offer.1688.com/1" } },
};

test("gate: 当前 step 的 gate 在 action 前被等待,并解析到其页面的信号定义", async () => {
  const { evidence, waits } = makeEvidence();
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    { goal: "采集", page: "source1688", verify: { settled: true }, gate: { all: ["productCaptured"] }, action: { method: "browser.eval", params: { code: "collect()" } } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  const calls: string[] = [];
  const call: CallFn = async (method, _p, _prior, opts) => {
    calls.push(`${opts?.page ?? "-"}:${method}`);
    if (method === "browser.newWindow") return { tabId: 404, url: "https://offer.1688.com/1" };
    if (method === "browser.eval") return { value: 1 };
    return {};
  };
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "complete", "auto playback completes");
  assert.equal(waits.length, 1, "gate awaited exactly once");
  assert.equal(waits[0].page, "source1688", "local ref resolves against the step's page");
  assert.deepEqual(waits[0].condition, { textPresent: "done" }, "the signal's declared condition is what waits");
  assert.equal(waits[0].timeoutMs, 15_000, "the signal's timeoutMs is used");
  // The gate wait precedes the action: the eval call is recorded AFTER the wait.
  const evalIndex = calls.findIndex((c) => c.includes("browser.eval"));
  assert.ok(waits.length === 1, "gate happened");
  assert.ok(evalIndex > 0, `action ran after the gate (calls: ${calls.join(", ")})`);
});

test("gate: cross-page all gate 并发等待两个页面 tab", async () => {
  const { evidence, waits } = makeEvidence();
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    {
      goal: "同步采集",
      page: "source1688",
      verify: { settled: true },
      gate: {
        all: [
          { page: "source1688", signal: "productCaptured" },
          { page: "doudian", signal: "formReady" },
        ],
      },
      action: { method: "browser.eval", params: { code: "sync()" } },
    },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  // Concurrency probe: track the max number of in-flight waits.
  let inFlight = 0;
  let peak = 0;
  const { evidence: concurrent } = makeEvidence({
    waitSignal: async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return { satisfied: true };
    },
  });
  const runner2 = new PlanRunner(concurrent);
  const { planId: planId2 } = await runner2.create("g", steps, undefined, undefined, pages);
  const call: CallFn = async (method) => (method === "browser.newWindow" ? { tabId: 404, url: "x" } : { value: 1 });
  await runAutoPlayback(runner2, planId2, call, steps, { context: new RunBrowserContext() });
  assert.equal(waits.length, 0); // silence unused
  assert.equal(peak, 2, "both pages waited concurrently");
});

test("gate: 超时返回诊断,action 不被执行,onFail/maxRetries 不消耗", async () => {
  let waitCalls = 0;
  const { evidence } = makeEvidence({
    waitSignal: async () => {
      waitCalls++;
      return { satisfied: false, timedOut: true, failedPaths: ["condition.textPresent"] };
    },
  });
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    { goal: "采集", page: "source1688", verify: { settled: true }, onFail: "retry", maxRetries: 3, gate: { all: ["productCaptured"] }, action: { method: "browser.eval", params: { code: "collect()" } } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  let evals = 0;
  const call: CallFn = async (method) => {
    if (method === "browser.newWindow") return { tabId: 404, url: "x" };
    if (method === "browser.eval") evals++;
    return {};
  };
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "escalate", "gate timeout escalates");
  assert.ok(result.failed.join("; ").includes("gate source1688.productCaptured"), `diagnostic names the gate: ${result.failed.join("; ")}`);
  assert.equal(evals, 0, "the gated action never executed");
  assert.equal(waitCalls, 1, "the gate was NOT retried via maxRetries (readiness is not an action failure)");
});

test("gate: check-only step(无 action 有 gate)等待后推进", async () => {
  const { evidence, waits } = makeEvidence();
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    { goal: "等采集完成", page: "source1688", verify: { settled: true }, gate: { all: ["productCaptured"] } },
    { goal: "收尾", page: "source1688", verify: { settled: true }, gate: { all: ["pageReady"] }, action: { method: "browser.closeTab", params: {} } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  const call: CallFn = async (method, _p, _prior, opts) => {
    if (method === "browser.newWindow") return { tabId: 404, url: "x" };
    if (method === "browser.closeTab") {
      // 关闭后 targetAvailable 变 false,让 verify 的 targetClosedByAction 分支通过
      return { closed: true };
    }
    return {};
  };
  const context = new RunBrowserContext();
  const result = await runAutoPlayback(runner, planId, call, steps, { context });
  assert.equal(result.kind, "complete", "check-only signal-wait step advances");
  assert.equal(waits.length, 2, "both gates awaited (check-only + pre-action)");
});

test("gate: verify 的证据读取路由到与 action 相同的逻辑页", async () => {
  const pageStateCalls: Array<string | undefined> = [];
  const { evidence, waits } = makeEvidence();
  const runner = new PlanRunner({ ...evidence, pageState: async (_planId, page) => { pageStateCalls.push(page); return settledPageState; } });
  const steps: PlanStep[] = [
    openStep,
    { goal: "采集", page: "source1688", verify: { settled: true }, gate: { all: ["pageReady"] }, action: { method: "browser.eval", params: { code: "collect()" } } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  const call: CallFn = async (method) => (method === "browser.newWindow" ? { tabId: 404, url: "x" } : { value: 1 });
  await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.ok(pageStateCalls.every((p) => p === "source1688"), `all verify pageState reads routed to the step's page (got ${JSON.stringify(pageStateCalls)})`);
  assert.equal(waits.length, 1);
});

test("gate: 未知页/未知信号在 create 时被拒绝(校验时 fail closed)", async () => {
  const { evidence } = makeEvidence();
  const runner = new PlanRunner(evidence);
  const badPage: PlanStep[] = [
    openStep,
    { goal: "x", page: "ghost", verify: { settled: true }, gate: { all: ["pageReady"] }, action: { method: "browser.eval", params: { code: "1" } } },
  ];
  await assert.rejects(() => runner.create("g", badPage, undefined, undefined, pages), /unknown page/);
  const badSignal: PlanStep[] = [
    openStep,
    { goal: "x", page: "source1688", verify: { settled: true }, gate: { all: ["nope"] }, action: { method: "browser.eval", params: { code: "1" } } },
  ];
  await assert.rejects(() => runner.create("g", badSignal, undefined, undefined, pages), /unknown signal/);
  // 有 gate 但没 pages(非 v2 计划路径)也是硬错误。
  await assert.rejects(
    () => runner.create("g", [{ goal: "x", verify: { settled: true }, gate: { all: ["pageReady"] } }]),
    /no book pages/,
  );
});

test("gate: 页面阶段过渡——页面随步骤变化,每步的 gate 等待该步执行时刻的阶段信号", async () => {
  // 模拟 1688-random 的 首页 → 搜索结果页 → 详情页 过渡:同一个逻辑页
  // source1688 在运行中经历多个 URL 阶段,每个 step 引用它执行时刻需要
  // 的信号,而不是一本书只有一个固定的"就绪条件"。
  const stagePages: Record<string, BookPageDefinition> = {
    source1688: {
      signals: {
        homeReady: { condition: { urlIncludes: "www.1688.com" } },
        searchResultReady: { condition: { urlIncludes: "s.1688.com/selloffer" } },
        pageHydrated: { condition: { urlIncludes: "detail.1688.com/offer" } },
      },
    },
  };
  let url = "https://www.1688.com/";
  const gateCalls: Array<{ signal: string; url: string; satisfied: boolean }> = [];
  const { evidence } = makeEvidence({
    waitSignal: async (_planId, page, condition, _timeoutMs) => {
      const cond = condition as { urlIncludes?: string };
      const satisfied = cond.urlIncludes ? url.includes(cond.urlIncludes) : true;
      gateCalls.push({ signal: page, url, satisfied });
      return { satisfied, timedOut: !satisfied, url };
    },
  });
  // pageState 必须反映"当前"URL,否则 verify 的 urlIncludes 会误判。
  const stageEvidence: EvidenceReader = {
    ...evidence,
    pageState: async () => ({ ...settledPageState, url }),
  };
  const runner = new PlanRunner(stageEvidence);
  const steps: PlanStep[] = [
    { goal: "开首页", page: "source1688", verify: { settled: true }, action: { method: "browser.newWindow", params: { url: "https://www.1688.com/" } } },
    { goal: "选类目跳搜索", page: "source1688", verify: { urlIncludes: "s.1688.com/selloffer" }, gate: { all: ["homeReady"] }, action: { method: "browser.eval", params: { code: "nav()" } } },
    { goal: "选商品跳详情", page: "source1688", verify: { urlIncludes: "detail.1688.com/offer" }, gate: { all: ["searchResultReady"] }, action: { method: "browser.eval", params: { code: "pick()" } } },
    { goal: "等标题初始化", page: "source1688", verify: { settled: true }, gate: { all: ["pageHydrated"] }, action: { method: "browser.eval", params: { code: "init()" } } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, stagePages);
  const call: CallFn = async (method) => {
    if (method === "browser.newWindow") return { tabId: 404, url };
    if (method === "browser.eval") {
      // 模拟导航:第一个 eval 后进入搜索结果页,第二个进入详情页。
      if (url.includes("www.1688.com")) url = "https://s.1688.com/selloffer/offer_search.htm?keywords=摆件";
      else if (url.includes("s.1688.com")) url = "https://detail.1688.com/offer/123.html";
      return { value: 1 };
    }
    return {};
  };
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "complete", "跨页面阶段过渡的 book 完整跑通");
  assert.equal(gateCalls.length, 3, "三个过渡步骤的 gate 各等待一次");
  // 关键断言:每步的 gate 在"该步执行时刻的页面状态"上判定,信号随页面变化而不同。
  assert.ok(gateCalls[0].satisfied && gateCalls[0].url.includes("www.1688.com"), "step1 gate: 首页阶段,homeReady 满足");
  assert.ok(gateCalls[1].satisfied && gateCalls[1].url.includes("s.1688.com"), "step2 gate: 页面已变到搜索结果页,searchResultReady 满足");
  assert.ok(gateCalls[2].satisfied && gateCalls[2].url.includes("detail.1688.com"), "step3 gate: 页面已变到详情页,pageHydrated 满足");
});

test("after: action 之后 verify 之前被等待(顺序与 gate 相反的那一半)", async () => {
  const order: string[] = [];
  const { evidence } = makeEvidence({
    waitSignal: async (_planId, _page, condition) => {
      order.push(`wait:${JSON.stringify(condition)}`);
      return { satisfied: true };
    },
  });
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    {
      goal: "点保存并等回执",
      page: "source1688",
      verify: { settled: true },
      gate: { all: ["pageReady"] },
      after: { all: ["productCaptured"] },
      action: { method: "browser.click", params: { text: "保存" } },
    },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  const call: CallFn = async (method) => {
    if (method === "browser.newWindow") return { tabId: 404, url: "x" };
    if (method === "browser.click") order.push("action");
    return {};
  };
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "complete");
  // pageReady(gate) → action → productCaptured(after). The middle position is
  // the whole point: verify is an instant check and cannot wait for a click's
  // consequence, which is why that wait previously had to live inside eval.
  const idxGate = order.indexOf('wait:{"selector":"#app"}');
  const idxAction = order.indexOf("action");
  const idxAfter = order.indexOf('wait:{"textPresent":"done"}');
  assert.ok(idxGate >= 0 && idxAction >= 0 && idxAfter >= 0, `all three observed: ${order.join(" → ")}`);
  assert.ok(idxGate < idxAction, "gate waits BEFORE the action");
  assert.ok(idxAction < idxAfter, "after waits AFTER the action");
});

test("after: 超时算这一步失败——消耗 onFail/maxRetries(与 gate 超时相反)", async () => {
  let afterWaits = 0;
  const { evidence } = makeEvidence({
    waitSignal: async (_planId, _page, condition) => {
      // pageReady (the gate) is satisfied; the consequence signal never lands.
      if (JSON.stringify(condition).includes("selector")) return { satisfied: true };
      afterWaits++;
      return { satisfied: false, timedOut: true, failedPaths: ["condition.textPresent"] };
    },
  });
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    {
      goal: "点保存并等回执",
      page: "source1688",
      verify: { settled: true },
      onFail: "retry",
      maxRetries: 3,
      gate: { all: ["pageReady"] },
      after: { all: ["productCaptured"] },
      action: { method: "browser.click", params: { text: "保存" } },
    },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  let clicks = 0;
  const call: CallFn = async (method) => {
    if (method === "browser.newWindow") return { tabId: 404, url: "x" };
    if (method === "browser.click") clicks++;
    return {};
  };
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "escalate", "an unmet consequence escalates once the budget is spent");
  assert.ok(
    result.failed.join("; ").includes("after source1688.productCaptured"),
    `the diagnostic says it was the consequence gate, not the readiness gate: ${result.failed.join("; ")}`,
  );
  // The contrast with the gate-timeout test above: THAT one asserts waitCalls === 1
  // and evals === 0. The action here did run, so retrying it is meaningful.
  assert.ok(afterWaits > 1, `after IS retried through maxRetries (got ${afterWaits})`);
  assert.ok(clicks > 1, `the action is re-performed on each retry (got ${clicks})`);
});

test("after: 未声明时不产生额外等待(纯可选)", async () => {
  const { evidence, waits } = makeEvidence();
  const runner = new PlanRunner(evidence);
  const steps: PlanStep[] = [
    openStep,
    { goal: "点一下", page: "source1688", verify: { settled: true }, gate: { all: ["pageReady"] }, action: { method: "browser.click", params: { text: "x" } } },
  ];
  const { planId } = await runner.create("g", steps, undefined, undefined, pages);
  const call: CallFn = async (method) => (method === "browser.newWindow" ? { tabId: 404, url: "x" } : {});
  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "complete");
  assert.equal(waits.length, 1, "only the click's own gate was awaited (openStep is a bootstrap, no gate)");
});
