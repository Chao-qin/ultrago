import type { BookNodeConfig, FlowGraph } from './flow-types.js';

export interface ResumeRunRow {
  nodeId: string;
  nodeType: string;
  status: string;
  startedAt?: Date | string | null;
  runId?: string | null;
  childFlowRunId?: string | null;
  iteration?: number | null;
}

export function getResumeBlockReason(graph: FlowGraph, rerunRows: readonly ResumeRunRow[]): string | null {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  for (const row of rerunRows) {
    const node = nodes.get(row.nodeId);
    const started = row.startedAt != null || row.status === 'running' || row.status === 'success';
    const name = node?.label || row.nodeId;
    if (node?.type === 'flow' || row.nodeType === 'flow') {
      if (started || row.childFlowRunId) {
        const child = row.childFlowRunId ? ` ${row.childFlowRunId}` : '';
        return `子流程「${name}」可能已执行外部操作，续跑将重新触发子流程，请先人工核验旧子运行${child} 的结果，当前禁止自动重试。`;
      }
      continue;
    }
    if (node?.type !== 'book' && row.nodeType !== 'book') continue;
    const policy = node?.type === 'book' ? (node.config as BookNodeConfig).resumePolicy : undefined;
    if (policy === 'retry') continue;
    if (!started && !row.runId) continue;
    const compatibility = policy === 'verify-before-retry' ? '' : '旧版快照缺少明确的恢复保护声明；';
    return `${compatibility}节点「${name}」可能已提交外部操作，续跑会再次执行，请先人工核验远端结果，当前禁止自动重试。`;
  }
  return null;
}
