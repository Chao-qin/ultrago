/**
 * The MCP surface of browser-mcp.ts, pinned through the protocol itself.
 *
 * WHY this exists: `createBrowserMcpServer` is one 2200-line closure holding
 * every tool registration plus the mutable session state they share
 * ("this closure IS the session"). Splitting it means turning shared closure
 * variables into something passed around, and a build passing proves nothing
 * about 55 tool registrations still being there, still taking the same
 * arguments, and still routing to the same browser.
 *
 * So the assertions here are deliberately about the CONTRACT, not the code:
 * they talk to the server over an in-memory transport exactly as a client
 * would, and never reach for a private field. A refactor that keeps the
 * contract keeps these green; one that drops a tool, renames an argument or
 * breaks the session's shared state turns them red.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { RpcMethod, type BrowserTarget } from "@bcp/shared";
import { EventStore } from "./event-store.js";
import { createBrowserMcpServer, type BrowserLifecycle, type BrowserRegistry, type RawBrowserCall } from "./browser-mcp.js";

const TARGET_A: BrowserTarget = { kind: "chrome", instanceId: "inst-a" };
const TARGET_B: BrowserTarget = { kind: "chrome", instanceId: "inst-b" };

/** Every call the server dispatched, so a test can ask where it was routed. */
interface CallLog {
  method: RpcMethod;
  params: Record<string, unknown>;
  target: BrowserTarget;
}

function makeRegistry(current: BrowserTarget | null, overrides: Partial<BrowserRegistry> = {}): BrowserRegistry {
  return {
    list: () => [TARGET_A, TARGET_B].map((t, i) => ({
      kind: t.kind, instanceId: t.instanceId, connectedAt: 0,
      current: i === 0, mode: "auto" as const, ready: true,
    })),
    validate: () => {},
    current: () => current,
    getMode: () => "auto",
    setMode: () => {},
    setClaim: () => {},
    clearClaim: () => {},
    listClaims: () => [],
    ...overrides,
  };
}

/** A server wired to inert dependencies, plus the log of what it dispatched. */
async function connect(opts: {
  registry?: BrowserRegistry | null;
  lifecycle?: BrowserLifecycle | null;
  result?: unknown;
  events?: EventStore;
} = {}): Promise<{ client: Client; calls: CallLog[]; close: () => Promise<void> }> {
  const calls: CallLog[] = [];
  const rawCall = (async (method, params, target) => {
    calls.push({ method, params: params as Record<string, unknown>, target });
    return (opts.result ?? {}) as never;
  }) as RawBrowserCall;

  const events = opts.events ?? ({
    subscribe: () => () => {},
    publish: () => {},
     since: () => ({ events: [], maxSeq: 0 }),
    latestSeq: () => 0,
  } as unknown as Parameters<typeof createBrowserMcpServer>[1]);

  const registry = opts.registry === null ? undefined : (opts.registry ?? makeRegistry(TARGET_A));
  const lifecycle = opts.lifecycle === null
    ? undefined
    : (opts.lifecycle ?? ({ dispatcher: {}, setup: {} } as unknown as BrowserLifecycle));

  const server = createBrowserMcpServer(rawCall, events, registry, undefined, lifecycle);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, calls, close: () => client.close() };
}

/**
 * The tools this server promises. Spelled out rather than snapshotted to a
 * file: a generated snapshot gets re-blessed on a whim, while a list someone
 * has to edit by hand makes "I removed a tool" a visible decision in the diff.
 */
const EXPECTED_TOOLS = [
  "advance", "analyze_page", "batch", "browser_state", "browser_status",
  "claim_tab", "click", "click_text", "close_tab", "close_window", "double_click", "download",
  "drag", "eval", "go_back", "go_forward", "hover", "launch_browser", "list_browsers",
  "list_playbooks", "list_tabs", "list_windows", "local_eval", "navigate", "new_tab",
  "new_window", "page_state", "paste_text", "pick_option", "plan", "plan_abort", "plan_status",
  "press_key", "read_content", "read_content_dump", "read_events", "read_network", "record_stop", "reload",
  "right_click", "run_playbook", "screenshot", "scroll", "select_option", "set_browser_mode",
  "set_network_capture", "snapshot", "stop_browser", "switch_tab", "type_text", "upload_file",
  "use_browser", "wait_for", "wait_for_event", "wait_signal", "write_file",
];

