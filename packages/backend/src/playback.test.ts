import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMethod, type BookPageDefinition, type PageState, type PlanStep } from "@bcp/shared";
import { PlanRunner, type EvidenceReader } from "./orchestrator.js";
import { runAutoPlayback, type CallFn } from "./playback.js";
import { RunBrowserContext } from "./run-browser-context.js";
import { rpcError } from "./rpc-bridge.js";

test("RunBrowserContext: 新窗口结果同时路由动作和验证证据", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 });

  assert.equal(context.route(RpcMethod.Type, { text: "今日热点" }).tabId, 404);
  assert.equal(context.route(RpcMethod.PageState, {}).tabId, 404);
  assert.equal(context.route(RpcMethod.ReadNetwork, {}).tabId, 404);
});

test("RunBrowserContext: 没有工作 tab 时拒绝 tab-scoped 回退", () => {
  const context = new RunBrowserContext();
  assert.throws(() => context.route(RpcMethod.PageState, {}), /no active work tab/);
});

test("RunBrowserContext: 关闭当前 tab 后切回本 run 上一个工作 tab", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 101 });
  context.observe(RpcMethod.NewTab, {}, { tabId: 202 });
  const close = context.route(RpcMethod.CloseTab, {});
  context.observe(RpcMethod.CloseTab, close, { closed: true });

  assert.equal(context.route(RpcMethod.PageState, {}).tabId, 101);
});

// ── Book v2: logical page bindings ──────────────────────────────────────────

test("v2: 不同页绑定到不同 tab,动作/证据/信号等待路由到各自绑定", () => {
  const context = new RunBrowserContext();
  // source1688 页由 newWindow 创建并绑定;doudian 页由 newTab 创建并绑定。
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  context.observe(RpcMethod.NewTab, {}, { tabId: 505 }, "doudian");

  assert.equal(context.route(RpcMethod.Type, { text: "x" }, "source1688").tabId, 404);
  assert.equal(context.route(RpcMethod.PageState, {}, "source1688").tabId, 404);
  assert.equal(context.route(RpcMethod.ReadNetwork, {}, "source1688").tabId, 404);
  assert.equal(context.route(RpcMethod.WaitSignal, { condition: {}, timeoutMs: 100 }, "doudian").tabId, 505);
  assert.equal(context.route(RpcMethod.Snapshot, {}, "doudian").tabId, 505);
  assert.equal(context.currentTabId("source1688"), 404);
  assert.equal(context.currentTabId("doudian"), 505);
  assert.deepEqual(context.boundPages().sort(), ["doudian", "source1688"]);
});

test("v2: 显式 tabId 优先于页绑定,绝不落到用户活动 tab", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  const r = context.route(RpcMethod.Type, { text: "x", tabId: 999 }, "source1688");
  assert.equal(r.tabId, 999);
});

test("v2: 关闭一页的 tab 只移除该绑定,另一页绑定不受影响", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  context.observe(RpcMethod.NewTab, {}, { tabId: 505 }, "doudian");

  const close = context.route(RpcMethod.CloseTab, {}, "doudian");
  context.observe(RpcMethod.CloseTab, close, { closed: true }, "doudian");

  assert.equal(context.currentTabId("doudian"), undefined, "closed page binding dropped");
  assert.equal(context.currentTabId("source1688"), 404, "other page binding untouched");
  assert.equal(context.route(RpcMethod.Type, { text: "x" }, "source1688").tabId, 404);
  assert.throws(() => context.route(RpcMethod.Type, { text: "x" }, "doudian"), /no binding for page "doudian"/);
});

test("v2: 未绑定页是硬错误,不回退到活动 tab", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  assert.throws(() => context.route(RpcMethod.PageState, {}, "doudian"), /no binding for page "doudian"/);
  // 旧式无页路由仍可用(非 v2 计划)
  assert.equal(context.route(RpcMethod.PageState, {}).tabId, 404);
});

test("v2: closeWindow 按 windowId 移除该窗口下所有页绑定", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404, windowId: 7 }, "source1688");
  context.observe(RpcMethod.NewWindow, {}, { tabId: 505, windowId: 7 }, "doudian");
  context.observe(RpcMethod.CloseWindow, { windowId: 7 }, { closed: true });
  assert.equal(context.currentTabId("source1688"), undefined);
  assert.equal(context.currentTabId("doudian"), undefined);
});

test("v2: ownedTabIds 去重,清理恰好一次", () => {
  const context = new RunBrowserContext();
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  // 同一 tab 被二次 observe(重复绑定)不重复计数
  context.observe(RpcMethod.NewWindow, {}, { tabId: 404 }, "source1688");
  context.observe(RpcMethod.NewTab, {}, { tabId: 505 }, "doudian");
  assert.deepEqual([...context.ownedTabIds()], [404, 505]);
});

