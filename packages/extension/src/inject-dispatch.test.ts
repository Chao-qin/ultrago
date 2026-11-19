/**
 * The barrier's decisions, asserted against fake scripting/webNavigation.
 *
 * The stakes are asymmetric and that is why these matter: reporting a landed
 * submit as a failure makes an agent submit twice, while reporting an unrelated
 * failure as success gets cached by the dedup layer and replayed on every
 * resend. Both directions have to be pinned.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { RpcMethod } from "@bcp/shared";
import { createInjectDispatch, type InjectDeps, type InjectionResultLike } from "./inject-dispatch";

type NavL = (d: { tabId: number; frameId: number; url: string }) => void;

function harness(over: Partial<InjectDeps> = {}) {
  const before = new Set<NavL>();
  const committed = new Set<NavL>();
  const execCalls: unknown[] = [];
  let execImpl: (o: never) => Promise<InjectionResultLike[]> = async () => [{ frameId: 0, result: { value: "ok" } }];
  let tabStatus = "complete";
  let frames: { ids: number[]; listing: string } | null = { ids: [0, 42], listing: "  0 (top) https://x/" };
  const probes: number[] = [];
  const waits: Array<{ tabId: number; ignore: boolean }> = [];

  const deps: InjectDeps = {
    scripting: {
      async executeScript(o) {
        execCalls.push(o);
        return execImpl(o as never);
      },
    },
    webNavigation: {
      onBeforeNavigate: { addListener: (l) => void before.add(l), removeListener: (l) => void before.delete(l) },
      onCommitted: { addListener: (l) => void committed.add(l), removeListener: (l) => void committed.delete(l) },
    },
    tabs: { async get() { return { status: tabStatus }; } },
    resolveTab: async (tabId) => ({ id: tabId ?? 1 }),
    waitNetworkIdle: async () => {},
    waitTabComplete: async (tabId, _ms, ignore) => void waits.push({ tabId, ignore }),
    liveFrames: async () => frames,
    injectEventProbes: (t) => void probes.push(t),
    isMutating: (m) => m === RpcMethod.Click || m === RpcMethod.Type,
    runtime: { dom: "DOM", dialogShim: "SHIM", dialogRestore: "RESTORE" },
    domOp: { [RpcMethod.Click]: "click", [RpcMethod.Snapshot]: "snapshot", [RpcMethod.ReadContent]: "read", [RpcMethod.Drag]: "drag" },
    barrierMs: 50,
    ...over,
  };
  return {
    dispatch: createInjectDispatch(deps),
    execCalls,
    probes,
    waits,
    get listenerCount() { return before.size + committed.size; },
    setExec: (f: typeof execImpl) => void (execImpl = f),
    setTabStatus: (s: string) => void (tabStatus = s),
    setFrames: (f: typeof frames) => void (frames = f),
    announce: (tabId = 1, frameId = 0) => before.forEach((l) => l({ tabId, frameId, url: "" })),
    commit: (tabId = 1, frameId = 0, url = "https://after/") => committed.forEach((l) => l({ tabId, frameId, url })),
  };
}

test("没有对应的 DOM op 就直接拒绝，而不是注入个空操作", async () => {
  const h = harness();
  await assert.rejects(() => h.dispatch(RpcMethod.Eval, {}), /no DOM op/);
});

test("读之前先等网络就绪 —— 骨架屏不该被当成结果", async () => {
  let waited = 0;
  const h = harness({ waitNetworkIdle: async () => void waited++ });
  await h.dispatch(RpcMethod.ReadContent, {});
  assert.equal(waited, 1);
  await h.dispatch(RpcMethod.Click, { ref: "e1" });
  assert.equal(waited, 1, "动作不需要等网络，那会让每次点击都变慢");
});

test("read 的分页参数会原样传给注入 runtime", async () => {
  const h = harness();
  await h.dispatch(RpcMethod.ReadContent, { maxChars: 123, offset: 456, full: true });
  const inject = h.execCalls.find((c) => (c as { world?: string }).world === "ISOLATED") as {
    args: [string, { maxChars?: number; offset?: number; full?: boolean }];
  };
  assert.equal(inject.args[1].maxChars, 123);
  assert.equal(inject.args[1].offset, 456);
  assert.equal(inject.args[1].full, true);
});

test("drag 的方式参数会传给注入 runtime，否则 pointer 会悄悄退化成 html5", async () => {
  const h = harness();
  await h.dispatch(RpcMethod.Drag, { ref: "42_e1", toRef: "42_e2", dragMethod: "pointer", tabId: 7, laterField: { a: 1 } });
  const inject = h.execCalls.find((c) => (c as { world?: string }).world === "ISOLATED") as {
    args: [string, Record<string, unknown>];
    target: { frameIds?: number[] };
  };
  assert.equal(inject.args[0], "drag");
  assert.equal(inject.args[1].dragMethod, "pointer");
  assert.deepEqual(inject.args[1].laterField, { a: 1 }, "以后新增的字段同样原样到达，不靠白名单");
  assert.equal(inject.args[1].ref, "e1", "带 frame 前缀的 ref 改写为帧内 ref");
  assert.equal(inject.args[1].toRef, "e2");
  assert.equal(inject.args[1].tabId, undefined, "路由字段不进入页面");
  assert.deepEqual(inject.target.frameIds, [42]);
});

test("snapshot 穿透 iframe：子帧 ref 带 frameId 前缀，parentRef 也要带", async () => {
  const h = harness();
  h.setExec(async () => [
    { frameId: 0, result: { value: { url: "https://x/", title: "T", moreBelow: false, elements: [{ ref: "e1" }] } } },
    { frameId: 42, result: { value: { url: "https://f/", title: "F", moreBelow: true, elements: [{ ref: "e3", parentRef: "e2" }] } } },
  ]);
  const r = (await h.dispatch(RpcMethod.Snapshot, {})) as {
    url: string; title: string; moreBelow: boolean; elements: Array<{ ref: string; parentRef?: string }>;
  };
  assert.equal(r.url, "https://x/", "url/title 只取顶层帧");
  assert.equal(r.title, "T");
  assert.equal(r.moreBelow, true, "任一帧还有内容都算");
  assert.deepEqual(r.elements, [{ ref: "e1" }, { ref: "42_e3", parentRef: "42_e2" }]);
});

test("snapshot 报回实际读到的标签页：不传 tabId 时读的是当时的活动页", async () => {
  const h = harness();
  h.setExec(async () => [{ frameId: 0, result: { value: { url: "u", title: "t", moreBelow: false, elements: [] } } }]);
  assert.equal(((await h.dispatch(RpcMethod.Snapshot, {})) as { tabId: number }).tabId, 1);
  assert.equal(((await h.dispatch(RpcMethod.Snapshot, { tabId: 9 })) as { tabId: number }).tabId, 9);
});

test("drag 两端不在同一帧时拒绝，不把另一帧的 ref 拿到本帧里找", async () => {
  const h = harness();
  await assert.rejects(h.dispatch(RpcMethod.Drag, { ref: "42_e3", toRef: "e3" }), /different frames/);
  await assert.rejects(h.dispatch(RpcMethod.Drag, { ref: "e1", toRef: "7_e2" }), /different frames/);
  assert.equal(h.execCalls.some((c) => (c as { world?: string }).world === "ISOLATED"), false, "被拒的拖拽不能注入页面");
  await h.dispatch(RpcMethod.Drag, { ref: "42_e3", toRef: "42_e4" });
  const inject = h.execCalls.find((c) => (c as { world?: string }).world === "ISOLATED") as { args: [string, { ref: string; toRef: string }] };
  assert.deepEqual([inject.args[1].ref, inject.args[1].toRef], ["e3", "e4"]);
});

test("snapshot 的 changed 逐帧累加，added 的 ref 也要带同样的前缀", async () => {
  const h = harness();
  h.setExec(async () => [
    { frameId: 0, result: { value: { url: "u", title: "t", moreBelow: false, elements: [], changed: { added: ["e1"], removed: 1 } } } },
    { frameId: 42, result: { value: { url: "u2", title: "t2", moreBelow: false, elements: [], changed: { added: ["e9"], removed: 2 } } } },
  ]);
  const r = (await h.dispatch(RpcMethod.Snapshot, {})) as { changed?: { added: string[]; removed: number } };
  assert.deepEqual(r.changed, { added: ["e1", "42_e9"], removed: 3 }, "不带前缀的 added 会指向另一帧里的 ref");
});

test("snapshot 顺带重装探针，且不阻塞自己", async () => {
  const h = harness();
  h.setExec(async () => [{ frameId: 0, result: { value: { url: "u", title: "t", moreBelow: false, elements: [] } } }]);
  await h.dispatch(RpcMethod.Snapshot, {});
  assert.deepEqual(h.probes, [1]);
});

test("带前缀的 ref 被路由回它来自的那一帧", async () => {
  const h = harness();
  await h.dispatch(RpcMethod.Click, { ref: "42_e3" });
  const inject = h.execCalls.find((c) => (c as { world?: string }).world === "ISOLATED") as {
    target: { frameIds: number[] }; args: [string, { ref: string }];
  };
  assert.deepEqual(inject.target.frameIds, [42]);
  assert.equal(inject.args[1].ref, "e3", "前缀要剥掉，帧内认的是裸 ref");
});

test("交互前装对话框垫片，之后恢复", async () => {
  const h = harness();
  await h.dispatch(RpcMethod.Click, { ref: "e1", confirm: true });
  const worlds = h.execCalls.map((c) => `${(c as { world: string }).world}:${String((c as { func: unknown }).func)}`);
  assert.deepEqual(worlds, ["MAIN:SHIM", "ISOLATED:DOM", "MAIN:RESTORE"]);
});

/* ── the barrier ─────────────────────────────────────────────────────────── */

