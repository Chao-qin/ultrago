export function aggregateNodeStatuses(rows: readonly { nodeId: string; status: string }[]): Map<string, string> {
  const priority: Record<string, number> = { running: 7, paused: 6, pending: 5, queued: 5, failed: 4, cancelled: 3, success: 2, succeeded: 2, skipped: 1 };
  const result = new Map<string, string>();
  for (const row of rows) {
    const status = row.status === 'succeeded' ? 'success' : row.status;
    const previous = result.get(row.nodeId);
    if (!previous || (priority[status] ?? 0) > (priority[previous] ?? 0)) result.set(row.nodeId, status);
  }
  return result;
}

export function isExecutingEdge(source: string, target: string, statuses: ReadonlyMap<string, string>): boolean {
  return statuses.get(target) === 'running' && ['running', 'success'].includes(statuses.get(source) ?? '');
}

export const FLOW_STATUS_LABELS: Record<string, string> = {
  pending: '等待执行', queued: '排队中', running: '运行中', paused: '已暂停',
  success: '成功', succeeded: '成功', failed: '失败', cancelled: '已取消', skipped: '已跳过',
};