test("每个工具都还在，没有多出来的", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((t) => t.name).sort(), [...EXPECTED_TOOLS].sort());
  await close();
});

test("每个工具都有非空 description —— 客户端只靠它决定要不要调用", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const naked = tools.filter((t) => !t.description || t.description.trim() === "");
  assert.deepEqual(naked.map((t) => t.name), [], "description 缺失");
  await close();
});

/**
 * Argument names, pinned per tool.
 *
 * A split that rebuilds a `registerTool` call by hand is exactly where an
 * argument quietly changes name or stops being required — and that breaks
 * every caller without breaking the build.
 */
test("关键工具的参数名与必填集不变", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const byName = new Map(tools.map((t) => [t.name, t.inputSchema as { properties?: Record<string, unknown>; required?: string[] }]));

  // Written out by hand from what the server actually advertises today. The
  // point is that changing one of these has to be a deliberate edit here, not
  // a snapshot that silently re-blesses itself.
  const expectations: Record<string, { props: string[]; required: string[] }> = {
    navigate: { props: ["tabId", "url"], required: ["url"] },
    // Five ways to address an element (ref / coords / role+name / css / text)
    // plus the two gates — this breadth IS the contract callers rely on.
    click: {
      props: ["confirm", "css", "exact", "humanize", "name", "near", "nth", "ref", "role", "tabId", "text", "x", "y"],
      required: [],
    },
    type_text: {
      props: ["confirm", "css", "exact", "humanize", "name", "near", "nth", "ref", "role", "submit", "tabId", "text"],
      required: ["text"],
    },
    read_content: { props: ["maxChars", "offset", "tabId"], required: [] },
    analyze_page: { props: ["maxChars", "offset", "saveScreenshot", "screenshotPath", "tabId"], required: [] },
    use_browser: { props: ["instanceId", "kind"], required: ["kind"] },
    claim_tab: { props: ["release", "tabId"], required: [] },
    stop_browser: { props: ["confirm", "instanceId", "kind"], required: ["confirm", "instanceId", "kind"] },
    // Narrowing and paging: one huge page's full snapshot was refused by the MCP client outright.
    snapshot: { props: ["after", "limit", "query", "tabId", "viewportOnly"], required: [] },
    drag: { props: ["confirm", "method", "ref", "tabId", "toRef"], required: ["ref", "toRef"] },
    screenshot: { props: ["savePath", "tabId"], required: [] },
  };

  for (const [tool, want] of Object.entries(expectations)) {
    const schema = byName.get(tool);
    assert.ok(schema, `${tool} 未注册`);
    assert.deepEqual(
      Object.keys(schema.properties ?? {}).sort(),
      [...want.props].sort(),
      `${tool} 的参数名集合变了`,
    );
    assert.deepEqual((schema.required ?? []).sort(), [...want.required].sort(), `${tool} 的必填集变了`);
  }
  await close();
});

test("read_content 把分页 offset 传给浏览器，并明确告诉客户端如何继续", async () => {
  const { client, calls, close } = await connect({
    result: {
      title: "长页面",
      url: "https://x/long",
      text: "第二段",
      offset: 0,
      totalChars: 3,
      truncated: false,
      overview: { headings: ["章节"], excerpt: "开头" },
    },
  });
  const reply = (await client.callTool({ name: "read_content", arguments: { maxChars: 6, offset: 32000, tabId: 7 } })) as {
    content: Array<{ text?: string }>;
  };
  const rendered = reply.content.map((c) => c.text ?? "").join("\n");
  assert.deepEqual(calls.at(-1)?.params, { maxChars: 6, offset: 32000, full: true, tabId: 7 });
  assert.match(rendered, /Page text dumped to temporary files/);
  const manifest = rendered.match(/Manifest: (.+)/)?.[1];
  assert.ok(manifest, "read_content should return a manifest path");
  await access(manifest);
  assert.match(await readFile(manifest, "utf8"), /章节/);
  assert.doesNotMatch(rendered, /第二段\n\n/);
  await close();
});

test("read_content_dump 只允许读取当前轮次的 manifest/chunk", async () => {
  const { client, close } = await connect({
    result: {
      title: "页面",
      url: "https://x/",
      text: "需要按需读取的正文",
      offset: 0,
      totalChars: 10,
      truncated: false,
    },
  });
  const first = (await client.callTool({ name: "read_content", arguments: {} })) as { content: Array<{ text?: string }> };
  const manifest = first.content.map((c) => c.text ?? "").join("\n").match(/Manifest: (.+)/)?.[1];
  assert.ok(manifest);
  const loaded = (await client.callTool({ name: "read_content_dump", arguments: { path: manifest } })) as { content: Array<{ text?: string }> };
  assert.match(loaded.content.map((c) => c.text ?? "").join("\n"), /chunkCount/);
  await close();
});

