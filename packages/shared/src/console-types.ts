/**
 * Console API response types — shared between the NestJS backend and the
 * React frontend so that a field rename in one place is caught by TypeScript
 * in the other at build time, rather than at runtime as a white page.
 *
 * SSOT: this file. Both `packages/console/src/` (backend) and
 * `packages/console/web/src/` (frontend) import from `@bcp/shared/console-types`.
 */

import { normalizeDelivery, type Delivery, type ResolvedDelivery } from "./deliveries.js";
import { isParamMap, type ParamMap, type ParamSpec } from "./param-runtime.js";

// ── Book ────────────────────────────────────────────────────────────────

export interface Book {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  /** Longer implementation notes (what/first-run). Only expanded in detail
   *  views; lists and search surface the short `goal`. */
  goalDetail: string | null;
  paramSchema: string;
  /** JSON Schema fragment the book promises to produce; null = no contract. */
  outputSchema: string | null;
  deliveriesJson: string;
  stepsCount: number;
  enabled: boolean;
  tags: string | null;
  filePath: string;
  fileMtime: string;
  fileHash: string;
  updatedAt: string;
  /// 逻辑删除时间，null = 未删除。**必须投影出来** —— 列表接口支持
  /// `includeDeleted`，读侧没有这个字段就无法把已删除行与正常行区分开，
  /// "含已删除"开关会变成把不可区分的行混进来（点进详情还 404），比没有开关更糟。
  deletedAt: string | null;
  lastRun: null | {
    id: string;
    status: string;
    trigger: string;
    queuedAt: string;
    finishedAt: string | null;
    durationMs: number | null;
  };
}

export interface BookDetail extends Book {
  runs: RunSummary[];
}

/** A playbook's declared input params. The runtime contract is the source of
 * truth; generated BookParamSchema remains a named alias for codegen output. */
export type ParamSchema = import("./param-runtime.js").ParamSpec[];

export interface CreateScheduleInput {
  /** Target kind. "book" (default, legacy) / "flow" / "script". Exactly one
   *  id field must be set, and it must match the kind. */
  targetType?: "book" | "flow" | "script";
  bookId?: string;
  flowId?: string;
  scriptId?: string;
  name?: string;
  description?: string | null;
  cronExpr: string;
  timezone?: string;
  mode?: "assisted" | "auto";
  paramsJson?: string;
  deliveryOverridesJson?: string;
  enabled?: boolean;
  /** script target only: execution timeout ms, default 60000. */
  timeoutMs?: number;
}

export interface UpdateScheduleInput {
  name?: string;
  description?: string | null;
  cronExpr?: string;
  timezone?: string;
  mode?: "assisted" | "auto";
  paramsJson?: string;
  deliveryOverridesJson?: string;
  enabled?: boolean;
  /** script target only: execution timeout ms. null deletes the override. */
  timeoutMs?: number | null;
}

// ── Run ─────────────────────────────────────────────────────────────────

export type RunStatus =
  | "pending"
  | "queued"
  | "starting"
  | "running"
  | "success"
  | "failed"
  | "escalated"
  | "cancelled"
  | "needsConfirm"
  | "needsJudge"
  | "noAction";

export const RUN_STATUS_VALUES = [
  "pending",
  "queued",
  "starting",
  "running",
  "success",
  "failed",
  "escalated",
  "cancelled",
  "needsConfirm",
  "needsJudge",
  "noAction",
] as const satisfies readonly RunStatus[];

export interface RunStatusMeta {
  label: string;
  color: "default" | "blue" | "processing" | "success" | "error" | "warning";
  group: "active" | "success" | "failed" | "attention" | "cancelled";
}

export const RUN_STATUS_META: Record<RunStatus, RunStatusMeta> = {
  pending: { label: "待处理", color: "default", group: "active" },
  queued: { label: "排队中", color: "blue", group: "active" },
  starting: { label: "启动中", color: "processing", group: "active" },
  running: { label: "运行中", color: "processing", group: "active" },
  success: { label: "成功", color: "success", group: "success" },
  failed: { label: "失败", color: "error", group: "failed" },
  // "escalated" is an ORDERLY abort: a gate/precondition never came true, so
  // the run stopped instead of acting blindly. Labelled 已中止 rather than a
  // literal rendering of "escalate" — 已升级 reads as a version upgrade in
  // Chinese and tells the operator nothing about what happened.
  escalated: { label: "已中止", color: "error", group: "failed" },
  cancelled: { label: "已取消", color: "warning", group: "cancelled" },
  needsConfirm: { label: "待确认", color: "warning", group: "attention" },
  needsJudge: { label: "待判断", color: "warning", group: "attention" },
  noAction: { label: "无动作", color: "default", group: "attention" },
};

