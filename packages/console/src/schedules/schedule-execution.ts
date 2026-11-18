import { createHash } from 'node:crypto';

export interface ScheduleExecution {
  scheduleId: string;
  dedupeKey: string;
}

export function scheduleExecutionId(kind: 'flow' | 'script', execution: ScheduleExecution): string {
  // Run 的现有唯一索引只覆盖 bookId；脚本通过主键原子认领执行权。
  const digest = createHash('sha256').update(JSON.stringify([kind, execution.scheduleId, execution.dedupeKey])).digest('hex');
  return `scheduled_${kind}_${digest}`;
}

export function isUniqueViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'P2002';
}