/**
 * The plan/batch family, including the SHARED step & verify shapes.
 *
 * These two zod objects are referenced from more than one tool, so they are the
 * pieces most likely to be lifted into a module of their own during a split —
 * and lifting a schema is exactly the kind of edit that silently drops a field.
 */
test("plan / batch 系的参数，含嵌套的 step 与 verify 形状", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const schemaOf = (n: string) =>
    tools.find((t) => t.name === n)?.inputSchema as
      | { properties?: Record<string, { items?: unknown }>; required?: string[] }
      | undefined;

  const flat: Record<string, { props: string[]; required: string[] }> = {
    plan: { props: ["goal", "record", "steps"], required: ["goal", "steps"] },
    advance: { props: ["confirm", "planId"], required: ["planId"] },
    plan_status: { props: ["planId"], required: ["planId"] },
    batch: { props: ["steps", "tabId"], required: ["steps"] },
    run_playbook: { props: ["mode", "name", "params", "paramsFile", "resumePlanId"], required: ["name"] },
  };
  for (const [tool, want] of Object.entries(flat)) {
    const s = schemaOf(tool);
    assert.ok(s, `${tool} 未注册`);
    assert.deepEqual(Object.keys(s.properties ?? {}).sort(), [...want.props].sort(), `${tool} 参数名变了`);
    assert.deepEqual((s.required ?? []).sort(), [...want.required].sort(), `${tool} 必填集变了`);
  }

  const step = schemaOf("plan")?.properties?.steps?.items as
    { properties?: Record<string, { properties?: Record<string, unknown> }>; required?: string[] } | undefined;
  assert.ok(step, "plan.steps 的 item 形状丢了");
  assert.deepEqual(
    Object.keys(step.properties ?? {}).sort(),
    ["goal", "maxRetries", "onFail", "risk", "verify"],
    "step 形状变了",
  );
  assert.deepEqual((step.required ?? []).sort(), ["goal", "verify"], "step 必填集变了");

  // 16 done-criteria fields — the runner gates on these, so a dropped one
  // silently turns a checked step into an unchecked one.
  assert.deepEqual(
    Object.keys(step.properties?.verify?.properties ?? {}).sort(),
    [
      "actionSucceeded", "assert", "dialogOpen", "elementChecked", "elementEnabled", "elementName",
      "elementValue", "evalCheck", "formSubmittable", "networkOk", "noErrors", "settled",
      "textAbsent", "textPresent", "urlIncludes", "visualAssert",
    ],
    "verify 的判据字段变了",
  );
  await close();
});

test("没有 lifecycle 时，生命周期工具不注册（其余照常）", async () => {
  const { client, close } = await connect({ lifecycle: null });
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const gone of ["launch_browser", "stop_browser", "browser_status"]) {
    assert.equal(names.has(gone), false, `${gone} 不该在无 lifecycle 时注册`);
  }
  assert.equal(names.has("snapshot"), true, "普通工具应当不受影响");
  await close();
});

/* ─────────────────────────── session state ───────────────────────────
 * The part a split is most likely to break: these are the SAME mutable
 * closure variables read and written by tools that would end up in
 * different modules. Each test drives one tool to write the state and a
 * DIFFERENT tool to read it, so a split that gives each group its own copy
 * fails here even though every group builds fine on its own.
 */

test("use_browser 改的 target，后续别的工具要能看到", async () => {
  const { client, calls, close } = await connect({ registry: makeRegistry(TARGET_A) });

  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(calls.at(-1)?.target.instanceId, "inst-a", "默认应跟随 registry 的 current");

  await client.callTool({ name: "use_browser", arguments: { kind: "chrome", instanceId: "inst-b" } });
  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(calls.at(-1)?.target.instanceId, "inst-b", "use_browser 写的 target 没有被后续工具读到");

  // A second, unrelated tool must see it too — not just the one used above.
  await client.callTool({ name: "page_state", arguments: {} });
  assert.equal(calls.at(-1)?.target.instanceId, "inst-b");
  await close();
});