// ── 终态清理 ───────────────────────────────────────────────────────────────
//
// 上面每个用例测的都是 RunBrowserContext 自己。以下测的是 playback.ts 的兜底
// 清理:一次 run 以 escalate 收场时,它开的 tab 到底有没有被关掉。这条路径此前
// 零断言,而它恰恰是"关不掉也没人知道"的那条——三个 catch 全是空的。

const twoPages: Record<string, BookPageDefinition> = {
  A: { signals: { ready: { condition: { textPresent: "never" }, timeoutMs: 10 } } },
  B: { signals: { ready: { condition: { settled: true }, timeoutMs: 10 } } },
};

const settled: PageState = {
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

/** `waitSignal` always times out, which is what drives these runs to escalate
 *  without executing the gated action (see signal-gates.test.ts for that
 *  outcome proved on its own). `onWait` is the seam the cancel test uses to
 *  abort the plan at the one moment that produces "escalate on a dead plan". */
function makeEvidence(onWait?: () => void): EvidenceReader {
  return {
    pageState: async () => settled,
    readContent: async () => ({ text: "done" }),
    readNetwork: async () => ({ requests: [] }),
    snapshot: async () => ({ elements: [] }),
    evalJs: async () => ({ value: true }),
    setNetworkCapture: async () => {},
    networkBodies: () => ({ bodies: [], maxSeq: 0 }),
    screenshot: async () => ({ dataUrl: "" }),
    targetAvailable: () => true,
    waitSignal: async () => {
      onWait?.();
      return { satisfied: false, timedOut: true, failedPaths: ["condition.textPresent"] };
    },
  };
}

/** Two pages in two tabs, a gated step that will time out, and a trailing close
 *  for EACH page. Two pages is the whole point: with one, the page binding and
 *  the run's `activeTabId` are the same tab and a cleanup that ignores `page`
 *  is indistinguishable from one that honours it. */
const twoPageSteps: PlanStep[] = [
  { goal: "开 A", page: "A", verify: { settled: true }, action: { method: "browser.newWindow", params: { url: "https://a.example" } } },
  { goal: "开 B", page: "B", verify: { settled: true }, action: { method: "browser.newTab", params: { url: "https://b.example" } } },
  { goal: "在 A 采集", page: "A", verify: { settled: true }, gate: { all: ["ready"] }, action: { method: "browser.eval", params: { code: "collect()" } } },
  { goal: "关 A", page: "A", verify: { settled: true }, action: { method: "browser.closeTab", params: {} } },
  { goal: "关 B", page: "B", verify: { settled: true }, action: { method: "browser.closeTab", params: {} } },
];

/** Records which tab each close actually landed on — the only thing that
 *  distinguishes a cleanup that routed correctly from one that guessed. */
function recordingCall(): { call: CallFn; closed: number[] } {
  const closed: number[] = [];
  const call: CallFn = async (method, params) => {
    if (method === "browser.newWindow") return { tabId: 404, windowId: 7, url: "x" };
    if (method === "browser.newTab") return { tabId: 505, url: "x" };
    if (method === "browser.closeTab") {
      closed.push((params as { tabId?: number }).tabId!);
      return { closed: true };
    }
    return {};
  };
  return { call, closed };
}

test("清理: escalate 后每个页各自的 tab 被关掉,而不是把活动 tab 关两次", async () => {
  const runner = new PlanRunner(makeEvidence());
  const { planId } = await runner.create("g", twoPageSteps, undefined, undefined, twoPages);
  const { call, closed } = recordingCall();

  const result = await runAutoPlayback(runner, planId, call, twoPageSteps, { context: new RunBrowserContext() });

  assert.equal(result.kind, "escalate", "gate 超时应当 escalate");
  // A 的 close 步骤声明 page:"A",B 的声明 page:"B"。兜底重放必须把这两个 page
  // 一起带上;丢掉它就会两次都落到 activeTabId(B 开得晚,所以是 505),表现为
  // [505, 404] —— 顺序不同,且 A 的 tab 是被"轮到它时恰好排到"才关掉的,不是被
  // 定位到的。这就是把 `page: steps[i].page` 去掉后本断言会变红的原因。
  assert.deepEqual(closed, [404, 505], "两个 close 步骤各自关掉自己 page 绑定的 tab");
});

test("清理: BCP_KEEP_FAILED_TABS=1 时三条清理路径都不动现场", async () => {
  // 失败时那个窗口是「它到底停在哪」的唯一记录 —— 关掉就等于逼人为了看一眼而重跑
  // 一整轮。实测代价:为了看清品牌控件长什么样，白跑了三轮发布书。
  //
  // 此前只有 closeTrackedTabs 与 closeLeakedClaim 认这个开关，cleanupStaleTabs
  // （补执行 book 尾部 closeTab 的那条）不认 —— 于是开着开关也看不到现场，另外两条
  // 还在如实打印「保留 N 个 tab 供检查」。半边生效比不生效更糟：日志说留了，实际没留。
  const prev = process.env.BCP_KEEP_FAILED_TABS;
  process.env.BCP_KEEP_FAILED_TABS = "1";
  try {
    const runner = new PlanRunner(makeEvidence());
    const { planId } = await runner.create("g", twoPageSteps, undefined, undefined, twoPages);
    const { call, closed } = recordingCall();

    const result = await runAutoPlayback(runner, planId, call, twoPageSteps, { context: new RunBrowserContext() });

    assert.equal(result.kind, "escalate", "gate 超时应当 escalate");
    assert.deepEqual(closed, [], `开着保留开关时一个 tab 都不该被关，实际关了 ${JSON.stringify(closed)}`);
  } finally {
    if (prev === undefined) delete process.env.BCP_KEEP_FAILED_TABS;
    else process.env.BCP_KEEP_FAILED_TABS = prev;
  }
});

test("清理: 用户取消后即使结局是 escalate,也不拆掉工作区", async () => {
  let planId = "";
  // 在 gate 等待里取消 —— 这是唯一能同时得到「plan 已消失」和「playLoop 仍返回
  // escalate」的时刻:waitGate 返回后,playLoop 用早已取到的 status 直接返回
  // escalate,不再碰 runner。
  const runner = new PlanRunner(makeEvidence(() => runner.abort(planId)));
  ({ planId } = await runner.create("g", twoPageSteps, undefined, undefined, twoPages));
  const { call, closed } = recordingCall();
  const finished: string[] = [];

  const result = await runAutoPlayback(runner, planId, call, twoPageSteps, {
    context: new RunBrowserContext(),
    onFinish: async (info) => { finished.push(info.status); },
  });

  assert.equal(result.kind, "escalate");
  // 这条门此前只装在 throw 分支上,escalate 分支没有:于是同一个「用户取消」,
  // 步骤崩了就保留工作区、verify 预算耗尽就拆掉工作区。
  assert.deepEqual(closed, [], "取消后不该关任何 tab —— 用户可能正看着");
  assert.deepEqual(finished, ["cancelled"], "结局如实报告为取消,而不是被 unknown planId 覆盖");
});

test("清理: 取消恰好落在清理 RPC 期间,结局仍然报得出来", async () => {
  let planId = "";
  const runner = new PlanRunner(makeEvidence());
  ({ planId } = await runner.create("g", twoPageSteps, undefined, undefined, twoPages));

  // plan 在 planAlive() 那一刻还活着,清理途中才被取消 —— 而清理是两次真实
  // 浏览器往返,取消完全来得及落在中间。检查与使用之间隔着 await,就是一个会
  // 过期的检查:runner 上的读取必须在窗口打开之前取完。
  const closed: number[] = [];
  const call: CallFn = async (method, params) => {
    if (method === "browser.newWindow") return { tabId: 404, windowId: 7, url: "x" };
    if (method === "browser.newTab") return { tabId: 505, url: "x" };
    if (method === "browser.closeTab") {
      closed.push((params as { tabId?: number }).tabId!);
      if (closed.length === 1) runner.abort(planId); // 第一次关闭途中用户点了取消
      return { closed: true };
    }
    return {};
  };
  const finished: string[] = [];

  const result = await runAutoPlayback(runner, planId, call, twoPageSteps, {
    context: new RunBrowserContext(),
    onFinish: async (info) => { finished.push(info.status); },
  });

  assert.equal(result.kind, "escalate");
  // 把 `runner.getResults(planId)` 留在 finish 的参数里(清理之后才求值),这里
  // 就会抛 unknown planId;而这一整块不在任何 try 内,异常直接逃出函数,
  // onFinish 一次都不会触发 —— 也就是 run 的真实结局彻底消失。
  assert.deepEqual(finished, ["escalated"], "清理期间被取消,结局依然报得出来");
  assert.deepEqual(closed, [404, 505], "清理照常把两个 tab 关完");
});

// ── 定位失效:带诊断响亮失败,绝不放宽重试 ───────────────────────────────────

test("定位失效时不做降级重试 —— 一次调用后带候选 escalate", async () => {
  // 曾经这里会扔掉失效维度、从 candidates 里补一维重试一次。已移除:放宽一个
  // locator 会让它匹配到更多东西,于是"恢复"可能把这一步打到作者根本没指的那个
  // 元素上,并把点错报告成成功。宁可带着候选响亮失败,也不猜。
  const steps: PlanStep[] = [
    { goal: "开工作区", verify: { settled: true }, action: { method: "browser.newTab", params: { url: "https://example.com" } } },
    { goal: "点搜索", verify: { settled: true }, action: { method: "browser.click", params: { css: "#su" } } },
  ];
  const runner = new PlanRunner(makeEvidence());
  const { planId } = await runner.create("g", steps);

  const clickParams: Record<string, unknown>[] = [];
  const call: CallFn = async (method, params) => {
    if (method === "browser.newTab") return { tabId: 404, url: "https://example.com" };
    // 只数 click:escalate 之后还有一次清理用的 closeTab,那不是重试。
    if (method !== "browser.click") return {};
    clickParams.push(params);
    throw rpcError("click: nothing matches css", {
      code: "LOCATOR_NO_MATCH",
      relaxedBy: "css",
      candidates: [{ role: "button", name: "百度一下" }],
    });
  };

  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "escalate", "定位失效直接上报,不再尝试放宽");
  assert.equal(clickParams.length, 1, "click 只发生一次 —— 没有第二次降级尝试");
  if (result.kind === "escalate") {
    assert.equal(result.diagnosis?.code, "LOCATOR_NO_MATCH");
    // 诊断里带着页面实际提供的候选:人和 agent 据此改书,机器不据此自作主张。
    assert.deepEqual(result.diagnosis?.candidates, [{ role: "button", name: "百度一下" }], "候选原样上报供人判断");
  }
});

