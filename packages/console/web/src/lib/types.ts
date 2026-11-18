// Shared API response types — SSOT is @bcp/shared/src/console-types.ts.
// This file re-exports them so the rest of the frontend code doesn't need
// to know where they live.
import type { Book, LlmAdminView as SharedLlmAdminView } from "@bcp/shared";

/** 运行时自动接入的本地渠道；管理面展示和测试，但不参与 channels.json 保存。 */
export interface LlmManagedChannelView {
  id: string;
  adapter: string;
  baseUrl?: string;
  model: string;
  options?: Record<string, unknown>;
}

export type LlmAdminView = SharedLlmAdminView & {
  managedChannels?: LlmManagedChannelView[];
};

export type {
  Book,
  BookDetail,
  BookRef,
  EnqueueResult,
  HealthStatus,
  OverviewStats,
  ParamSchema,
  Paginated,
  RunDetail,
  RunListQuery,
  RunStatus,
  RunSummary,
  ScheduleItem,
  Schedule,
  StepRun,
  UploadedAttachment,
  CreateScheduleInput,
  UpdateScheduleInput,
  SchemaRow,
  SchemaKind,
  RegisterSchemaInput,
  UpdateSchemaInput,
  FlowGraph,
  FlowNode,
  FlowEdge,
  FlowPort,
  FlowNodeType,
  FlowProblem,
  FlowRunStatus,
  FlowNodeRunStatus,
  Compat,
  CompatLevel,
  BrowserEventRow,
  BrowserEventListQuery,
  BrowserEventStats,
  LlmCallRow,
  LlmCallListQuery,
  LlmCallStats,
  LlmChannelView,
  LlmChannelDraft,
  LlmAdapterInfo,
  LlmChannelTestResult,
  LlmUpstreamModels,
  LlmApiKeyView,
  LlmKeySecret,
  LlmKeySettings,
  LlmKeyTestResult,
  LlmKeysView,
  LlmKeyCreated,
  LlmRuntimeView,
} from "@bcp/shared";
export { getRunStatusMeta, isRunActive, isRunRetryable, normalizeTags, parseConsoleDeliveries, parseConsoleParamSchema, parseConsoleParams, parseRunStatusFilter } from "@bcp/shared";
// `SchemaRecord.source` key builders. Re-exported rather than re-spelled here:
// the console writes these strings and the detail pages read them back, and a
// second copy of the format is how the two stop matching.
export { flowProductSource, runArtifactSource, runArtifactSourcePrefix, runProductSource } from "@bcp/shared";
export { SCHEMA_KINDS, SCHEMA_KIND_LABELS, checkSchemaContract, isSchemaSlug, parseCitation } from "@bcp/shared";
export {
  FLOW_NODE_TYPES,
  FLOW_NODE_TYPE_LABELS,
  EMPTY_GRAPH,
  connectedInputs,
  deriveInputSchema,
  flowInputParams,
  flowInputPortId,
  isAssignable,
  parseFlowGraph,
  transformOutputKey,
  validateGraphShape,
  validatePorts,
  scriptInputPorts,
  scriptSkeleton,
  SCRIPT_LANGUAGES,
  SCRIPT_LANGUAGE_LABELS,
  BRANCH_OPERATORS,
  BRANCH_OPERATOR_LABELS,
  isUnaryBranchOperator,
  branchPorts,
  mergePorts,
  mapPorts,
  collectPorts,
} from "@bcp/shared";
export type { ScriptLanguage, ScriptNodeConfig, BranchCase, BranchNodeConfig, BranchOperator, MergeNodeConfig, MapNodeConfig, CollectNodeConfig } from "@bcp/shared";

/** Soft-delete timestamp of a list row, or null if the row is live.
 *
 *  Flow / Schema / Run list responses all carry `deletedAt` (they return the
 *  Prisma row as-is), but the shared row types don't declare it. Rather than
 *  spell the same cast at each `includeDeleted` call site — three pages, three
 *  chances to write a different one — the read has one home. */
export function rowDeletedAt(row: unknown): string | null {
  return (row as { deletedAt?: string | null } | null)?.deletedAt ?? null;
}