test("claim_tab 认领的 tab，后续调用要自动带上", async () => {
  const { client, calls, close } = await connect();

  await client.callTool({ name: "claim_tab", arguments: { tabId: 4242 } });
  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(calls.at(-1)?.params.tabId, 4242, "认领的 tabId 没有注入后续调用");

  await client.callTool({ name: "claim_tab", arguments: { release: true } });
  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(calls.at(-1)?.params.tabId, undefined, "release 之后不该再注入 tabId");
  await close();
});

/**
 * Closing the claimed tab has to drop the claim, and the tool that does it
 * lives in a different module from the one that sets it. This is the path a
 * split breaks by handing a group the claim VALUE instead of a live read —
 * close_tab then consults the claim as it stood at registration (null) and
 * leaves a claim pointing at a tab that no longer exists.
 */
test("关掉被认领的 tab 之后，认领要被清理", async () => {
  const { client, calls, close } = await connect();

  await client.callTool({ name: "claim_tab", arguments: { tabId: 55 } });
  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(calls.at(-1)?.params.tabId, 55, "前提：认领已生效");

  await client.callTool({ name: "close_tab", arguments: { tabId: 55 } });
  await client.callTool({ name: "snapshot", arguments: {} });
  assert.equal(
    calls.at(-1)?.params.tabId,
    undefined,
    "关掉认领的 tab 后仍在注入它 —— 认领没被清理",
  );
  await close();
});

test("认领跟着 target 走：换了浏览器就不该再注入别人的 tabId", async () => {
  const { client, calls, close } = await connect({ registry: makeRegistry(TARGET_A) });

  await client.callTool({ name: "claim_tab", arguments: { tabId: 77 } });
  await client.callTool({ name: "use_browser", arguments: { kind: "chrome", instanceId: "inst-b" } });
  await client.callTool({ name: "snapshot", arguments: {} });

  assert.equal(calls.at(-1)?.target.instanceId, "inst-b");
  assert.equal(
    calls.at(-1)?.params.tabId,
    undefined,
    "tabId 是每实例的小整数，跨实例注入会驱动到毫不相干的页面",
  );
  await close();
});

test("会话结束时清掉共享 claim 注册表里的自己", async () => {
  const cleared: string[] = [];
  const { client, close } = await connect({
    registry: makeRegistry(TARGET_A, { clearClaim: (sessionId) => { cleared.push(sessionId); } }),
  });
  await client.callTool({ name: "claim_tab", arguments: { tabId: 9 } });
  await close();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(cleared.length > 0, true, "transport 关闭后应当从共享注册表里摘掉自己的 claim");
});

test("两个会话各自持有独立的 target", async () => {
  const a = await connect({ registry: makeRegistry(TARGET_A) });
  const b = await connect({ registry: makeRegistry(TARGET_A) });

  await a.client.callTool({ name: "use_browser", arguments: { kind: "chrome", instanceId: "inst-b" } });
  await a.client.callTool({ name: "snapshot", arguments: {} });
  await b.client.callTool({ name: "snapshot", arguments: {} });

  assert.equal(a.calls.at(-1)?.target.instanceId, "inst-b");
  assert.equal(b.calls.at(-1)?.target.instanceId, "inst-a", "另一个会话不该被波及");
  await Promise.all([a.close(), b.close()]);
});

/**
 * Challenge candidates are DOM estimates for the webhook only. Handing one to
 * the agent (a video player scored as a slider puzzle) made it stop work on a
 * page nothing was blocking — so no agent-facing surface may carry them.
 */
test("验证码候选事件不出现在任何给 LLM 的输出里", async () => {
  const store = new EventStore();
  const { client, close } = await connect({ events: store, result: { title: "t", url: "https://x/", text: "body" } });
  const push = (kind: "captcha_appeared" | "captcha_cleared" | "dialog") =>
    store.push({ kind, tabId: 7, ts: 1, browser: TARGET_A.instanceId, summary: `${kind} probe`, detail: { evidence: ["x"] } });
  const textOf = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");

  push("captcha_appeared");
  push("dialog");
  const piggyback = textOf(await client.callTool({ name: "read_content", arguments: { tabId: 7 } }));
  assert.match(piggyback, /dialog probe/, "普通事件照常搭载");
  assert.doesNotMatch(piggyback, /captcha/);

  push("captcha_cleared");
  const listed = textOf(await client.callTool({ name: "read_events", arguments: {} }));
  assert.match(listed, /dialog probe/);
  assert.doesNotMatch(listed, /captcha/);

  const waited = textOf(await client.callTool({ name: "wait_for_event", arguments: { kinds: ["captcha_appeared", "captcha_cleared"], timeoutMs: 50 } }));
  assert.match(waited, /Timed out/);
  await close();
});

