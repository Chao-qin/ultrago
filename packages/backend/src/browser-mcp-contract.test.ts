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
  /** An RPC that rejects, for the paths that must survive a failing leg. */
  failOn?: string;
  /** Milliseconds an RPC takes, for the paths whose order matters; `log` records starts and ends. */
  latency?: Record<string, number>;
  log?: string[];
} = {}): Promise<{ client: Client; calls: CallLog[]; close: () => Promise<void> }> {
  const calls: CallLog[] = [];
  const rawCall = (async (method, params, target) => {
    calls.push({ method, params: params as Record<string, unknown>, target });
    opts.log?.push(`start ${method}`);
    const ms = opts.latency?.[method];
    if (ms) await new Promise((r) => setTimeout(r, ms));
    opts.log?.push(`end ${method}`);
    if (method === opts.failOn) throw new Error(`${method} failed`);
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
  "advance", "analyze_page", "batch", "browser_state",
  "claim_tab", "click", "close_tab", "close_window", "double_click", "download",
  "drag", "eval", "go_back", "go_forward", "hover", "launch_browser",
  "list_playbooks", "list_windows", "local_eval", "navigate", "new_tab",
  "new_window", "page_state", "paste_text", "pick_option", "plan", "plan_abort", "plan_status",
  "press_key", "read_content", "read_content_dump", "read_events", "read_network", "record_stop", "reload",
  "right_click", "run_playbook", "screenshot", "scroll", "select_option", "set_browser_mode",
  "set_network_capture", "snapshot", "stop_browser", "switch_tab", "type_text", "upload_file",
  "use_browser", "wait_for", "wait_for_event", "write_file",
];

/** Tools that existed and were folded into another — a name an agent might
 *  still reach for, so no agent-facing text may mention it again. */
const RETIRED_TOOLS = ["list_tabs", "list_browsers", "browser_status", "click_text", "wait_signal"];

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
    read_content: { props: ["maxChars", "tabId"], required: [] },
    analyze_page: { props: ["maxChars", "saveScreenshot", "screenshotPath", "tabId"], required: [] },
    // The same locator fields as click — "same targeting as click" is a schema fact, not a promise.
    right_click: { props: ["css", "exact", "name", "near", "nth", "ref", "role", "tabId", "text", "x", "y"], required: [] },
    double_click: { props: ["confirm", "css", "exact", "name", "near", "nth", "ref", "role", "tabId", "text", "x", "y"], required: [] },
    hover: { props: ["css", "exact", "name", "near", "nth", "ref", "role", "tabId", "text", "x", "y"], required: [] },
    pick_option: { props: ["css", "exact", "name", "near", "nth", "option", "ref", "role", "tabId", "text", "x", "y"], required: ["option"] },
    use_browser: { props: ["instanceId", "kind"], required: ["kind"] },
    claim_tab: { props: ["release", "tabId"], required: [] },
    stop_browser: { props: ["confirm", "instanceId", "kind"], required: ["confirm", "instanceId", "kind"] },
    // Narrowing and paging: one huge page's full snapshot was refused by the MCP client outright.
    snapshot: { props: ["after", "full", "limit", "query", "tabId", "viewportOnly", "within"], required: [] },
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

test("read_content 把正文写进临时文件，回复只给 manifest", async () => {
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
  const reply = (await client.callTool({ name: "read_content", arguments: { maxChars: 6, tabId: 7 } })) as {
    content: Array<{ text?: string }>;
  };
  const rendered = reply.content.map((c) => c.text ?? "").join("\n");
  assert.deepEqual(calls.at(-1)?.params, { maxChars: 6, full: true, tabId: 7 });
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
      "elementValue", "evalCheck", "evalUntil", "formSubmittable", "networkOk", "noErrors", "settled",
      "textAbsent", "textPresent", "urlIncludes", "visualAssert",
    ],
    "verify 的判据字段变了",
  );
  await close();
});