test("注入消失 + 本次宣告 + 确有提交 → 判定为「动作导致了导航」", async () => {
  const h = harness();
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.announce();
    queueMicrotask(() => h.commit(1, 0, "https://after/"));
    throw new Error("Frame with ID 0 was removed");
  });
  const r = await h.dispatch(RpcMethod.Click, { ref: "e1" });
  assert.deepEqual(r, { ok: true, delta: { urlChanged: "https://after/" } });
});

test("宣告了但没有提交 → 不许判成功（取消的导航也会宣告）", async () => {
  const h = harness();
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.announce(); // 只宣告，不提交
    throw new Error("Frame with ID 0 was removed");
  });
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }), /Frame with ID 0 was removed/);
});

test("没宣告过就有提交 → 也不算数（那是页面自己后来发起的）", async () => {
  const h = harness();
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.commit(1, 0, "https://unrelated/"); // 没有 announce
    throw new Error("Frame with ID 0 was removed");
  });
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }));
});

test("只认本帧的导航 —— 别的帧提交不能算到这次动作头上", async () => {
  const h = harness();
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.announce(1, 42);
    h.commit(1, 42, "https://iframe/");
    throw new Error("Frame with ID 0 was removed");
  });
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }));
});

test("tab.status=loading 只让我们等，不能成为「我们成功了」的证据", async () => {
  const h = harness();
  h.setTabStatus("loading"); // 可能是别的 session 在导航这个共享 tab
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    throw new Error("Frame with ID 0 was removed");
  });
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }), /Frame with ID 0 was removed/);
  assert.equal(h.waits.length, 1, "该等还是要等");
  assert.equal(h.waits[0].ignore, false, "没有本次宣告，就不能忽略当前状态");
});

