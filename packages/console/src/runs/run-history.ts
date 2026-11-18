import { BadRequestException } from '@nestjs/common';

export interface HistoryQuery {
  page?: string;
  pageSize?: string;
  targetType?: string;
  status?: string | string[];
  search?: string;
  includeDeleted?: string;
}

export function parseHistoryQuery(query: HistoryQuery) {
  const page = Number(query.page ?? 1);
  const pageSize = Number(query.pageSize ?? 25);
  if (!Number.isSafeInteger(page) || page < 1 || page > 100000 ||
      !Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 100) {
    throw new BadRequestException('分页参数无效：page 必须为正整数，pageSize 为 1–100');
  }
  if (query.targetType && !['book', 'script', 'flow'].includes(query.targetType)) {
    throw new BadRequestException('运行类型必须为 book、script 或 flow');
  }
  return { page, pageSize, search: (query.search ?? '').trim(), includeDeleted: query.includeDeleted === 'true' };
}

export function mergeHistoryPage<T extends { id: string; source: string; queuedAt: Date }>(rows: T[], page: number, pageSize: number): T[] {
  return rows.sort((a, b) => b.queuedAt.getTime() - a.queuedAt.getTime() || b.id.localeCompare(a.id) || b.source.localeCompare(a.source))
    .slice((page - 1) * pageSize, page * pageSize);
}
