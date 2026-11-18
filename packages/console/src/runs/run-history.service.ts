import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { parseRunStatusFilter } from '@bcp/shared';
import { PrismaService } from '../prisma/prisma.service.js';
import { mergeHistoryPage, parseHistoryQuery } from './run-history.js';
import type { HistoryQuery } from './run-history.js';

@Injectable()
export class RunHistoryService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async list(query: HistoryQuery) {
    const { page: requestedPage, pageSize, search, includeDeleted } = parseHistoryQuery(query);
    let statuses: string[] | undefined;
    try {
      statuses = parseRunStatusFilter(query.status);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    const base = { ...(includeDeleted ? {} : { deletedAt: null }), ...(statuses ? { status: { in: statuses } } : {}) };
    const runWhere: Prisma.RunWhereInput = {
      ...base,
      ...(query.targetType ? { targetType: query.targetType } : {}),
      ...(search ? { OR: [{ book: { name: { contains: search } } }, { script: { name: { contains: search } } }, { flow: { name: { contains: search } } }] } : {}),
    };
    const flowWhere: Prisma.FlowRunWhereInput = { ...base, ...(search ? { flow: { name: { contains: search } } } : {}) };
    const withFlows = !query.targetType || query.targetType === 'flow';
    return this.prisma.$transaction(async (tx) => {
      const [runCount, flowCount] = await Promise.all([
        tx.run.count({ where: runWhere }),
        withFlows ? tx.flowRun.count({ where: flowWhere }) : Promise.resolve(0),
      ]);
      const total = runCount + flowCount;
      const page = Math.min(requestedPage, Math.max(1, Math.ceil(total / pageSize)));
      const take = page * pageSize;
      const common = { id: true, status: true, trigger: true, mode: true, queuedAt: true, durationMs: true, deletedAt: true } as const;
      const [runs, flows] = await Promise.all([
        tx.run.findMany({ where: runWhere, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], take,
          select: { ...common, targetType: true, book: { select: { name: true } }, script: { select: { name: true } }, flow: { select: { name: true } } } }),
        withFlows ? tx.flowRun.findMany({ where: flowWhere, orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }], take,
          select: { ...common, flow: { select: { name: true } } } }) : Promise.resolve([]),
      ]);
      const rows = [
        ...runs.map((row) => ({ ...row, source: 'run', key: `run:${row.id}` })),
        ...flows.map((row) => ({ ...row, targetType: 'flow', source: 'flow', key: `flow:${row.id}`, book: null, script: null })),
      ];
      return { items: mergeHistoryPage(rows, page, pageSize), total, page, pageSize };
    });
  }
}