test("本次宣告过时，barrier 不信当前状态（那还是旧文档的 complete）", async () => {
  const h = harness();
  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.announce();
    queueMicrotask(() => h.commit());
    throw new Error("gone");
  });
  await h.dispatch(RpcMethod.Click, { ref: "e1" });
  assert.equal(h.waits[0]?.ignore, true);
});

test("无论判成功还是失败，导航监听器都要摘干净", async () => {
  const h = harness();
  await h.dispatch(RpcMethod.Click, { ref: "e1" });
  assert.equal(h.listenerCount, 0, "正常路径泄漏了监听器");

  h.setExec(async (o) => {
    if ((o as { world: string }).world !== "ISOLATED") return [];
    h.announce();
    queueMicrotask(() => h.commit());
    throw new Error("gone");
  });
  await h.dispatch(RpcMethod.Click, { ref: "e1" });
  assert.equal(h.listenerCount, 0, "导航路径泄漏了监听器");
});

/* ── frame 消失的诊断 ────────────────────────────────────────────────────── */

test("没有结果且 frame 已消失 → 告诉 agent 这批 ref 全死了", async () => {
  const h = harness();
  h.setFrames({ ids: [0], listing: "  0 (top) https://x/" });
  h.setExec(async () => []);
  await assert.rejects(
    () => h.dispatch(RpcMethod.Click, { ref: "42_e3" }),
    (e: Error) => /That frame is gone/.test(e.message) && /"42_"/.test(e.message),
  );
});

test("没有结果但 frame 还在 → 说明文档被换掉了，措辞不同", async () => {
  const h = harness();
  h.setExec(async () => []);
  await assert.rejects(
    () => h.dispatch(RpcMethod.Click, { ref: "42_e3" }),
    /document was replaced/,
  );
});

test("MUTATING 的操作要额外警告「可能已经落地」", async () => {
  const h = harness();
  h.setExec(async () => []);
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }), /may already have landed/);

  h.setExec(async () => []);
  await assert.rejects(
    () => h.dispatch(RpcMethod.ReadContent, {}),
    (e: Error) => /Then repeat this read/.test(e.message) && !/may already have landed/.test(e.message),
  );
});

test("整个 tab 都没了 → 指向 list_windows / new_tab，而不是让人对着 frame 发呆", async () => {
  const h = harness();
  h.setFrames(null);
  h.setExec(async () => []);
  await assert.rejects(() => h.dispatch(RpcMethod.Click, { ref: "e1" }), /no longer exists.*list_windows/s);
});

test("DOM op 返回 error 时抛出带诊断的错误", async () => {
  const h = harness();
  h.setExec(async () => [{ frameId: 0, result: { error: "click intercepted", errorInfo: { code: "intercepted" } } }]);
  await assert.rejects(
    () => h.dispatch(RpcMethod.Click, { ref: "e1" }),
    (e: Error & { errorInfo?: { code: string } }) => e.message === "click intercepted" && e.errorInfo?.code === "intercepted",
  );
});

test("resolved 挂在结果旁边，而不是另开一个协议字段", async () => {
  const h = harness();
  h.setExec(async () => [{ frameId: 0, result: { value: { ok: true }, resolved: { ref: "e1" } } }]);
  assert.deepEqual(await h.dispatch(RpcMethod.Click, { ref: "e1" }), { ok: true, resolved: { ref: "e1" } });
});

test("没有 resolved 时原样返回 value", async () => {
  const h = harness();
  h.setExec(async () => [{ frameId: 0, result: { value: "plain" } }]);
  assert.equal(await h.dispatch(RpcMethod.Click, { ref: "e1" }), "plain");
});
