import type {
  Book,
  BookDetail,
  BookWithSchedules,
  CreateScheduleInput,
  EnqueueResult,
  HealthStatus,
  OverviewStats,
  RunDetail,
  RunSummary,
  Schedule,
  UpdateScheduleInput,
  Delivery,
  Paginated,
  ParamMap,
  UploadedAttachment,
  SchemaRow,
  RegisterSchemaInput,
  UpdateSchemaInput,
  FlowSummary,
  FlowRunRow,
  ScriptDryRunResult,
  Script,
  FlowProblem,
  SchemaRecordRow,
  SchemaRecordListRow,
  CreateSchemaRecordInput,
  UpdateSchemaRecordInput,
  PnpmScriptRegistry,
  ScriptExec,
  ScriptLogPage,
  StartScriptResult,
  DetachedLogPage,
  EnvView,
  BrowserEventRow,
  BrowserEventListQuery,
  BrowserEventStats,
  LlmCallRow,
  LlmCallListQuery,
  LlmCallStats,
  LlmChannelView,
  LlmChannelDraft,
  LlmAdminView,
  LlmChannelTestResult,
  LlmUpstreamModels,
  LlmKeysView,
  LlmKeyCreated,
  LlmKeySecret,
  LlmKeySettings,
  LlmKeyTestResult,
  LlmRuntimeView,
} from "./types";
import type { RunHistoryPage } from './run-history';

/** Tiny fetch wrapper. Same origin in prod (vite base=./ + SPA served by
 *  Nest), so we just call /api/...; the dev proxy (vite.config.ts) forwards
 *  to the Nest port when running `pnpm dev`. Throws an Error with a useful
 *  message on non-2xx; the `status` field is attached for retry policy. */
async function req<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let body: { error?: string; message?: string | string[] } | undefined;
    try {
      body = (await res.json()) as { error?: string; message?: string | string[] };
    } catch {
      // not JSON; surface the HTTP status only
    }
    const message = Array.isArray(body?.message) ? body.message.join("; ") : body?.message;
    const err = new Error(message ?? body?.error ?? `${res.status} ${res.statusText}`);
    (err as Error & { status?: number }).status = res.status;
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/** Build the /api/schema-records query string. An unasked-for filter is left
 *  out entirely rather than sent empty — `schemaName=` is a different query
 *  from sending nothing. */
function schemaRecordQuery(
  q: { schemaName?: string; sourcePrefix?: string; includeDeleted?: boolean; preview?: boolean },
): string {
  const params = new URLSearchParams();
  if (q.schemaName) params.set("schemaName", q.schemaName);
  if (q.sourcePrefix) params.set("sourcePrefix", q.sourcePrefix);
  if (q.includeDeleted) params.set("includeDeleted", "true");
  if (q.preview) params.set("preview", "true");
  const qs = params.toString();
  return qs ? `?${qs}` : "";
}