test("工具参数一路到达 RPC：drag 的 method 变成 dragMethod，snapshot 的 query 真的缩小回复", async () => {
  const elements = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, tag: "a", role: "link", name: i === 7 ? "登录/注册" : `职位 ${i}` }));
  const { client, calls, close } = await connect({ result: { url: "https://x/", title: "列表", elements, moreBelow: false, changed: { added: ["e7"], removed: 0 }, ok: true } });
  try {
    await client.callTool({ name: "drag", arguments: { ref: "e1", toRef: "e2", method: "pointer" } });
    assert.equal(calls.at(-1)?.params.dragMethod, "pointer");
    const narrowed = await client.callTool({ name: "snapshot", arguments: { query: "登录" } });
    const narrowedText = (narrowed.content as Array<{ text: string }>)[0].text;
    assert.match(narrowedText, /\[e7\] link "登录\/注册"/);
    assert.doesNotMatch(narrowedText, /\[e8\]/);
    assert.match(narrowedText, /1 of 50 elements match/);
    const full = await client.callTool({ name: "snapshot", arguments: {} });
    assert.doesNotMatch((full.content as Array<{ text: string }>)[0].text, /already read/, "上一次只看到了过滤后的部分，不能声称其余都读过");
  } finally { await close(); }
});

test("快照的覆盖记账跟着实际读到的标签页走，变化基线按会话隔离", async () => {
  const elements = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, tag: "a", role: "link", name: i === 7 ? "登录/注册" : `职位 ${i}` }));
  // One mutable page: which tab the extension reports as read changes between calls, as the active tab would.
  const page = { tabId: 2, url: "https://x/", title: "列表", elements, moreBelow: false, changed: undefined as { added: string[]; removed: number } | undefined };
  const a = await connect({ result: page });
  const b = await connect({ result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await a.client.callTool({ name: "snapshot", arguments: { query: "登录" } });
    page.tabId = 1;
    await a.client.callTool({ name: "snapshot", arguments: {} });
    page.tabId = 2;
    page.changed = { added: ["e7"], removed: 0 };
    const back = textOf(await a.client.callTool({ name: "snapshot", arguments: {} }));
    assert.doesNotMatch(back, /already read/, "标签页 2 上次只看了一部分；标签页 1 的完整读取不能替它作证");
    page.tabId = 1;
    const other = textOf(await a.client.callTool({ name: "snapshot", arguments: {} }));
    assert.match(other, /already read/, "标签页 1 上次看全了");

    const keyA = a.calls.at(-1)?.params.deltaKey;
    await b.client.callTool({ name: "snapshot", arguments: {} });
    const keyB = b.calls.at(-1)?.params.deltaKey;
    assert.equal(typeof keyA, "string", "agent 自己的快照要带会话键，否则所有会话共用一份变化基线");
    assert.notEqual(keyA, keyB);
  } finally { await Promise.all([a.close(), b.close()]); }
});

test("pick_option 内部读的快照不带会话键，不挪动 agent 的变化基线", async () => {
  const { client, calls, close } = await connect({ result: { tabId: 1, url: "u", title: "t", moreBelow: false, elements: [{ ref: "e1", tag: "li", role: "option", name: "北京" }], ok: true } });
  try {
    await client.callTool({ name: "pick_option", arguments: { ref: "e0", option: "北京" } });
    const internal = calls.find((c) => c.method === RpcMethod.Snapshot);
    assert.ok(internal, "pick_option 应当读过一次快照");
    assert.equal(internal.params.deltaKey, undefined);
  } finally { await close(); }
});

test("agent 自己的截图在 auto 模式下才允许把读不出的后台窗口提到前台", async () => {
  const { client, calls, close } = await connect({ result: { dataUrl: "data:image/png;base64,AA", tabs: [] } });
  try {
    await client.callTool({ name: "screenshot", arguments: {} });
    const shot = calls.find((c) => c.method === RpcMethod.Screenshot);
    assert.equal(shot?.params.activate, true);
  } finally { await close(); }
});
