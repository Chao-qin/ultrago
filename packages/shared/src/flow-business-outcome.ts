import type { ParamSchemaFragment } from './param-runtime.js';
import { readPath } from './flow-branch.js';

export type BusinessOutcomeStatus = string;

export interface BusinessOutcome {
  status: BusinessOutcomeStatus;
  label?: string;
  level?: 'success' | 'warning' | 'error' | 'info';
  reason: string;
  missingRequired: string[];
  resourceId?: string;
  resourceUrl?: string;
  receiptUrl?: string;
  nodeId?: string;
  runId?: string;
}

export const BUSINESS_OUTCOME_SCHEMA: ParamSchemaFragment = {
  type: 'object',
  'x-bcp-business-outcome': true,
  required: ['status', 'reason', 'missingRequired'],
  properties: {
    status: { type: 'string', minLength: 1 },
    label: { type: 'string' },
    level: { type: 'string', enum: ['success', 'warning', 'error', 'info'] },
    reason: { type: 'string', minLength: 1 },
    missingRequired: { type: 'array', items: { type: 'string' } },
    resourceId: { type: 'string' },
    resourceUrl: { type: 'string', pattern: '^https?://' },
    receiptUrl: { type: 'string', pattern: '^https?://' },
  },
};

interface NodeRow {
  nodeId: string;
  status: string;
  outputJson?: unknown;
  runId?: string | null;
  startedAt?: string | Date | null;
  iteration?: number | null;
}

interface OutcomeRun {
  status: string;
  graphSnapshot: unknown;
  nodes?: readonly NodeRow[];
}

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null ? value as Record<string, unknown> : null;
}

function parseObject(value: unknown): Record<string, unknown> | null {
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    if (value.length > 1_000_000) return null;
    try { value = JSON.parse(value); }
    catch { return null; }
  }
  const parsed = object(value);
  return parsed && !('$ref' in parsed) ? parsed : null;
}

function nonempty(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function safeUrl(value: unknown): string | undefined {
  const text = nonempty(value);
  if (!text) return undefined;
  try {
    const url = new URL(text);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : undefined;
  } catch { return undefined; }
}

function readOutcome(value: unknown): BusinessOutcome | null {
  const parsed = parseObject(value);
  const status = nonempty(parsed?.status);
  const reason = nonempty(parsed?.reason);
  const pending = parsed?.missingRequired;
  if (!status || !reason || !Array.isArray(pending) || !pending.every((item) => typeof item === 'string')) return null;
  const outcome: BusinessOutcome = {
    status, reason,
    missingRequired: [...new Set(pending.slice(0, 1000).map(nonempty).filter((item): item is string => !!item))],
  };
  for (const key of ['label', 'resourceId'] as const) {
    const text = nonempty(parsed?.[key]);
    if (text) outcome[key] = text;
  }
  for (const key of ['resourceUrl', 'receiptUrl'] as const) {
    const url = safeUrl(parsed?.[key]);
    if (url) outcome[key] = url;
  }
  const level = parsed?.level;
  if (level === 'success' || level === 'warning' || level === 'error' || level === 'info') outcome.level = level;
  return outcome;
}

function isOutcomeSchema(value: unknown): boolean {
  const schema = object(value);
  if (schema?.['x-bcp-business-outcome'] === true) return true;
  // 历史快照没有角色标注，仍可按同一份结构契约识别出参。
  const required = schema?.required;
  const properties = object(schema?.properties);
  return schema?.type === 'object' && Array.isArray(required)
    && ['status', 'reason', 'missingRequired'].every((key) => required.includes(key))
    && object(properties?.status)?.type === 'string'
    && object(properties?.reason)?.type === 'string'
    && object(properties?.missingRequired)?.type === 'array';
}

function uncertain(reason: string, row?: NodeRow): BusinessOutcome {
  return {
    status: 'needs_verification', label: '待核验', level: 'warning', reason, missingRequired: [],
    ...(row ? { nodeId: row.nodeId, ...(row.runId ? { runId: row.runId } : {}) } : {}),
  };
}

export function summarizeFlowRun(run: OutcomeRun): BusinessOutcome | null {
  if (!['success', 'failed', 'cancelled'].includes(run.status)) return null;
  const graph = parseObject(run.graphSnapshot);
  if (!Array.isArray(graph?.nodes) || !Array.isArray(graph.edges)) return null;
  const nodes = graph.nodes.map(object).filter((node): node is Record<string, unknown> => !!node);
  const edges = graph.edges.map(object).filter((edge): edge is Record<string, unknown> => !!edge);
  const outputs = nodes.filter((node) => node.type === 'flowOutput' && isOutcomeSchema(object(node.config)?.schema));
  const rows = run.nodes ?? [];
  const protectedRows = rows.filter((row) => nodes.some((node) =>
    node.id === row.nodeId && object(node.config)?.resumePolicy === 'verify-before-retry',
  ) && (row.status === 'success' || row.status === 'running' || !!row.startedAt || !!row.runId));
  if (!outputs.length && !protectedRows.length) return null;

  const found: Array<{ outcome: BusinessOutcome; row: NodeRow }> = [];
  const visit = (nodeId: unknown, handle: unknown, path: unknown, seen: Set<unknown>): boolean => {
    if (typeof nodeId !== 'string' || typeof handle !== 'string' || seen.has(nodeId)) return false;
    const node = nodes.find((candidate) => candidate.id === nodeId);
    if (!node) return false;
    const next = new Set(seen).add(nodeId);
    let hasEvidence = false;
    // 汇合和出参只转交数据；沿连线保留原始生产者，才能关联正确的运行回执。
    if (node.type === 'flowOutput' || node.type === 'merge') {
      for (const edge of edges.filter((candidate) => candidate.target === nodeId && candidate.kind !== 'order')) {
        const upstream = typeof edge.srcPath === 'string' ? edge.srcPath : '$';
        const downstream = typeof path === 'string' ? path : '$';
        hasEvidence = visit(edge.source, edge.sourceHandle, `${upstream}${downstream.slice(1)}`, next) || hasEvidence;
      }
    }
    if (hasEvidence) return true;
    for (const row of rows.filter((candidate) => candidate.nodeId === nodeId && candidate.status === 'success')) {
      const value = parseObject(row.outputJson)?.[handle];
      const result = readOutcome(typeof path === 'string' ? readPath(value, path) : value);
      if (result) {
        hasEvidence = true;
        const identified = { ...result, nodeId, ...(row.runId ? { runId: row.runId } : {}) };
        if (!found.some((candidate) => candidate.row === row && JSON.stringify(candidate.outcome) === JSON.stringify(identified))) {
          found.push({ outcome: identified, row });
        }
      }
    }
    return hasEvidence;
  };
  for (const output of outputs) visit(output.id, object(output.config)?.portId ?? 'value', undefined, new Set());

  const unverified = protectedRows.find((row) => !found.some((candidate) => candidate.row === row));
  if (unverified) return uncertain('操作可能已发生，但缺少可读取的业务结果；重试前请核验外部状态', unverified);
  if (found.length === 1) return found[0]!.outcome;
  if (found.length > 1) {
    return {
      status: 'multiple', label: '多项业务结果', level: 'info', missingRequired: [],
      reason: found.map(({ outcome }) => `${outcome.label ?? outcome.status}：${outcome.reason}`).join('；'),
    };
  }
  if (run.status !== 'success') {
    return { status: 'failed', label: '业务失败', level: 'error', reason: '运行未完成，且未发现需要核验的外部操作', missingRequired: [] };
  }
  return uncertain('缺少可读取的业务结果，无法确认实际落点');
}