test("定位失效且页面没提供候选时,同样 escalate 并保留诊断", async () => {
  // 降级找不到任何可加的候选维度(candidates 全空),引擎不能在猜不出新路的情况下
  // 假装继续 —— 应 escalate 且携带原诊断,好让 assisted 模式读得懂。
  const steps: PlanStep[] = [
    { goal: "开工作区", verify: { settled: true }, action: { method: "browser.newTab", params: { url: "https://example.com" } } },
    { goal: "点搜索", verify: { settled: true }, action: { method: "browser.click", params: { css: "#su" } } },
  ];
  const runner = new PlanRunner(makeEvidence());
  const { planId } = await runner.create("g", steps);

  const call: CallFn = async (method) => {
    if (method === "browser.newTab") return { tabId: 404, url: "https://example.com" };
    throw rpcError("click: nothing matches css", { code: "LOCATOR_NO_MATCH", relaxedBy: "css", candidates: [] });
  };

  const result = await runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() });
  assert.equal(result.kind, "escalate");
  if (result.kind === "escalate") {
    assert.equal(result.diagnosis?.code, "LOCATOR_NO_MATCH", "诊断原样带上,供读取");
  }
});

test("动作抛出的非可恢复错误必须带上是哪一步 —— 否则 35 步的书只剩一句超时", async () => {
  // 2026-09-07 实测：一次 `eval timed out after 90000ms` 让人连跑三轮、靠页面残留
  // 状态反推是哪一步。同一条链路上 verify 失败却报「FAILED at step 3 (上传主图…)」——
  // 同样是失败，一种能直接定位，另一种只能猜。差别只在这一处 rethrow。
  const steps: PlanStep[] = [
    { goal: "开窗", page: "A", verify: { settled: true }, action: { method: "browser.newWindow", params: { url: "https://a.example" } } },
    { goal: "在页面里算一个值（这一步会超时）", page: "A", verify: { settled: true }, action: { method: "browser.eval", params: { code: "compute()" } } },
  ];
  const runner = new PlanRunner(makeEvidence());
  const { planId } = await runner.create("g", steps, undefined, undefined, twoPages);
  const call: CallFn = async (method) => {
    if (method === "browser.newWindow") return { tabId: 404, windowId: 7, url: "x" };
    if (method === "browser.eval") throw new Error("eval timed out after 90000ms");
    return {};
  };

  await assert.rejects(
    () => runAutoPlayback(runner, planId, call, steps, { context: new RunBrowserContext() }),
    (e: Error) => {
      assert.match(e.message, /step 2\/2/, `没带步号：${e.message}`);
      assert.match(e.message, /这一步会超时/, `没带 goal：${e.message}`);
      assert.match(e.message, /eval timed out after 90000ms/, `原始错误被吃掉了：${e.message}`);
      return true;
    },
  );
});