export const RUN_STATUS_FILTERS = [
  { key: "all", label: "全部", statuses: [] as RunStatus[] },
  { key: "active", label: "运行中", statuses: ["pending", "queued", "starting", "running"] as RunStatus[] },
  { key: "success", label: "成功", statuses: ["success"] as RunStatus[] },
  { key: "failed", label: "失败", statuses: ["failed", "escalated"] as RunStatus[] },
  { key: "attention", label: "需处理", statuses: ["needsConfirm", "needsJudge", "noAction"] as RunStatus[] },
  { key: "cancelled", label: "已取消", statuses: ["cancelled"] as RunStatus[] },
] as const;

export function getRunStatusMeta(status: string): RunStatusMeta {
  return RUN_STATUS_META[status as RunStatus] ?? { label: status, color: "default", group: "attention" };
}

export function parseRunStatusFilter(value?: string | string[]): RunStatus[] | undefined {
  if (value === undefined) return undefined;
  const raw = (Array.isArray(value) ? value : [value])
    .flatMap((part) => part.split(","))
    .map((part) => part.trim())
    .filter(Boolean);
  const invalid = raw.filter((part) => !(RUN_STATUS_VALUES as readonly string[]).includes(part));
  if (invalid.length) throw new Error(`status contains unsupported value(s): ${invalid.join(", ")}`);
  return [...new Set(raw)] as RunStatus[];
}

export function isRunActive(status: string): boolean {
  return getRunStatusMeta(status).group === "active";
}

/** Did this run END without succeeding — i.e. is "run it again" the sensible
 *  next action?
 *
 *  Asked through the GROUP, never against a literal status. The run detail page
 *  used to gate its retry button on `status === "failed"`, which silently
 *  excluded `escalated` — the status a book reaches when a gate never came true
 *  and it stopped instead of acting blindly. That is the case where a retry is
 *  MOST wanted (the operator just fixed the cause), and it was the one with no
 *  button. The same taxonomy already puts both in group "failed"; the filter
 *  tab 「失败」 has always covered both, so the two views disagreed.
 *
 *  `success` is deliberately NOT retryable: these books publish products, and a
 *  second run of a successful publish is a duplicate listing, not a retry.
 *
 *  What it authorises is a FRESH run from step 1 reusing the original params
 *  (RunsService.retry), not a resume — a flow-owned run retried here starts a
 *  standalone run and does not continue its flow. */
export function isRunRetryable(status: string): boolean {
  const group = getRunStatusMeta(status).group;
  return group === "failed" || group === "cancelled";
}

export interface RunSummary {
  id: string;
  /** "book" | "flow" | "script" — what this run targeted. */
  targetType: string;
  bookId: string | null;
  book: { id: string; name: string; description: string | null } | null;
  flow?: { id: string; name: string } | null;
  script?: { id: string; name: string } | null;
  status: RunStatus;
  trigger: string;
  mode: string;
  planId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  errorMessage: string | null;
  failedStep: number | null;
  attempt: number;
  parentRunId: string | null;
}

export interface RunListQuery {
  bookId?: string;
  status?: RunStatus | RunStatus[];
  limit?: number;
}

export interface TriggerRunInput {
  bookId: string;
  params: ParamMap;
  mode?: "assisted" | "auto";
  dedupeKey?: string;
  deliveryOverrides?: Delivery[];
}

export interface RunDetail extends RunSummary {
  book: Book;
  steps: StepRun[];
  paramsJson: string;
  /** `"name@version"` into the schema registry — the contract these params were
   *  collected under. null when the run's book was not converged onto it. */
  paramSchemaRef: string | null;
  ranSteps: number | null;
  totalSteps: number | null;
  deliveries: DeliveryResult[];
}

/**
 * `SchemaRecord.source` keys — the SSOT for how a payload is addressed, shared
 * because both the writer (console) and the reader (web, flow runner) have to
 * spell the same string and a second copy is how the two drift apart.
 *
 * A run's PRODUCT and the FILES it wrote are different payloads, so they are
 * different rows. `runProductSource` is also the prefix of every artifact
 * source for the same run, which is what lets one
 * `GET /api/schema-records?sourcePrefix=run:<runId>` fetch both.
 */
export const runProductSource = (runId: string): string => `run:${runId}`;
export const runArtifactSource = (runId: string, reportPath: string): string =>
  `${runArtifactSourcePrefix(runId)}${reportPath}`;
export const runArtifactSourcePrefix = (runId: string): string => `run:${runId}:artifact:`;
export const flowProductSource = (flowRunId: string): string => `flow:${flowRunId}`;

export interface DeliveryResult {
  id: string;
  deliveryIndex: number;
  kind: string;
  on: string;
  status: string;
  detail: string | null;
  attempts: number;
  idempotencyKey: string | null;
  createdAt: string;
  finishedAt: string | null;
}