export const api = {
  health: () => req<HealthStatus>("/api/health"),
  listBooks: (q: { includeDeleted?: boolean } = {}) =>
    req<BookWithSchedules[]>(`/api/books${q.includeDeleted ? "?includeDeleted=true" : ""}`),
  getBook: (id: string) => req<BookDetail>(`/api/books/${encodeURIComponent(id)}`),
  updateBook: (id: string, patch: { description?: string | null; enabled?: boolean; tags?: string | null }) =>
    req<Book>(`/api/books/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  /** Re-index `resource/playbooks/` into Book rows.
   *
   *  Typed `{ length: number }` until 2026-08-28, which no caller ever caught
   *  because there was no caller — it then returned a bare number, so the body
   *  was `6`, not `{"length":6}`. It now returns the whole outcome, `missing`
   *  included: that list is the DB side of the reconciliation, which the scan
   *  did not walk at all until 2026-08-28. Keep it mirrored on the
   *  `RescanResult` exported from `filesync.service.ts`. */
  rescan: () =>
    req<{ indexed: number; written: number; missing: string[] }>("/api/books/rescan", {
      method: "POST",
    }),
  listSchedules: (q: { includeDeleted?: boolean } = {}) =>
    req<Schedule[]>(`/api/schedules${q.includeDeleted ? "?includeDeleted=true" : ""}`),
  getSchedule: (id: string) => req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`),
  createSchedule: (input: CreateScheduleInput) =>
    req<Schedule>("/api/schedules", { method: "POST", body: JSON.stringify(input) }),
  updateSchedule: (id: string, patch: UpdateScheduleInput) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  toggleSchedule: (id: string) =>
    req<Schedule>(`/api/schedules/${encodeURIComponent(id)}/toggle`, { method: "POST" }),
  runScheduleNow: (id: string, paramsOverride?: ParamMap) =>
    req<EnqueueResult | FlowRunRow | { runId: string; status: string }>(`/api/schedules/${encodeURIComponent(id)}/run`, {
      method: "POST",
      body: JSON.stringify({ paramsOverride }),
    }),
  deleteSchedule: (id: string) =>
    req<{ ok: true }>(`/api/schedules/${encodeURIComponent(id)}`, { method: "DELETE" }),

  listRunHistory: (q: { page: number; pageSize: number; targetType?: string; status?: string[]; search?: string; includeDeleted?: boolean }) => {
    const params = new URLSearchParams({ page: String(q.page), pageSize: String(q.pageSize) });
    if (q.targetType) params.set('targetType', q.targetType);
    if (q.status?.length) params.set('status', q.status.join(','));
    if (q.search) params.set('search', q.search);
    if (q.includeDeleted) params.set('includeDeleted', 'true');
    return req<RunHistoryPage>(`/api/runs/history?${params}`);
  },
  listRuns: (q: { bookId?: string; status?: string | string[]; limit?: number; includeDeleted?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (q.bookId) params.set("bookId", q.bookId);
    if (q.status) params.set("status", Array.isArray(q.status) ? q.status.join(",") : q.status);
    if (q.limit) params.set("limit", String(q.limit));
    if (q.includeDeleted) params.set("includeDeleted", "true");
    return req<RunSummary[]>(`/api/runs?${params}`);
  },
  getRun: (id: string) => req<RunDetail>(`/api/runs/${encodeURIComponent(id)}`),
  getStepResult: (runId: string, stepId: string) => req<
    { available: true; raw: string; upstreamTruncated: boolean } | { available: false; reason: string }
  >(`/api/runs/${encodeURIComponent(runId)}/steps/${encodeURIComponent(stepId)}/result`),
  triggerRun: (
    bookId: string,
    params: ParamMap,
    mode: "assisted" | "auto" = "auto",
    dedupeKey?: string,
    deliveryOverrides?: Delivery[],
  ) =>
    req<EnqueueResult>("/api/runs", {
      method: "POST",
      body: JSON.stringify({ bookId, params, mode, dedupeKey, deliveryOverrides }),
    }),
  cancelRun: (id: string) => req<{ ok: boolean; status: string }>(`/api/runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  retryRun: (id: string) => req<EnqueueResult>(`/api/runs/${encodeURIComponent(id)}/retry`, { method: "POST" }),
  overview: (days?: number) => req<OverviewStats>(`/api/stats/overview${days ? `?days=${days}` : ""}`),

  /** Stage a picked file on the console machine so a book can attach it by
   *  localPath. The body is the file itself; the name/type the browser knows
   *  ride along as query params. Content-type is forced to octet-stream so a
   *  .json file isn't grabbed by the JSON body parser. */
  uploadAttachment: (file: File) => {
    const query = new URLSearchParams({ filename: file.name });
    if (file.type) query.set("mime", file.type);
    return req<UploadedAttachment>(`/api/uploads?${query}`, {
      method: "POST",
      headers: { "content-type": "application/octet-stream" },
      body: file,
    });
  },

  // ── Schema registry ───────────────────────────────────────────────────
  listSchemas: (q: { kind?: string; entity?: string; includeInactive?: boolean; includeDeleted?: boolean; q?: string } = {}) => {
    const query = new URLSearchParams();
    if (q.kind) query.set("kind", q.kind);
    if (q.entity) query.set("entity", q.entity);
    if (q.includeInactive) query.set("includeInactive", "true");
    if (q.includeDeleted) query.set("includeDeleted", "true");
    if (q.q) query.set("q", q.q);
    const qs = query.toString();
    return req<SchemaRow[]>(`/api/schemas${qs ? `?${qs}` : ""}`);
  },
  getSchema: (id: string) => req<SchemaRow>(`/api/schemas/${encodeURIComponent(id)}`),
  /** Resolve by citation. Omitting the version yields the current active one —
   *  the same default the Python pipeline relies on. */
  resolveSchema: (name: string, version?: number) =>
    req<SchemaRow>(`/api/schemas/by-name/${encodeURIComponent(name)}${version === undefined ? "" : `?version=${version}`}`),
  registerSchema: (input: RegisterSchemaInput) =>
    req<SchemaRow>("/api/schemas", { method: "POST", body: JSON.stringify(input) }),
  updateSchema: (id: string, patch: UpdateSchemaInput) =>
    req<SchemaRow>(`/api/schemas/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchema: (id: string) =>
    req<{ ok: boolean; name: string; version: number }>(`/api/schemas/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ── Schema Records ───────────────────────────────────────────────────
  // Query string shared by both list flavours below, so a filter can never be
  // spelled one way in one of them and another way in the other.
  /** Rows WITH their payload bodies. For callers that narrow to one run's own
   *  rows and then show the payloads — i.e. the run / flow detail pages. */
  listSchemaRecords: (q: { schemaName?: string; sourcePrefix?: string; includeDeleted?: boolean } = {}) =>
    req<SchemaRecordRow[]>(`/api/schema-records${schemaRecordQuery(q)}`),
  /** Rows WITHOUT their payload bodies, carrying a bounded `dataPreview`
   *  instead. For the browse page, which asks for the whole table and renders
   *  only a preview — see the `list()` comment in schema-records.service.ts. */
  listSchemaRecordPreviews: (q: { schemaName?: string; includeDeleted?: boolean } = {}) =>
    req<SchemaRecordListRow[]>(`/api/schema-records${schemaRecordQuery({ ...q, preview: true })}`),
  getSchemaRecord: (id: string) =>
    req<SchemaRecordRow>(`/api/schema-records/${encodeURIComponent(id)}`),
  createSchemaRecord: (input: CreateSchemaRecordInput) =>
    req<SchemaRecordRow>("/api/schema-records", { method: "POST", body: JSON.stringify(input) }),
  updateSchemaRecord: (id: string, patch: UpdateSchemaRecordInput) =>
    req<SchemaRecordRow>(`/api/schema-records/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteSchemaRecord: (id: string) =>
    req<{ ok: boolean; id: string }>(`/api/schema-records/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreSchemaRecord: (id: string) =>
    req<SchemaRecordRow>(`/api/schema-records/${encodeURIComponent(id)}/restore`, { method: "POST" }),

  // ── Flows ─────────────────────────────────────────────────────────────
  listFlows: (q: { includeDeleted?: boolean } = {}) =>
    req<FlowSummary[]>(`/api/flows${q.includeDeleted ? "?includeDeleted=true" : ""}`),
  getFlow: (id: string) => req<FlowSummary>(`/api/flows/${encodeURIComponent(id)}`),
  createFlow: (input: { name: string; description?: string | null }) =>
    req<FlowSummary>("/api/flows", { method: "POST", body: JSON.stringify(input) }),
  updateFlow: (id: string, patch: { name?: string; description?: string | null; graphJson?: string; enabled?: boolean; expectedUpdatedAt?: string }) =>
    req<FlowSummary>(`/api/flows/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteFlow: (id: string) => req<{ ok: boolean }>(`/api/flows/${encodeURIComponent(id)}`, { method: "DELETE" }),
  validateFlow: (id: string) =>
    req<{ ok: boolean; problems: FlowProblem[] }>(`/api/flows/${encodeURIComponent(id)}/validate`, { method: "POST" }),
  triggerFlow: (id: string, params: ParamMap = {}, mode?: string) =>
    req<FlowRunRow>(`/api/flows/${encodeURIComponent(id)}/trigger`, { method: "POST", body: JSON.stringify({ params, mode }) }),
  listFlowRuns: (flowId?: string) =>
    req<FlowRunRow[]>(`/api/flow-runs${flowId ? `?flowId=${encodeURIComponent(flowId)}` : ""}`),
  getFlowRun: (id: string) => req<FlowRunRow>(`/api/flow-runs/${encodeURIComponent(id)}`),
  cancelFlowRun: (id: string) => req<FlowRunRow>(`/api/flow-runs/${encodeURIComponent(id)}/cancel`, { method: "POST" }),
  /** Run one script node against sample values, without saving or triggering
   *  anything. Not addressed by flow id on purpose: the node being tried out
   *  may not be saved yet, and making someone save a half-written script to
   *  see what it does is how a "try it" button stops being used. */
  dryRunScript: (config: unknown, params: Record<string, unknown>, signal?: AbortSignal) =>
    req<ScriptDryRunResult>("/api/flows/script/dry-run", { method: "POST", body: JSON.stringify({ config, params }), signal }),

  // ── Scripts (standalone scheduled scripts) ────────────────────────────
  listScripts: (q: { includeDeleted?: boolean } = {}) =>
    req<Script[]>(`/api/scripts${q.includeDeleted ? "?includeDeleted=true" : ""}`),
  getScript: (id: string) => req<Script>(`/api/scripts/${encodeURIComponent(id)}`),
  createScript: (input: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) =>
    req<Script>("/api/scripts", { method: "POST", body: JSON.stringify(input) }),
  updateScript: (id: string, patch: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) =>
    req<Script>(`/api/scripts/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }),
  testScript: (id: string, params?: ParamMap) =>
    req<ScriptDryRunResult>(`/api/scripts/${encodeURIComponent(id)}/test`, { method: "POST", body: JSON.stringify({ params }) }),
  runScript: (id: string, params?: ParamMap) =>
    req<{ runId: string; status: string }>(`/api/scripts/${encodeURIComponent(id)}/run`, { method: 'POST', body: JSON.stringify({ params }) }),
  deleteScript: (id: string) =>
    req<{ ok: boolean }>(`/api/scripts/${encodeURIComponent(id)}`, { method: "DELETE" }),

  // ── Settings (pnpm 脚本 + .env) ───────────────────────────────────────
  // 读接口和 console 其余部分一样开放；跑脚本 / 写 .env 只允许本机调用，
  // 远端会拿到 403（见后端 LoopbackGuard）。
  listPnpmScripts: () => req<PnpmScriptRegistry>("/api/settings/scripts"),
  listScriptRuns: () => req<ScriptExec[]>("/api/settings/scripts/runs"),
  getScriptRun: (id: string, cursor: number) =>
    req<ScriptLogPage>(`/api/settings/scripts/runs/${encodeURIComponent(id)}?cursor=${cursor}`),
  startPnpmScript: (dir: string, script: string, confirm: boolean) =>
    req<StartScriptResult>("/api/settings/scripts/run", {
      method: "POST",
      body: JSON.stringify({ dir, script, confirm }),
    }),
  stopScriptRun: (id: string) =>
    req<ScriptExec>(`/api/settings/scripts/runs/${encodeURIComponent(id)}/stop`, { method: "POST" }),
  detachedScriptLog: (since: number) => req<DetachedLogPage>(`/api/settings/scripts/detached-log?since=${since}`),
  readEnv: () => req<EnvView>("/api/settings/env"),
  revealEnv: (key: string) =>
    req<{ key: string; value: string }>(`/api/settings/env/reveal?key=${encodeURIComponent(key)}`),
  writeEnv: (updates: Record<string, string>) =>
    req<{ file: string; changed: string[]; backup: string | null }>("/api/settings/env", {
      method: "PUT",
      body: JSON.stringify({ updates }),
    }),

  // ── Browser events (backend BCP_EVENT_WEBHOOK 落库) ────────────────────
  // 摄入口是 POST /internal/browser-events/hook，backend 直接打，前端不碰。
  listBrowserEvents: (q: BrowserEventListQuery = {}) =>
    req<Paginated<BrowserEventRow>>(`/api/browser-events${browserEventQs(q)}`),
  browserEventStats: (q: BrowserEventListQuery = {}) =>
    req<BrowserEventStats>(`/api/browser-events/stats${browserEventQs(q)}`),
  getBrowserEvent: (id: string) => req<BrowserEventRow>(`/api/browser-events/${encodeURIComponent(id)}`),
  acknowledgeBrowserEvent: (id: string, acknowledged: boolean) =>
    req<BrowserEventRow>(`/api/browser-events/${encodeURIComponent(id)}/acknowledge`, {
      method: "POST",
      body: JSON.stringify({ acknowledged }),
    }),
  deleteBrowserEvent: (id: string) =>
    req<BrowserEventRow>(`/api/browser-events/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreBrowserEvent: (id: string) =>
    req<BrowserEventRow>(`/api/browser-events/${encodeURIComponent(id)}/restore`, { method: "POST" }),

  // 摄入口是 POST /internal/llm-calls/hook，@bcp/llm 网关直接打，前端不碰。
  listLlmCalls: (q: LlmCallListQuery = {}) => req<Paginated<LlmCallRow>>(`/api/llm-calls${llmCallQs(q)}`),
  llmCallStats: (q: LlmCallListQuery = {}) => req<LlmCallStats>(`/api/llm-calls/stats${llmCallQs(q)}`),
  getLlmCall: (id: string) => req<LlmCallRow>(`/api/llm-calls/${encodeURIComponent(id)}`),
  deleteLlmCall: (id: string) => req<LlmCallRow>(`/api/llm-calls/${encodeURIComponent(id)}`, { method: "DELETE" }),
  restoreLlmCall: (id: string) =>
    req<LlmCallRow>(`/api/llm-calls/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  /** 渠道视图：console 现问网关，不落库。网关没起来时返回空数组。 */
  listLlmChannels: () => req<LlmChannelView[]>("/api/llm/channels"),

  // 管理面全部代理给网关 —— 配置的真相源是 packages/llm/channels.json。
  llmAdmin: () => req<LlmAdminView>("/api/llm/admin"),
  /** 保存整张表。网关校验不过会回 4xx 且什么都没改，错误原样冒到这里。 */
  saveLlmChannels: (channels: LlmChannelDraft[]) =>
    req<LlmAdminView>("/api/llm/admin/channels", { method: "PUT", body: JSON.stringify({ channels }) }),
  testLlmChannel: (id: string) =>
    req<LlmChannelTestResult>(`/api/llm/admin/channels/${encodeURIComponent(id)}/test`, { method: "POST" }),
  /** 问一份**声明**（不必已保存）打到的上游有哪些模型。POST 只是为了带 body。 */
  llmUpstreamModels: (channel: LlmChannelDraft) =>
    req<LlmUpstreamModels>("/api/llm/admin/models", { method: "POST", body: JSON.stringify({ channel }) }),

  /** 用途别名。指向不存在的模型时网关**拒绝切换**，错误原文冒到界面上。 */
  saveLlmAliases: (aliases: Record<string, string[]>) =>
    req<LlmAdminView>("/api/llm/admin/aliases", { method: "PUT", body: JSON.stringify({ aliases }) }),
  saveLlmLimits: (limits: { maxConcurrency?: number }) =>
    req<LlmAdminView>("/api/llm/admin/limits", { method: "PUT", body: JSON.stringify({ limits }) }),
  /** 网关自己的运行时快照（闸上多少在飞/排队、哪条渠道被降级）。不打上游。 */
  llmRuntime: () => req<LlmRuntimeView>("/api/llm/admin/runtime"),

  llmKeys: () => req<LlmKeysView>("/api/llm/admin/keys"),
  /** 签发。**响应里的明文是这把 key 唯一一次露面**，界面必须当场让用户复制。 */
  createLlmKey: (name: string, settings: LlmKeySettings = {}) =>
    req<LlmKeyCreated>("/api/llm/admin/keys", {
      method: "POST",
      body: JSON.stringify({ name, settings }),
    }),
  /** 改一把已签发 key 的配置。密钥本身改不了——我们没有旧明文，"重置"只能重签。 */
  updateLlmKey: (id: string, settings: LlmKeySettings) =>
    req<LlmKeysView>(`/api/llm/admin/keys/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ settings }),
    }),
  /** 明文按需取——不随列表刷新回传，见 LlmApiKeyView.revealable。 */
  revealLlmKey: (id: string) =>
    req<LlmKeySecret>(`/api/llm/admin/keys/${encodeURIComponent(id)}/secret`),
  /** 用这把 key 真打一次网关自己：鉴权/有效期/限流/白名单/路由一次全测到。 */
  testLlmKey: (id: string) =>
    req<LlmKeyTestResult>(`/api/llm/admin/keys/${encodeURIComponent(id)}/test`, { method: "POST" }),
  revokeLlmKey: (id: string) =>
    req<LlmKeysView>(`/api/llm/admin/keys/${encodeURIComponent(id)}/revoke`, { method: "POST" }),
  restoreLlmKey: (id: string) =>
    req<LlmKeysView>(`/api/llm/admin/keys/${encodeURIComponent(id)}/restore`, { method: "POST" }),
  deleteLlmKey: (id: string) =>
    req<LlmKeysView>(`/api/llm/admin/keys/${encodeURIComponent(id)}`, { method: "DELETE" }),
  /** 本机免 key 的开关 —— 这一个开关就是「对内 → 对外」的全部切换。 */
  saveLlmKeySettings: (allowLoopback: boolean) =>
    req<LlmKeysView>("/api/llm/admin/keys/settings", {
      method: "PUT",
      body: JSON.stringify({ allowLoopback }),
    }),
};

/** list 与 stats 共用一份 query string —— 两边条件必须字字相同，否则表头计数
 *  和表格行数会对不上，而那种偏差没有报错、只能靠盯着看发现。 */
function llmCallQs(q: LlmCallListQuery): string {
  const p = new URLSearchParams();
  if (q.since) p.set("since", q.since);
  if (q.channel) p.set("channel", q.channel);
  if (q.adapter) p.set("adapter", q.adapter);
  if (q.model) p.set("model", q.model);
  if (q.caller) p.set("caller", q.caller);
  if (q.status) p.set("status", q.status);
  if (q.search) p.set("search", q.search);
  if (q.includeDeleted) p.set("includeDeleted", "true");
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  const qs = p.toString();
  return qs ? `?${qs}` : "";
}

/** list 与 stats 共用一份 query string 拼装——两边条件必须字字相同，否则表头
 *  计数和表格行数会对不上，而那种偏差没有报错、只能靠盯着看发现。
 *
 *  `unacknowledged` 用 `!== undefined` 判断而不是真值判断：`false`（只看已处理的）
 *  是一个真实选项，真值判断会把它和「不筛选」折叠成同一个请求。 */
function browserEventQs(q: BrowserEventListQuery): string {
  const p = new URLSearchParams();
  if (q.kind) p.set("kind", q.kind);
  if (q.browser) p.set("browser", q.browser);
  if (q.search) p.set("search", q.search);
  if (q.unacknowledged !== undefined) p.set("unacknowledged", String(q.unacknowledged));
  if (q.includeDeleted) p.set("includeDeleted", "true");
  if (q.page) p.set("page", String(q.page));
  if (q.pageSize) p.set("pageSize", String(q.pageSize));
  const s = p.toString();
  return s ? `?${s}` : "";
}