test("没有 lifecycle 时，生命周期工具不注册（其余照常）", async () => {
  const { client, close } = await connect({ lifecycle: null });
  const names = new Set((await client.listTools()).tools.map((t) => t.name));
  for (const gone of ["launch_browser", "stop_browser"]) {
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
  const { client, calls, close } = await connect({ result: { url: "https://x/", title: "列表", elements, moreBelow: false, docs: { "0": "d" }, ok: true } });
  try {
    await client.callTool({ name: "drag", arguments: { ref: "e1", toRef: "e2", method: "pointer" } });
    assert.equal(calls.at(-1)?.params.dragMethod, "pointer");
    const narrowed = await client.callTool({ name: "snapshot", arguments: { query: "登录" } });
    const narrowedText = (narrowed.content as Array<{ text: string }>)[0].text;
    assert.match(narrowedText, /\[e7\] link "登录\/注册"/);
    assert.doesNotMatch(narrowedText, /\[e8\]/);
    assert.match(narrowedText, /^Coverage: 1 of the page's 50 elements listed here \(all 1 elements matching query="登录"\)/m);
    const full = (await client.callTool({ name: "snapshot", arguments: {} }) as { content: Array<{ text: string }> }).content[0].text;
    assert.match(full, /NEW to you: 49 \(first 12: e0, e1, e2/, "上一次只看到了过滤后的 e7，其余 49 个对 agent 都是新的");
    assert.doesNotMatch(full, /NEW to you:[^\n]*\be7\b/, "e7 已经给它看过");
  } finally { await close(); }
});

test("已展示记录跟着实际读到的标签页走，并按会话隔离", async () => {
  const elements = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, tag: "a", role: "link", name: i === 7 ? "登录/注册" : `职位 ${i}` }));
  // One mutable page: which tab the extension reports as read changes between calls, as the active tab would.
  const page = { tabId: 2, url: "https://x/", title: "列表", elements, moreBelow: false, docs: { "0": "d" } };
  const a = await connect({ result: page });
  const b = await connect({ result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await a.client.callTool({ name: "snapshot", arguments: { query: "登录" } });
    page.tabId = 1;
    await a.client.callTool({ name: "snapshot", arguments: {} });
    page.tabId = 2;
    const back = textOf(await a.client.callTool({ name: "snapshot", arguments: {} }));
    assert.match(back, /NEW to you: 49/, "标签页 2 上次只看了 e7；标签页 1 的完整读取不能替它作证");
    page.tabId = 1;
    const other = textOf(await a.client.callTool({ name: "snapshot", arguments: {} }));
    assert.doesNotMatch(other, /Since your last snapshot/, "标签页 1 上次看全了，没有新东西");

    const first = textOf(await b.client.callTool({ name: "snapshot", arguments: {} }));
    assert.doesNotMatch(first, /Since your last snapshot/, "另一个会话第一次读，不能沿用 a 的记录");
    assert.equal(a.calls.find((c) => c.method === RpcMethod.Snapshot)?.params.deltaKey, undefined, "比对在后端做，不再把会话键送进页面");
  } finally { await Promise.all([a.close(), b.close()]); }
});

test("读了快照但工具随后失败时不记账：下一次读照样把那些元素当成新的", async () => {
  const elements = Array.from({ length: 50 }, (_, i) => ({ ref: `e${i}`, tag: "a", role: "link", name: i === 7 ? "登录/注册" : `职位 ${i}` }));
  const { client, close } = await connect({ result: { tabId: 1, url: "https://x/", title: "列表", elements, moreBelow: false, docs: { "0": "d" } }, failOn: RpcMethod.ReadContent });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await client.callTool({ name: "snapshot", arguments: { query: "登录" } });
    const analyzed = await client.callTool({ name: "analyze_page", arguments: {} });
    assert.equal(analyzed.isError, true, "analyze_page 读完快照后，读正文那一路失败了");
    assert.match(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /NEW to you: 49/, "失败的 analyze_page 没把整页记成已展示");
  } finally { await close(); }
});

test("带过滤条件的 full 不重新记账，否则记录会缩成一次搜索的结果", async () => {
  const elements = Array.from({ length: 5 }, (_, i) => ({ ref: `e${i}`, tag: "a", role: "link", name: `职位 ${i}` }));
  const { client, close } = await connect({ result: { tabId: 1, url: "https://x/", title: "列表", elements, moreBelow: false, docs: { "0": "d" } } });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await client.callTool({ name: "snapshot", arguments: {} });
    await client.callTool({ name: "snapshot", arguments: { full: true, query: "职位 3" } });
    assert.doesNotMatch(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /NEW to you/, "五个都已经看过");
  } finally { await close(); }
});