export interface Paginated<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface StepRun {
  id: string;
  runId: string;
  stepIndex: number;
  goal: string;
  actionMethod: string | null;
  actionParams: string | null;
  verifySummary: string | null;
  status: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  valuePreview: string | null;
  resultAvailable?: boolean;
  resultChars?: number;
  previewTruncated?: boolean;
  upstreamTruncated?: boolean;
  errorMessage: string | null;
}

export interface EnqueueResult {
  run: {
    id: string;
    bookId: string;
    status: string;
    trigger: string;
    mode: string;
    queuedAt: string;
    dedupeKey: string | null;
  };
  queued: boolean;
  position: number;
  deduped: boolean;
}

// ── Stats / Dashboard ───────────────────────────────────────────────────

export interface OverviewStats {
  /** The range (in days) the aggregate fields cover — the `?days=` query,
   *  default 7. The dashboard's Segmented control drives it. */
  days: number;
  bookCount: number;
  runsToday: number;
  /** Runs within the last `days` days (the name predates the range switch). */
  runsThisWeek: number;
  successRate: number | null;
  runningNow: number;
  recent: RunSummary[];
  perDay: Array<{ date: string; count: number; success: number; failed: number }>;
  recentFailures: RunSummary[];
  /** Per-book aggregation over the same range, best first — the dashboard's
   *  "which book is actually carrying the load" panel. */
  topBooks: Array<{ bookId: string; name: string; runs: number; successRate: number | null }>;
}

export interface ScheduleItem {
  id: string;
  name: string;
  cronExpr: string | null;
  lastRun: null | { id: string; status: string; queuedAt: string };
  nextFires: string[];
}

/** 一本 book 在**别的行**里被引用时的投影，服务端 SSOT 是
 *  `schedules.service.ts` 的 `BOOK_PROJECTION`。
 *
 *  它有名字，是因为「判断这本 book 还在不在」的那个谓词
 *  (`web/src/lib/books.ts` 的 `bookLinkIsLive`) 拿它当参数类型 —— 谓词要防的
 *  误用正是「把**排期**当 book 传进去」，而 `Schedule` 自己也有
 *  `id` / `name` / `enabled` / `deletedAt`，光要这四个字段拦不住它。
 *  真正把两者分开的是 `deliveriesJson`：`Schedule` 上没有这个字段
 *  （投递覆盖在它自己的 `deliveryOverridesJson` 里），所以 `Schedule` 不是
 *  `BookRef`。这条区分由 `books.test.ts` 里 `scheduleTypeIsNotBookRef` 那条
 *  `@ts-expect-error` 探针盯着——它用 `declare const typedSchedule: Schedule`
 *  取值（同文件另一条用手写字面量 `scheduleRow` 的探针对 `Schedule` 的定义
 *  无感，改它触发不了任何东西）。哪天 `Schedule` 也长出 `deliveriesJson`，
 *  这条指令立刻变「未使用」而报 TS2578（2026-08-28 变异实测：给 `Schedule`
 *  加上这个字段、重建 `@bcp/shared`、跑 `build:web`，tsc 在
 *  `books.test.ts` 那一行准确报出 `TS2578: Unused '@ts-expect-error'
 *  directive.`）。 */
export interface BookRef {
  id: string;
  name: string;
  enabled: boolean;
  deliveriesJson: string;
  /// **book 自己的**删除时间，与 `Schedule.deletedAt` 是两件事：单独删掉一条
  /// 排期不会动它的 book，那时 `/books/:id` 仍然打得开。Schedules 页的 Book 列
  /// 靠它决定书名是链接还是灰字。
  deletedAt: string | null;
}

export interface Schedule {
  id: string;
  name: string;
  cronExpr: string;
  nextFires: string[];
  description: string | null;
  /** Which kind this schedule fires: "book" | "flow" | "script". Exactly one
   *  of the target projections below is non-null, matching it. Rows predating
   *  the expansion only ever had `book`. */
  targetType: "book" | "flow" | "script";
  bookId: string | null;
  book: BookRef | null;
  flow?: { id: string; name: string; enabled: boolean; deletedAt: string | null } | null;
  script?: { id: string; name: string; language: string; deletedAt: string | null } | null;
  timeoutMs: number | null;
  timezone: string;
  mode: string;
  paramsJson: string;
  deliveryOverridesJson: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  /// 逻辑删除时间，null = 未删除。与 `enabled` 分工：`enabled=false` 是**暂停**
  /// （这条排期还要，只是先别触发），`deletedAt != null` 是**删除**。
  /// 理由同 BookListItem.deletedAt —— 不投影出来，"含已删除"开关就没法用。
  deletedAt: string | null;
  lastFiredAt: string | null;
  lastFiredStatus: string | null;
  lastFiredRunId: string | null;
  totalFired: number;
  totalSuccess: number;
}

