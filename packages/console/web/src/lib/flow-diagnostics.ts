import { explainBranch, redactDiagnostic, summarizeFlowRun } from '@bcp/shared';
import type { BranchCaseExplanation, BranchNodeConfig } from '@bcp/shared';
import type { FlowRunRow } from './types';

function object(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function evidence(value: unknown): Record<string, unknown> | null {
  for (let depth = 0; depth < 3 && typeof value === 'string'; depth += 1) {
    if (value.length > 1_000_000) return null;
    try { value = JSON.parse(value); }
    catch { return null; }
  }
  const parsed = object(value);
  return parsed && !('$ref' in parsed) ? parsed : null;
}

interface BranchDiagnostic {
  key: string;
  label: string;
  iteration: number | null;
  state: 'available' | 'unavailable' | 'not_run';
  selectedPort: string | null;
  cases: BranchCaseExplanation[];
  notice: string | null;
}

interface PhaseTiming {
  key: string;
  label: string;
  totalMs: number;
  stages: Array<{ name: string; durationMs: number; status: string }>;
}

export function diagnosticRun(run: FlowRunRow): FlowRunRow {
  return redactDiagnostic(run) as FlowRunRow;
}

export function deriveFlowDiagnostics(raw: FlowRunRow) {
  const run = diagnosticRun(raw);
  const snapshot = evidence(run.graphSnapshot);
  const snapshotAvailable = Array.isArray(snapshot?.nodes);
  const nodes = snapshotAvailable ? (snapshot!.nodes as unknown[]).map(object).filter((node): node is Record<string, unknown> => !!node) : [];
  const labelOf = (nodeId: string) => {
    const label = nodes.find((node) => node.id === nodeId)?.label;
    return typeof label === 'string' && label ? label : nodeId;
  };
  const branches = nodes.filter((node) => node.type === 'branch').flatMap((node): BranchDiagnostic[] => {
    const rows = run.nodes?.filter((row) => row.nodeId === node.id) ?? [];
    return (rows.length ? rows : [undefined]).map((row) => {
      const base = { key: row?.id ?? String(node.id), label: labelOf(String(node.id)), iteration: row?.iteration ?? null, cases: [] as BranchCaseExplanation[], selectedPort: null };
      if (!row || ['skipped', 'pending', 'ready'].includes(row.status)) return { ...base, state: 'not_run', notice: '该分支尚未执行或已跳过' };
      const output = evidence(row.outputJson);
      const keys = output ? Object.keys(output) : [];
      const selectedPort = row.status === 'success' && output && keys.length <= 1 ? keys[0] ?? '' : null;
      const input = evidence(row.inputJson);
      const branchInput = input?.input ?? input;
      const branchObject = object(branchInput);
      const config = object(node.config);
      if (!input || (branchObject && '$ref' in branchObject)) return { ...base, selectedPort, state: 'unavailable', notice: '输入证据不可用（历史缺失、无法解析或已转存）' };
      if (!config || (config.cases !== undefined && (!Array.isArray(config.cases) || config.cases.some((value) => {
        const branchCase = object(value);
        return !branchCase || typeof branchCase.id !== 'string' || typeof branchCase.op !== 'string';
      })))) return { ...base, selectedPort, state: 'unavailable', notice: '快照分支配置不可用' };
      const explanation = explainBranch(config as unknown as BranchNodeConfig, branchInput);
      return { ...base, selectedPort, state: 'available', cases: explanation.cases, notice: selectedPort === null ? '未记录实际选择端口' : null };
    });
  });
  const timings: PhaseTiming[] = [];
  for (const row of run.nodes ?? []) {
    const output = evidence(row.outputJson);
    const timing = object(object(output?.output)?.phaseTimings ?? output?.phaseTimings);
    if (!timing || typeof timing.totalMs !== 'number' || !Number.isFinite(timing.totalMs) || timing.totalMs < 0 || !Array.isArray(timing.stages)) continue;
    const stages = timing.stages.map(object).filter((stage): stage is Record<string, unknown> => !!stage).flatMap((stage) =>
      typeof stage.name === 'string' && typeof stage.durationMs === 'number' && Number.isFinite(stage.durationMs) && stage.durationMs >= 0 && typeof stage.status === 'string'
        ? [{ name: stage.name, durationMs: stage.durationMs, status: stage.status }] : []);
    timings.push({ key: row.id, label: `${labelOf(row.nodeId)}${row.iteration === null ? '' : ` #${row.iteration}`}`, totalMs: timing.totalMs, stages });
  }
  const business = summarizeFlowRun(run);
  const businessRunId = business?.runId && run.nodes?.some((node) => node.nodeId === business.nodeId && node.runId === business.runId) ? business.runId : null;
  return {
    run, business, businessRunId, branches, timings, snapshotAvailable,
    // 运行级错误原来单独占一条全宽横幅，但失败的节点卡片与右侧面板往往已经在讲
    // 同一句话。折叠进面板后要能指名道姓，所以把失败节点标签一起交出去。
    failedNodeLabel: run.failedNodeId ? labelOf(run.failedNodeId) : null,
    resumeNotice: run.resumeBlockReason === undefined ? '旧版服务未提供恢复保护判定；恢复前请核验外部状态。' : run.resumeBlockReason,
  };
}

export function exportFlowDiagnostics(run: FlowRunRow): string {
  return JSON.stringify({ redacted: true, formatVersion: 1, run: diagnosticRun(run) }, null, 2);
}