/** A flow row as the list endpoint returns it. */
export interface FlowSummary {
  id: string;
  name: string;
  description: string | null;
  graphJson: string;
  inputSchema: string;
  outputSchema: string | null;
  enabled: boolean;
  tags: string | null;
  updatedAt: string;
  runs?: Array<{ id: string; status: string; queuedAt: string; finishedAt: string | null; durationMs: number | null }>;
}

export interface FlowNodeRunRow {
  id: string;
  nodeId: string;
  nodeType: string;
  iteration: number | null;
  status: string;
  slot: string | null;
  runId: string | null;
  inputJson: string | null;
  outputJson: string | null;
  errorMessage: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
}

/** What a script dry-run reports back. Mirrors `ScriptOutcome` on the server,
 *  which is produced by the SAME function a real node goes through — the whole
 *  value of the button is that it does not have its own execution path. */
export interface ScriptDryRunResult {
  ok: boolean;
  output?: unknown;
  error?: string;
  errorCategory?: 'input' | 'syntax' | 'runtime' | 'timeout' | 'output' | 'permission' | 'network' | 'module' | 'cancelled';
  errorLocation?: { line: number; column?: number };
  /** Bounded tails, not the whole streams. */
  stdout: string;
  stderr: string;
  durationMs: number;
  /** "nobody could fully check this" — a contract notice, not a breach. */
  notices: string[];
  warning?: string;
}

export interface FlowRunRow {
  resumeBlockReason?: string | null;
  id: string;
  flowId: string;
  flow?: { name: string };
  graphSnapshot: string;
  trigger: string;
  mode: string;
  status: string;
  paramsJson: string;
  errorMessage: string | null;
  failedNodeId: string | null;
  queuedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  nodes?: FlowNodeRunRow[];
}
export type { Delivery, ParamMap, ParamSchemaFragment } from "@bcp/shared";
export type { JsonValue } from "@bcp/shared";
export type { DataPreview, SchemaRecordRow, SchemaRecordListRow, CreateSchemaRecordInput, UpdateSchemaRecordInput } from "@bcp/shared";

/** A standalone scheduled script (no Book, no Flow graph). Mirrors the
 *  `Script` model: body + stdin/stdout contracts. */
export interface Script {
  id: string;
  name: string;
  description: string | null;
  language: string;
  source: string;
  inputSchema: string;
  outputSchema: string;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  lastRunAt?: string | null;
  lastRunStatus?: string | null;
}

/** Book list item with schedules attached — used by the Books page to
 *  surface per-book schedule count. */
export type BookWithSchedules = Book & {
  schedules: Array<{ id: string; name: string; cronExpr: string; enabled: boolean }>;
};

// ── Settings：workspace 的 pnpm 脚本 + 仓库根 .env ─────────────────────

/** 一条 package.json 脚本。`command` 是后端真正会 spawn 的 argv —— 前端只回传
 *  (dir, script)，命令行从不由请求体拼出来。 */
export interface PnpmScript {
  dir: string;
  pkg: string;
  script: string;
  raw: string;
  command: string[];
  danger: boolean;
  reason: string;
  /** 会杀掉/重启正在服务本页面的 console，日志走文件而不是这次连接。 */
  detach: boolean;
}

export interface PnpmScriptRegistry {
  entries: PnpmScript[];
  warnings: string[];
}

export interface ScriptExec {
  id: string;
  dir: string;
  pkg: string;
  script: string;
  command: string[];
  status: "running" | "success" | "failed" | "stopped";
  exitCode: number | null;
  startedAt: string;
  finishedAt: string | null;
}

/** 增量日志。`dropped` > 0 表示 cursor 之前的行已被挤掉，页面得说出来。 */
export interface ScriptLogPage {
  exec: ScriptExec;
  lines: string[];
  cursor: number;
  dropped: number;
}

/** detach 执行的日志尾巴，按字节游标读，跨 console 重启仍然有效。 */
export interface DetachedLogPage {
  text: string;
  offset: number;
  exists: boolean;
  reset: boolean;
}

export type StartScriptResult =
  | { detached: false; exec: ScriptExec }
  | { detached: true; logFile: string; command: string[] };

export interface EnvEntryView {
  key: string;
  /** secret 的话这里是打码后的值，真值要单独 reveal。 */
  value: string;
  comments: string[];
  secret: boolean;
  group: string;
  line: number;
  masked: boolean;
}

export interface EnvView {
  file: string;
  entries: EnvEntryView[];
  groups: string[];
  notes: string[];
}