/** Normalize user-entered comma-separated tags to the persisted SSOT form. */
export function normalizeTags(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new Error("tags must be a string or null");
  const tags = [...new Set(value.split(",").map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
  return tags.length ? tags.join(",") : null;
}

export function parseConsoleJsonObject(value: string, field = "JSON"): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!isParamMap(parsed)) throw new Error(`${field} must be a plain object`);
  return parsed;
}

export function parseConsoleJsonArray(value: string, field = "JSON"): unknown[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${field} must be valid JSON`);
  }
  if (!Array.isArray(parsed)) throw new Error(`${field} must be an array`);
  return parsed;
}

export function parseConsoleParams(value: string, field = "paramsJson"): ParamMap {
  return parseConsoleJsonObject(value, field);
}

export function parseConsoleParamSchema(value: string, field = "paramSchema"): ParamSchema {
  const parsed = parseConsoleJsonArray(value, field);
  for (const [index, entry] of parsed.entries()) {
    if (!isParamMap(entry) || typeof entry.name !== "string" || typeof entry.required !== "boolean") {
      throw new Error(`${field}[${index}] must contain name and required`);
    }
    if (entry.schema !== undefined && !isParamMap(entry.schema)) {
      throw new Error(`${field}[${index}].schema must be a plain object`);
    }
  }
  return parsed as ParamSpec[];
}

export function parseConsoleDeliveries(value: string, field = "deliveriesJson"): ResolvedDelivery[] {
  return parseConsoleJsonArray(value, field).map((entry, index) => {
    try {
      return normalizeDelivery(entry);
    } catch (error) {
      throw new Error(`${field}[${index}] ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// ── Uploads ─────────────────────────────────────────────────────────────

/** One file staged by the console's attachment picker. `localPath` is what a
 * book's attachment item carries — the backend that runs the book reads it off
 * THIS machine's disk — and `url` serves the same bytes back so a saved
 * schedule still shows its thumbnails when reopened. */
export interface UploadedAttachment {
  /** File name inside the console's resource/uploads/ dir (content hash + safe name). */
  name: string;
  /** Original name as picked in the browser. */
  filename: string;
  mimeType: string;
  size: number;
  localPath: string;
  url: string;
}

// ── Health ──────────────────────────────────────────────────────────────

export interface HealthStatus {
  ok: boolean;
  db: boolean;
  backend: { ok: boolean; plans?: number; error?: string };
}

// ── Schema registry ─────────────────────────────────────────────────────
//
// The registry is the source of truth for every JSON Schema in the system.
// Consumers cite `name` + `version` as strings rather than holding a foreign
// key, so these types describe a citation-based world, not a relational one.

/** The `kind` values the registry understands. A plain union rather than a
 *  Prisma enum because the SQLite provider has no enum support. */
export const SCHEMA_KINDS = [
  "canonical",
  "projection",
  "config",
  "book_input",
  "book_output",
  "entity",
] as const;
export type SchemaKind = (typeof SCHEMA_KINDS)[number];

/** Human-facing labels for the kinds, so every surface names them the same. */
export const SCHEMA_KIND_LABELS: Record<SchemaKind, string> = {
  canonical: "中间层",
  projection: "平台投影",
  config: "配置",
  book_input: "Book 入参",
  book_output: "Book 出参",
  entity: "其他契约",
};

/** One registered schema, as the API returns it. */
export interface SchemaRow {
  id: string;
  name: string;
  version: number;
  kind: string;
  entity: string | null;
  title: string | null;
  description: string | null;
  jsonSchema: string;
  contentHash: string;
  source: string;
  upstreamRef: string | null;
  derivesFrom: string | null;
  active: boolean;
  deletedAt?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterSchemaInput {
  name: string;
  kind: string;
  /** The JSON Schema document. Accepted as an object or as its serialized
   *  form — callers holding text and callers holding a parsed body both exist,
   *  and forcing either to convert is friction with no payoff. */
  jsonSchema: unknown;
  version?: number;
  entity?: string | null;
  description?: string | null;
  source?: string;
  upstreamRef?: string | null;
  /** Which canonical this schema projects, cited as "name" or "name@3". */
  derivesFrom?: string | null;
}

/** Mutable metadata. `jsonSchema` is absent on purpose: a schema document is
 *  immutable once anything cites it — changing the content means a new
 *  `version`, not an edit in place. */
export interface UpdateSchemaInput {
  description?: string | null;
  entity?: string | null;
  active?: boolean;
  upstreamRef?: string | null;
  derivesFrom?: string | null;
}

/** Stable kebab-case slug, used for both `name` and `entity`. */
const SCHEMA_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
/** A lineage citation: "name" for whichever version is active, or "name@3" to
 *  pin one. The slug half is the same rule as `name`, so a citation can never
 *  name something the registry would have refused to register. */
const SCHEMA_CITATION_RE = /^[a-z0-9]+(-[a-z0-9]+)*(@[1-9][0-9]*)?$/;

export function isSchemaSlug(value: string): boolean {
  return SCHEMA_NAME_RE.test(value);
}

/** Split a lineage citation. No version means "whichever is active", matching
 *  the API's own default. SCHEMA_CITATION_RE guarantees the version half is a
 *  positive integer, so Number() here cannot produce NaN. */
export function parseCitation(citation: string): { name: string; version?: number } {
  const at = citation.lastIndexOf("@");
  if (at === -1) return { name: citation };
  return { name: citation.slice(0, at), version: Number(citation.slice(at + 1)) };
}

/** The rules that keep `kind`, `upstreamRef` and `derivesFrom` meaning what
 *  they claim to mean.
 *
 *  Lives here rather than in the console backend because the registration form
 *  needs the same verdict the API enforces — a second implementation in the UI
 *  would be a second thing to drift. The one rule that needs the database
 *  (does the cited canonical exist, and is it actually canonical?) stays on the
 *  server, since only it can answer that.
 *
 *  Returns every problem instead of throwing on the first: someone fixing a
 *  registration wants the whole list, same contract as validateParams.
 */
export function checkSchemaContract(row: {
  name: string;
  kind: string;
  entity?: string | null;
  upstreamRef?: string | null;
  derivesFrom?: string | null;
}): string[] {
  const problems: string[] = [];

  if (row.entity != null && !SCHEMA_NAME_RE.test(row.entity)) {
    problems.push(`entity must be kebab-case, got ${JSON.stringify(row.entity)}`);
  }

  // A canonical is the platform-neutral shape WE design. Mirroring one
  // platform's docs would quietly turn it into that platform's alias wearing a
  // neutral name, and being projected from something else would mean it isn't
  // the origin it claims to be. The first half is not hypothetical:
  // canonical-product was registered pointing at the Doudian /product/addV2
  // docs — the very URL its own projection cites.
  if (row.kind === "canonical") {
    if (row.upstreamRef) {
      problems.push(`a canonical schema mirrors no external authority — leave upstreamRef null (got ${JSON.stringify(row.upstreamRef)})`);
    }
    if (row.derivesFrom) {
      problems.push(`a canonical schema is projected from nothing — leave derivesFrom null (got ${JSON.stringify(row.derivesFrom)})`);
    }
  }

  // A projection is derived BY DEFINITION. Without this its lineage is only
  // guessable from two rows happening to share an `entity`.
  if (row.kind === "projection" && !row.derivesFrom) {
    problems.push(`a projection must cite the canonical it derives from — set derivesFrom, e.g. "canonical-product@1"`);
  }

  if (row.derivesFrom) {
    if (!SCHEMA_CITATION_RE.test(row.derivesFrom)) {
      problems.push(`derivesFrom must be "name" or "name@version", got ${JSON.stringify(row.derivesFrom)}`);
    } else if (parseCitation(row.derivesFrom).name === row.name) {
      // Includes citing another version of itself: v2 succeeding v1 is version
      // succession, not projection, and `version` already records it.
      problems.push(`a schema cannot derive from itself`);
    }
  }

  return problems;
}

/* ------------------------------------------------------------------ *
 * Browser events (backend BCP_EVENT_WEBHOOK → console)                *
 * ------------------------------------------------------------------ */

/** One stored browser event, as the console list/detail endpoints return it.
 *
 *  Dates are ISO strings, not Date objects: this is the JSON wire shape, and
 *  the frontend re-parses with dayjs. `detail` stays a JSON STRING rather than
 *  a parsed object for the same reason the column does — its shape is
 *  kind-specific and the backend is free to add fields to it. */
export interface BrowserEventRow {
  id: string;
  kind: string;
  browser: string | null;
  tabId: number;
  /** Observed in the page / service worker (source clock). */
  occurredAt: string;
  seq: number | null;
  summary: string;
  /** Kind-specific structured detail, JSON text. null = none sent. */
  detail: string | null;
  screenshotName: string | null;
  /** `/api/records/<name>`, usable directly as an <img src>. */
  screenshotUrl: string | null;
  acknowledgedAt: string | null;
  /** Landed in the console database (local clock). */
  receivedAt: string;
  deletedAt: string | null;
}

/** Filters accepted by `GET /api/browser-events`. All optional; omitting
 *  everything means "live rows, newest first, first page". */
export interface BrowserEventListQuery {
  kind?: string;
  browser?: string;
  /** Substring match over `summary` + `detail`. */
  search?: string;
  /** true = only unacknowledged, false = only acknowledged, omitted = both. */
  unacknowledged?: boolean;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

/** What the ingest endpoint accepts: a `BrowserEvent` verbatim plus the
 *  optional screenshot the webhook attaches. Deliberately mirrors
 *  `buildPayload()` in packages/backend/src/event-webhook.ts — that function
 *  spreads the event and adds `screenshot`, and this is the other end of that
 *  spread. Kept structural (not `BrowserEvent & {...}`) because the receiver
 *  must tolerate a sender that is one version ahead. */
export interface BrowserEventIngestInput {
  kind?: string;
  tabId?: number;
  ts?: number;
  summary?: string;
  detail?: Record<string, unknown>;
  seq?: number;
  browser?: string;
  /** `data:image/png;base64,…` — absent when the backend had no image worth
   *  sending (see CAPTURE_KINDS / the `shot.warning` drop in event-webhook.ts). */
  screenshot?: string;
}

/** Per-kind counts for the console's event list header. */
export interface BrowserEventStats {
  total: number;
  unacknowledged: number;
  byKind: { kind: string; count: number }[];
}

/* ------------------------------------------------------------------ *
 * LLM calls (@bcp/llm gateway → console)                              *
 * ------------------------------------------------------------------ */

/** What the gateway posts for every request it served.
 *
 *  Every field is optional for the same reason `BrowserEventIngestInput`'s are:
 *  the receiver must tolerate a sender one version ahead, and a log line is
 *  never worth failing a request over. The gateway pushes this fire-and-forget
 *  — it does not await the response and does not retry — so anything this end
 *  rejects is simply lost, which is the correct trade for telemetry.
 *
 *  Token counts are nullable on purpose: not every upstream reports usage, and a
 *  request can fail before any is produced. A missing count must stay missing
 *  rather than becoming a zero that quietly drags every average down. */
export interface LlmCallIngestInput {
  /** Channel id — the routing key the caller put in `model`. */
  channel?: string;
  /** Adapter that served it (openai / ollama / lmstudio / opencode / custom). */
  adapter?: string;
  /** The upstream's own model identifier, which differs from `channel`. */
  model?: string;
  stream?: boolean;
  /** "ok" | "error" — kept as a string for the same reason BrowserEvent.kind is. */
  status?: string;
  /** Status the gateway returned to the caller. */
  httpStatus?: number;
  /** invalid_request_error / upstream_error — mirrors the OpenAI error envelope. */
  errorKind?: string;
  errorMessage?: string;
  /** Wall time from request accepted to response finished. */
  latencyMs?: number;
  /** Time to first streamed chunk. Absent for non-streaming calls. */
  ttfbMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  /** Truncated request/response text, for "what did it actually say". */
  requestPreview?: string;
  responsePreview?: string;
  /** epoch ms on the GATEWAY clock; console stamps its own `receivedAt`. */
  startedAt?: number;
  /** Who made the call — `X-BCP-Caller`, falling back to the API key's name.
   *  The only field that answers "which FLOW is slow / expensive"; channel and
   *  model answer "who was called", which is a different question. */
  caller?: string;
  /** Cost in millionths of a currency unit. Integer so that summing thousands
   *  of rows does not drift the way float addition does. */
  costMicros?: number;
  /** Currency of `costMicros`. Without it, summing USD and CNY rows produces a
   *  number that looks fine and means nothing. */
  costCurrency?: string;
  /** Which attempt this was (1-based). Failover logs one row per attempt. */
  attempt?: number;
}

/** One stored call, as the console list/detail endpoints return it.
 *  Dates are ISO strings — this is the JSON wire shape. */
export interface LlmCallRow {
  id: string;
  channel: string;
  adapter: string;
  model: string;
  stream: boolean;
  status: string;
  httpStatus: number | null;
  errorKind: string | null;
  errorMessage: string | null;
  latencyMs: number | null;
  ttfbMs: number | null;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  requestPreview: string | null;
  responsePreview: string | null;
  caller: string | null;
  costMicros: number | null;
  costCurrency: string | null;
  attempt: number | null;
  /** Gateway clock. */
  startedAt: string;
  /** Console clock — the two can disagree; the gap is itself a clue. */
  receivedAt: string;
  deletedAt: string | null;
}

/** Filters accepted by `GET /api/llm-calls`. */
export interface LlmCallListQuery {
  /** 只看这个时刻之后的（ISO 字符串）。Dashboard 的「今日」靠它；
   *  比在服务端写死一个窗口好——列表页也能用同一个参数看任意区间。 */
  since?: string;
  channel?: string;
  adapter?: string;
  model?: string;
  /** 按调用方筛。这是回答「哪条流程在超时 / 在烧钱」的那个维度。 */
  caller?: string;
  /** "ok" | "error". */
  status?: string;
  /** Substring match over the previews and the error message. */
  search?: string;
  includeDeleted?: boolean;
  page?: number;
  pageSize?: number;
}

/** Header aggregates for the LLM page. Computed under the SAME filters as the
 *  list, or the counts and the rows disagree with no error to show for it. */
export interface LlmCallStats {
  total: number;
  errors: number;
  /** p95 rather than a mean: one 240s timeout drags a mean into fiction. */
  p95LatencyMs: number | null;
  totalTokens: number;
  byChannel: {
    channel: string;
    adapter: string;
    count: number;
    errors: number;
    /** null when no call in the window reported usage — not the same as zero. */
    totalTokens: number | null;
    /** null when no call in the window could be costed (no pricing declared,
     *  or the upstream reported no usage). Not the same as free. */
    costMicros: number | null;
  }[];
  /**
   * 花费**按货币分开**给。
   *
   * 不合成一个数字：两条渠道一条报 USD 一条报 CNY 时，加起来得到的数看着完全
   * 正常却没有任何意义，而汇率不是这个网关该知道的东西。没有单价、或上游没报
   * usage 的调用不出现在这里 —— 它们是「未知」，不是「0」。
   */
  costByCurrency: { currency: string; costMicros: number; count: number }[];
  /** 按调用方分。总量最大的那几条流程排在前面。 */
  byCaller: {
    caller: string;
    count: number;
    errors: number;
    totalTokens: number | null;
    costMicros: number | null;
  }[];
}

/** One channel as the gateway describes itself, plus its live health.
 *  Read-only in this phase — editing lands with the gateway's admin API. */
export interface LlmChannelView {
  id: string;
  adapter: string;
  model: string;
  baseUrl: string | null;
  /** "ok" | "down" | "unknown" — unknown means the adapter cannot be probed. */
  health: string;
  healthDetail: string | null;
  /** 几条同名来源声明的能力标签并集。人工声明，见 LlmChannelDraft.capabilities。 */
  capabilities: string[];
}

/** 网关管理面：一条渠道的**原始声明**（apiKey 保持 `env.NAME`，真值不出机器）。 */
export interface LlmChannelDraft {
  /** 可选。不声明就等于上游 `model`——网关的 effectiveChannelId 是这条规则的
   *  唯一实现，管理面 GET 会把算好的值放在 `LlmAdminView.effectiveIds` 里。
   *  此前这里写的是必填 string，而线上负载从来就没有这个字段。 */
  id?: string;
  adapter: string;
  baseUrl?: string;
  apiKey?: string;
  model?: string;
  options?: Record<string, unknown>;
  /** 这条上游最多同时接多少个请求。不填 = 该渠道不限（全局上限仍然管着）。 */
  maxConcurrency?: number;
  /** 每 100 万 token 的单价，照厂商价格页上的数字填。 */
  pricing?: { inputPer1M: number; outputPer1M: number; currency?: string };
  /** 能力标签（vision / json / tools …）。**人工声明、仅供挑选**：网关既不据它
   *  路由也不据它拒绝请求，所以填错会误导人，但不会让任何调用失败。 */
  capabilities?: string[];
}

/** 由当前本地运行时派生的受管渠道；可查看和测试，但不能从管理面编辑或删除。 */
export interface LlmManagedChannelView {
  id: string;
  adapter: string;
  baseUrl?: string;
  model: string;
  options?: Record<string, unknown>;
}

/** 界面画表单要知道的：每种适配器要填什么、能不能拉模型。 */
export interface LlmAdapterInfo {
  name: string;
  /** "http" | "direct" —— direct 没有 baseUrl 可填。 */
  kind: string;
  needsBaseUrl: boolean;
  canListModels: boolean;
  options: { key: string; type: string }[];
}

export interface LlmAdminView {
  channels: LlmChannelDraft[];
  /** 与 `channels` 同序：每条渠道**对外的模型名**（声明了 id 就是 id，否则等于
   *  上游 model）。规则的唯一实现在网关的 `effectiveChannelId`；界面消费这里
   *  算好的结果，不再自己推一份。旧网关不带这个字段，故为可选。 */
  effectiveIds?: string[];
  /** 不在 channels.json 中、由运行时自动接入的渠道。 */
  managedChannels?: LlmManagedChannelView[];
  adapters: LlmAdapterInfo[];
  /** 可被 `apiKey: "env.NAME"` 引用的密钥名，**只有名字没有值**。界面拿它做下拉
   *  候选；apiKey 那一栏同时允许手打明文，所以这份列表漏了谁都不阻塞。
   *  旧网关不带这个字段，故为可选。 */
  secretEnvNames?: string[];
  /** 网关自身的地址（含协议与端口，不含 `/v1`），由 console 侧补上——它是唯一
   *  知道这个的一层。界面用它回答「这条渠道怎么接进别的客户端」。 */
  gatewayBaseUrl?: string;
  /**
   * 用途别名：`{ "task.vision": ["首选模型", "备胎模型"] }`。
   *
   * 值是一条**有序**的模型链：首选的全部渠道都失败（且失败可重试）时才轮到下
   * 一个。链上任何一个指向不存在的模型都会让网关**拒绝启动**，所以界面保存失败
   * 时那段报错就是最终答案。网关回的一律是数组形态（配置文件里写单个字符串是
   * 它的简写）。
   */
  aliases?: Record<string, string[]>;
  /** 网关级闸门（渠道级的在每条渠道的 maxConcurrency 上）。 */
  limits?: { maxConcurrency?: number };
}

/** 一把入站 key，**没有明文也没有哈希** —— 界面只需要认得出是哪一把。 */
export interface LlmApiKeyView {
  id: string;
  name: string;
  /** 明文的前 12 位。足够在列表里分辨两把 key，远不足以猜出其余部分。 */
  prefix: string;
  createdAt: string;
  /** null = 启用中。吊销是软的：历史日志里那个名字还要能对上。 */
  disabledAt: string | null;
  /** null = 永不过期。到点即拒，没有宽限期。 */
  expiresAt: string | null;
  /** 网关算好的「现在过期了没有」。规则（含"时间戳坏掉算已过期"）只有一份实现。 */
  expired: boolean;
  /**
   * 能不能回显明文。
   *
   * 只是个布尔——明文本身要走 `GET /admin/keys/<id>/secret` 单独取，不进这张列表：
   * 列表每几秒刷一次，明文会跟着进网络面板、日志与前端缓存。
   *
   * 旧版本签发的 key 磁盘上只有哈希，这里是 `false`，界面要如实说「取不回来」而
   * 不是给一个空字符串。
   */
  revealable?: boolean;
  /** null = 不限。每分钟请求数，滑动窗口，超限 429 + Retry-After。 */
  rateLimitPerMinute: number | null;
  /** 空数组 = 全部模型可用。判定的是**别名解析后**的模型名。 */
  allowedModels: string[];
  /** null = 不限。这把 key 最多同时几个请求在飞。 */
  maxConcurrency: number | null;
}

/** 按需取回的明文。`secret` 为 null 时 `reason` 说明为什么取不到。 */
export interface LlmKeySecret {
  secret: string | null;
  reason?: string;
}

/**
 * 用一把 key 真打一次网关的结果。
 *
 * 失败也是「结果」不是「接口错误」，所以 ok:false 照样 200 —— 界面要显示那段
 * 原文（401 / 403 / 429 说的话各不相同），而不是收到一个自己还要处理的 HTTP 错误。
 */
export interface LlmKeyTestResult {
  ok: boolean;
  model?: string;
  latencyMs?: number;
  httpStatus?: number;
  reply?: string;
  error?: string;
}

/** 一把 key 上可调的那几项。全部可选；`null` 与省略同义，都表示「清掉」。 */
export interface LlmKeySettings {
  expiresAt?: string | null;
  rateLimitPerMinute?: number | null;
  allowedModels?: string[] | null;
  maxConcurrency?: number | null;
}

export interface LlmKeysView {
  /** 127.0.0.1 来的请求免 key。这一个开关就是「对内 → 对外」的全部切换。 */
  allowLoopback: boolean;
  /** 有没有启用中的 key。false = 网关当前对所有人敞开。 */
  authRequired: boolean;
  keys: LlmApiKeyView[];
}

/** 新签发的一把 key。`plaintext` **只在这一次响应里出现**，之后无处可取。 */
export interface LlmKeyCreated extends LlmKeysView {
  created: LlmApiKeyView & { plaintext: string };
}

/** 网关自己的运行时快照（纯内存，不打上游；问上游的是 /health）。 */
export interface LlmRuntimeView {
  concurrency: {
    limit: number | null;
    global: { active: number; queued: number };
    channels: Record<string, { active: number; queued: number }>;
  };
  /** 按渠道调试名索引：连续失败几次了、降级到什么时候。 */
  channelHealth: Record<string, { consecutiveFailures: number; demotedUntil: number | null }>;
  /** 每把 key 最近一分钟打了多少发（按 key id 索引）。纯内存，重启归零。 */
  rateWindow?: Record<string, number>;
}

/** 一键测试的结果。失败也是「结果」，不是接口错误。 */
export interface LlmChannelTestResult {
  ok: boolean;
  latencyMs: number;
  reply?: string;
  error?: string;
}

/** 上游模型列表。`supported:false` = 这个适配器问不了，**不是**没有模型。 */
export interface LlmUpstreamModels {
  supported: boolean;
  models: string[];
  reason?: string;
  error?: string;
}