test("full 读取重新开始记账；旧扩展不带 docs 时不报任何增量；两个浏览器的同号标签页各记各的", async () => {
  const elements = [
    { ref: "e1", tag: "a", role: "link", name: "首页" },
    { ref: "e2", tag: "li", role: "option", name: "北京", hidden: true as boolean | undefined },
  ];
  const page: Record<string, unknown> = { tabId: 1, url: "u", title: "t", moreBelow: false, elements, docs: { "0": "d" } };
  const { client, close } = await connect({ result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    assert.match(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /Hidden right now \(1/);
    const full = textOf(await client.callTool({ name: "snapshot", arguments: { full: true } }));
    assert.match(full, /\[e2\] option "北京" \[hidden\]/);
    assert.doesNotMatch(full, /↳/, "full 列出全部、重新记账，不拿上一次比");

    // The page moves on; the other browser's tab 1 has never been read, so it has nothing to report.
    elements[1].hidden = undefined;
    await client.callTool({ name: "use_browser", arguments: { kind: "chrome", instanceId: "inst-b" } });
    assert.doesNotMatch(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /↳/, "另一个浏览器的 tab 1 是第一次读");

    delete page.docs;
    elements.push({ ref: "e3", tag: "a", role: "link", name: "新" });
    assert.doesNotMatch(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /↳/, "没有文档标识就无从比较，也不能当成换了页面");
  } finally { await close(); }
});

test("pick_option 内部读的快照不记进 agent 的已展示记录", async () => {
  const option = { ref: "e1", tag: "li", role: "option", name: "北京", hidden: true as boolean | undefined };
  const page = { tabId: 1, url: "u", title: "t", moreBelow: false, docs: { "0": "d" }, elements: [option], ok: true };
  const { client, close } = await connect({ result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await client.callTool({ name: "snapshot", arguments: {} });
    option.hidden = undefined;
    await client.callTool({ name: "pick_option", arguments: { ref: "e0", option: "北京" } });
    assert.match(textOf(await client.callTool({ name: "snapshot", arguments: {} })), /NEW to you: e1/, "agent 自己从没看到过 e1");
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

/* ───────────────────── agent-facing text vs. the tool list ─────────────────────
 * What an agent reads (tool descriptions, every parameter description, the
 * server instructions) must only point it at tools that exist, and must
 * describe every argument it can pass. Both drifted silently before: params
 * with no description, and prose naming `browser_eval` / `list_tabs` long
 * after those names stopped being tools. */

test("每个工具的每个参数都有说明", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const missing: string[] = [];
  for (const t of tools) {
    const props = (t.inputSchema as { properties?: Record<string, { description?: string }> }).properties ?? {};
    for (const [k, v] of Object.entries(props)) if (!v.description?.trim()) missing.push(`${t.name}.${k}`);
  }
  assert.deepEqual(missing, [], "这些参数没有说明");
  await close();
});

test("说明文字里点名的工具都已注册，退役的工具名不再出现", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const registered = new Set(tools.map((t) => t.name));
  const params = new Set<string>();
  const texts: Array<[string, string]> = [["instructions", client.getInstructions() ?? ""]];
  const walk = (where: string, schema: unknown): void => {
    if (!schema || typeof schema !== "object") return;
    const o = schema as Record<string, unknown>;
    if (typeof o.description === "string") texts.push([where, o.description]);
    for (const [k, v] of Object.entries((o.properties as Record<string, unknown>) ?? {})) {
      params.add(k);
      walk(`${where}.${k}`, v);
    }
    for (const key of ["items", "anyOf", "oneOf"]) {
      const v = o[key];
      for (const x of Array.isArray(v) ? v : [v]) walk(where, x);
    }
  };
  for (const t of tools) {
    texts.push([t.name, t.description ?? ""]);
    walk(t.name, t.inputSchema);
  }
  // snake_case identifiers that are not tools: event kinds, verify fields, wire values.
  const notTools = new Set([
    "browser_online", "browser_offline", "mode_changed", "claim_changed", "target_changed", "window_opened", "window_closed",
    "console_error", "network_failed", "network_body", "dom_changed", "tab_closed", "captcha_appeared", "captcha_cleared",
    "waiting_extension", "executable_missing", "protocol_incompatible", "auth_rejected",
  ]);
  const bad: string[] = [];
  for (const [where, s] of texts) {
    // A name in backticks, or written as a call: `snapshot`, click({…}), plan().
    for (const m of s.matchAll(/`([a-z]+(?:_[a-z]+)+)`|\b([a-z]+(?:_[a-z]+)+)\(/g)) {
      const name = m[1] ?? m[2]!;
      if (!registered.has(name) && !params.has(name) && !notTools.has(name)) bad.push(`${where}: ${name}`);
    }
    for (const name of RETIRED_TOOLS) if (new RegExp(`\\b${name}\\b`).test(s)) bad.push(`${where}: retired ${name}`);
    for (const m of s.matchAll(/\bbrowser_([a-z_]+)\b/g)) if (registered.has(m[1]!)) bad.push(`${where}: browser_${m[1]}`);
  }
  assert.deepEqual(bad, [], "说明里点名了不存在的工具");
  await close();
});

test("registerRpcTool：schema 与说明对不上时拒绝注册", async () => {
  const { describedShape } = await import("./browser-mcp-tool-spec.js");
  const { z } = await import("zod");
  assert.throws(() => describedShape(RpcMethod.Navigate, { url: z.string(), extra: z.string() }), /"extra" has no description/);
  assert.throws(() => describedShape(RpcMethod.Navigate, {}), /"url" is documented but missing/);
  assert.throws(() => describedShape(RpcMethod.ClickText, {}), /has no MCP tool/);
  const ok = describedShape(RpcMethod.Navigate, { url: z.string() });
  assert.match((ok.url as { description?: string }).description ?? "", /Absolute URL/);
});

test("read_network 把开启抓取后的响应体挂在对应请求下面", async () => {
  const events = new EventStore();
  const { client, close } = await connect({
    events,
    result: { tabId: 3, requests: [
      { method: "GET", url: "https://x/api/list", status: 200, type: "xmlhttprequest", ts: 1 },
      { method: "POST", url: "https://x/api/save", status: 200, type: "xmlhttprequest", ts: 2 },
    ] },
  });
  try {
    events.push({ kind: "network_body", tabId: 3, ts: 3, browser: "inst-a", summary: "body 200 POST https://x/api/save", detail: { url: "https://x/api/save", method: "POST", status: 200, body: '{"code":500,"msg":"库存不足"}' } });
    events.push({ kind: "network_body", tabId: 4, ts: 3, browser: "inst-a", summary: "other tab", detail: { url: "https://x/api/list", method: "GET", status: 200, body: "OTHER-TAB" } });
    const reply = (await client.callTool({ name: "read_network", arguments: {} })) as { content: Array<{ text?: string }> };
    const out = reply.content.map((c) => c.text ?? "").join("\n");
    assert.match(out, /POST https:\/\/x\/api\/save\n {4}body: \{"code":500,"msg":"库存不足"\}/);
    assert.doesNotMatch(out, /OTHER-TAB/, "别的标签页的响应体不能挂过来");
  } finally { await close(); }
});

test("close_tab 回复说出实际关掉的标签页，并释放认领", async () => {
  const { client, close } = await connect({ result: { closed: true, tabId: 9 } });
  try {
    await client.callTool({ name: "claim_tab", arguments: { tabId: 9 } });
    const reply = (await client.callTool({ name: "close_tab", arguments: {} })) as { content: Array<{ text?: string }> };
    assert.match(reply.content[0]?.text ?? "", /Closed tab 9 \(this session's claimed tab/);
  } finally { await close(); }
});

test("wait_for：text 与 selector 二选一，条件等待把超时显式发给浏览器", async () => {
  const { client, calls, close } = await connect({ result: { matched: false } });
  try {
    const both = (await client.callTool({ name: "wait_for", arguments: { text: "a", selector: "#b" } })) as { isError?: boolean };
    assert.equal(both.isError, true);
    const before = calls.length;
    const r = (await client.callTool({ name: "wait_for", arguments: { text: "已保存" } })) as { content: Array<{ text?: string }> };
    assert.equal(calls.length, before + 1);
    assert.equal(calls.at(-1)?.params.ms, 5000);
    assert.match(r.content[0]?.text ?? "", /Timed out after 5000ms waiting for text "已保存"/);
  } finally { await close(); }
});

test("browser_state 给完整实例 id、本会话的目标与认领", async () => {
  const { client, close } = await connect({ lifecycle: null });
  try {
    await client.callTool({ name: "claim_tab", arguments: { tabId: 4 } });
    const reply = (await client.callTool({ name: "browser_state", arguments: {} })) as { content: Array<{ text?: string }> };
    const out = reply.content[0]?.text ?? "";
    assert.match(out, /this session: .*claimed tab 4 in chrome:inst-a/);
    assert.match(out, /### chrome:inst-b \[auto\]/);
  } finally { await close(); }
});

test("batch 的每一步接受与单个工具相同的定位参数", async () => {
  const { client, calls, close } = await connect({ result: { ok: true } });
  try {
    const r = (await client.callTool({ name: "batch", arguments: { steps: [
      { action: "click", text: "保存", near: "商品A" },
      { action: "type_text", name: "标题", text: "新标题", submit: true },
    ] } })) as { content: Array<{ text?: string }> };
    const out = r.content[0]?.text ?? "";
    assert.deepEqual(calls.at(-2)?.params, { text: "保存", near: "商品A", tabId: undefined });
    assert.equal(calls.at(-1)?.params.name, "标题");
    assert.match(out, /Verify gate — a form submission/);
    assert.doesNotMatch(out, /新标题/, "输入的值（可能是密码）不能被当成目标回显");
    assert.match(out, /type_text name="标题"/);
  } finally { await close(); }
});

/* ───────────────────── events: shown once, never swallowed ─────────────────────
 * A reply about one tab used to advance the session's event cursor past every
 * event, including the other tabs' events it filtered out. The popup a click
 * opened in tab 2 was then invisible to wait_for_event({tabId: 2}), which sat
 * until its timeout for something that had already happened. */
for (const [label, readArgs] of [["显式传 tabId", { tabId: 1 }], ["省略 tabId（用活动 / 认领标签页）", {}]] as const)
test(`回复只展示本标签页的事件时，别的标签页的事件仍能被 wait_for_event 立即拿到 —— ${label}`, async () => {
  const events = new EventStore();
  const pageState = {
    url: "https://x/", title: "t", readyState: "complete", loading: false, interactableCount: 1,
    scroll: { y: 0, height: 100, viewport: 100, moreBelow: false, moreAbove: false },
    focus: { focused: false }, forms: { controls: 0, filled: 0, emptyRequired: 0, invalid: 0, dirty: 0 },
    dialogs: 0, scrollLocked: false, overlay: false, busy: 0, errorCount: 0, tabId: 1, active: true,
  };
  let pushed = false;
  const rawCall = (async (method: RpcMethod) => {
    // While the first read of tab 1 runs, tab 2 opens a dialog.
    if (method === RpcMethod.PageState && !pushed && (pushed = true))
      events.push({ kind: "dialog", tabId: 2, ts: Date.now(), summary: "confirm() on tab 2", browser: TARGET_A.instanceId });
    return pageState as never;
  }) as RawBrowserCall;
  const server = createBrowserMcpServer(rawCall, events, makeRegistry(TARGET_A), undefined, { dispatcher: {}, setup: {} } as unknown as BrowserLifecycle);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "contract-test", version: "0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

  // The extension reports the tab it actually read (tabId 1) even when none was sent.
  const first = await client.callTool({ name: "page_state", arguments: readArgs });
  assert.doesNotMatch(JSON.stringify(first.content), /tab 2/, "a reply about tab 1 does not show tab 2's event");

  const started = Date.now();
  const waited = await client.callTool({ name: "wait_for_event", arguments: { kinds: ["dialog"], tabId: 2, timeoutMs: 3000 } });
  const body = JSON.stringify(waited.content);
  assert.match(body, /Event: dialog \(tab 2\)/, "the dialog that already happened is returned");
  assert.ok(Date.now() - started < 1000, "returned at once, not after the timeout");

  const again = await client.callTool({ name: "page_state", arguments: { tabId: 2 } });
  assert.doesNotMatch(JSON.stringify(again.content), /confirm\(\) on tab 2/, "an event wait_for_event returned is not shown again");
  await client.close();
});

/* ───────────────────── annotations ─────────────────────
 * Clients decide what to auto-approve from these, so every tool states all
 * four, and which tools are read-only is a list someone edits on purpose. */
test("每个工具都声明四项 annotations，且只读工具清单不变", async () => {
  const { client, close } = await connect();
  const { tools } = await client.listTools();
  const incomplete = tools
    .filter((t) => ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint"].some((k) => typeof (t.annotations as Record<string, unknown> | undefined)?.[k] !== "boolean"))
    .map((t) => t.name);
  assert.deepEqual(incomplete, [], "这些工具的 annotations 不全");
  const contradictory = tools.filter((t) => t.annotations?.readOnlyHint && (t.annotations.destructiveHint || !t.annotations.idempotentHint)).map((t) => t.name);
  assert.deepEqual(contradictory, [], "只读工具不能同时可能破坏或不幂等");
  assert.deepEqual(
    tools.filter((t) => t.annotations?.readOnlyHint).map((t) => t.name).sort(),
    [
      "browser_state", "list_playbooks", "list_windows", "page_state", "plan_status", "read_content", "read_content_dump",
      "read_events", "read_network", "snapshot", "wait_for", "wait_for_event",
    ],
  );
  await close();
});

test("batch 某一步导航了就停下：后面的步骤是照着已经不在的页面排的，不再执行，回复说明停在哪、为什么", async () => {
  const { client, calls, close } = await connect({ result: { ok: true, delta: { urlChanged: "https://next/" } } });
  try {
    const r = (await client.callTool({ name: "batch", arguments: { steps: [
      { action: "click", text: "下一页" },
      { action: "click", text: "保存" },
    ] } })) as { content: Array<{ text?: string }> };
    const out = r.content[0]?.text ?? "";
    assert.equal(calls.filter((c) => c.method === RpcMethod.Click).length, 1, "第二步没有执行");
    assert.match(out, /^Batch stopped after step 1\/2 — the page navigated; steps 2–2 were not run/);
    assert.match(out, /⚠ Verify gate — the page navigated/);
  } finally { await close(); }
});

test("同一会话同一轮里的调用按到达顺序执行：读取等之前到达的动作落地；动作一个接一个；动作不等之前到达的读取", async () => {
  const log: string[] = [];
  const page = { tabId: 1, url: "u", title: "t", moreBelow: false, elements: [{ ref: "e1", tag: "a", role: "link", name: "x" }], docs: { "0": "d" }, ok: true };
  const { client, close } = await connect({ result: page, latency: { [RpcMethod.Click]: 50, [RpcMethod.Snapshot]: 30 }, log });
  try {
    await client.callTool({ name: "claim_tab", arguments: { tabId: 1 } }).catch(() => {});
    log.length = 0;
    await Promise.all([
      client.callTool({ name: "click", arguments: { ref: "e1", tabId: 1 } }),
      client.callTool({ name: "snapshot", arguments: { tabId: 1 } }),
      client.callTool({ name: "click", arguments: { ref: "e1", tabId: 1 } }),
    ]);
    const at = (entry: string, nth = 0) => log.map((l, i) => (l === entry ? i : -1)).filter((i) => i >= 0)[nth];
    assert.ok(at(`start ${RpcMethod.Snapshot}`) > at(`end ${RpcMethod.Click}`, 0), "快照在第一个点击落地之后才读");
    assert.ok(at(`start ${RpcMethod.Click}`, 1) > at(`end ${RpcMethod.Click}`, 0), "第二个点击等第一个点击结束");
    assert.ok(at(`start ${RpcMethod.Click}`, 1) < at(`end ${RpcMethod.Snapshot}`), "动作不等之前到达的读取：先发的等待不会挡住后发的点击");
  } finally { await close(); }
});

test("按 ref 的动作落在这个 ref 被读到的标签页，并带上那份文档的身份 —— 不是此刻碰巧在前台的标签页", async () => {
  const page = { tabId: 2, url: "u", title: "t", moreBelow: false, elements: [{ ref: "e5", tag: "a", role: "link", name: "x" }, { ref: "42_e1", tag: "a", role: "link", name: "y" }], docs: { "0": "doc-top", "42": "doc-frame" }, ok: true };
  const { client, calls, close } = await connect({ result: page });
  try {
    await client.callTool({ name: "snapshot", arguments: {} });
    await client.callTool({ name: "click", arguments: { ref: "e5" } });
    const click = calls.filter((c) => c.method === RpcMethod.Click).at(-1)!;
    assert.equal(click.params.tabId, 2, "读的是标签页 2，就点标签页 2");
    assert.equal(click.params.expectDoc, "doc-top");
    await client.callTool({ name: "click", arguments: { ref: "42_e1" } });
    assert.equal(calls.filter((c) => c.method === RpcMethod.Click).at(-1)!.params.expectDoc, "doc-frame", "子帧的 ref 带子帧的文档身份");
  } finally { await close(); }
});

test("会话的浏览器在它不知情时换了：按旧 ref 的动作、以及本该落到认领标签页的动作都拒绝并说明，不打到别的浏览器上", async () => {
  let current: BrowserTarget = TARGET_A;
  const page = { tabId: 3, url: "u", title: "t", moreBelow: false, elements: [{ ref: "e1", tag: "a", role: "link", name: "x" }], docs: { "0": "d" }, ok: true };
  const { client, calls, close } = await connect({ result: page, registry: makeRegistry(null, { current: () => current }) });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    await client.callTool({ name: "snapshot", arguments: {} });
    current = TARGET_B;
    const before = calls.length;
    assert.match(textOf(await client.callTool({ name: "click", arguments: { ref: "e1" } })), /\[e1\] was read in another browser .* Nothing was done/);
    assert.equal(calls.length, before, "什么都没派发");

    current = TARGET_A;
    await client.callTool({ name: "claim_tab", arguments: { tabId: 3 } });
    current = TARGET_B;
    assert.match(textOf(await client.callTool({ name: "click", arguments: { text: "保存" } })), /claimed tab 3 is in browser .* Nothing was done/);
  } finally { await close(); }
});

test("计划验证的响应体只取本会话浏览器里、本计划所在标签页的：别的浏览器里的成功响应体不能证明这里保存成功", async () => {
  const store = new EventStore();
  const page: Record<string, unknown> = { tabId: 3, url: "u", title: "t", moreBelow: false, elements: [], docs: { "0": "d" }, ok: true, requests: [] };
  const { client, close } = await connect({ events: store, result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text?: string }> }).content.map((c) => c.text ?? "").join("\n");
  try {
    await client.callTool({ name: "snapshot", arguments: {} });
    const planned = textOf(await client.callTool({ name: "plan", arguments: { goal: "g", steps: [{ goal: "save", verify: { networkOk: { urlIncludes: "/api/save", bodyIncludes: "保存成功" } } }] } }));
    const planId = /plan_[\w-]+/.exec(planned)?.[0];
    page.requests = [{ url: "https://x/api/save", status: 200, ts: Date.now() + 1000 }];
    // Each foreign body differs in one way only, so each filter has to hold on its own.
    store.push({ kind: "network_body", tabId: 9, ts: 1, browser: TARGET_A.instanceId, summary: "body", detail: { url: "https://x/api/save", status: 200, body: "保存成功" } });
    store.push({ kind: "network_body", tabId: 3, ts: 1, browser: TARGET_B.instanceId, summary: "body", detail: { url: "https://x/api/save", status: 200, body: "保存成功" } });
    const other = textOf(await client.callTool({ name: "advance", arguments: { planId } }));
    assert.ok(planId, planned);
    assert.match(other, /FAILED verification: response body for "\/api\/save" does not contain "保存成功" \(0 matching/, "另一个浏览器、另一个标签页的响应体不算");
    store.push({ kind: "network_body", tabId: 3, ts: 2, browser: TARGET_A.instanceId, summary: "body", detail: { url: "https://x/api/save", status: 200, body: "保存成功" } });
    const own = textOf(await client.callTool({ name: "advance", arguments: { planId } }));
    assert.match(own, /Plan complete — all 1 step\(s\) verified/, "本会话、本标签页的成功响应体算数");
  } finally { await close(); }
});

test("wait_for 等文字超时：回复说出文字是在页面上但被隐藏（在哪），还是根本不在", async () => {
  const page: Record<string, unknown> = { matched: false, textHits: { count: 1, samples: [{ text: "保存成功", ref: "e9", hidden: true }] } };
  const { client, close } = await connect({ result: page });
  const textOf = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0].text;
  try {
    assert.match(textOf(await client.callTool({ name: "wait_for", arguments: { text: "保存成功", ms: 100 } })),
      /Timed out after 100ms .* The text is in the page but not shown: inside \[e9\] \(hidden\) "保存成功" — open what hides it/);
    page.textHits = { count: 0, samples: [] };
    assert.match(textOf(await client.callTool({ name: "wait_for", arguments: { text: "保存成功", ms: 100 } })), /The text is not in the page at all/);
  } finally { await close(); }
});
