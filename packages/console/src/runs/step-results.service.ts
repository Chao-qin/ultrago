import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { OnModuleDestroy } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service.js';
import { BackendClient } from '../backend-client/backend-client.service.js';
import { OutputLandingService } from './output-landing.service.js';
import { describeOutputs } from './output-type.js';
import { decodeStepPreview, encodeStepPreview, stepResultSource } from './step-preview.js';

interface ResultBody { raw: string; upstreamTruncated: boolean }
export interface ResultHistoryRow {
  valuePreview?: string;
  resultId?: string;
  resultChars?: number;
  upstreamTruncated?: boolean;
}

@Injectable()
export class StepResultsService implements OnModuleDestroy {
  private readonly logger = new Logger(StepResultsService.name);
  private readonly pending = new Map<string, { runId: string; row: ResultHistoryRow; attempts: number; nextAt: number }>();
  private timer?: ReturnType<typeof setTimeout>;
  private draining = false;
  private stopped = false;

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BackendClient) private readonly backend: BackendClient,
    @Inject(OutputLandingService) private readonly landing: OutputLandingService,
  ) {}

  enqueue(runId: string, history: ResultHistoryRow[]): void {
    if (this.stopped) return;
    for (const row of history) {
      if (!row.resultId) continue;
      const key = stepResultSource(runId, row.resultId);
      if (this.pending.has(key)) continue;
      if (this.pending.size >= 1000) {
        this.logger.warn('step result archival queue is full');
        break;
      }
      this.pending.set(key, { runId, row: { resultId: row.resultId }, attempts: 0, nextAt: 0 });
    }
    this.schedule();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.pending.clear();
  }

  private schedule(): void {
    if (this.stopped || this.draining || this.timer || !this.pending.size) return;
    const nextAt = Math.min(...Array.from(this.pending.values(), item => item.nextAt));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain().catch(error => this.logger.error(error instanceof Error ? error.stack : String(error)));
    }, Math.max(0, nextAt - Date.now()));
    this.timer.unref();
  }

  private async drain(): Promise<void> {
    if (this.stopped || this.draining) return;
    const ready = Array.from(this.pending.entries()).find(([, item]) => item.nextAt <= Date.now());
    if (!ready) { this.schedule(); return; }
    const [key, item] = ready;
    this.draining = true;
    let saved = false;
    try {
      saved = await this.archive(item.runId, [item.row]);
    } catch (error) {
      this.logger.warn(`step result archival retry: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      item.attempts++;
      if (saved || item.attempts >= 8) {
        this.pending.delete(key);
        if (!saved) this.logger.warn(`step result archival exhausted retries for ${key}`);
      } else {
        item.nextAt = Date.now() + Math.min(30_000, 2000 * 2 ** (item.attempts - 1));
      }
      this.draining = false;
      this.schedule();
    }
  }

  async archive(runId: string, history: ResultHistoryRow[]): Promise<boolean> {
    if (!history.some(row => row.resultId)) return true;
    const run = await this.prisma.run.findFirst({ where: { id: runId, deletedAt: null }, select: { planId: true, status: true, flowNodeRunId: true } });
    if (!run?.planId) return true;
    if (run.flowNodeRunId && !['failed', 'escalated', 'cancelled'].includes(run.status)) return true;
    let saved = true;
    for (const row of history) {
      if (!row.resultId) continue;
      const source = stepResultSource(runId, row.resultId);
      try {
        const existing = await this.prisma.schemaRecord.findFirst({ where: { source, deletedAt: null }, select: { id: true } });
        if (existing) continue;
        const body = await this.backend.getStepResult(run.planId, row.resultId);
        if (body) await this.landing.land(source, describeOutputs(body, null), null);
        else saved = false;
      } catch (error) {
        saved = false;
        this.logger.warn(`step result archive failed for ${source}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return saved;
  }

  preview(row: ResultHistoryRow): string | null {
    if (row.valuePreview === undefined) return null;
    if (!row.resultId || row.resultChars === undefined) return row.valuePreview;
    return encodeStepPreview(row.valuePreview, {
      resultId: row.resultId, chars: row.resultChars,
      truncated: row.resultChars > row.valuePreview.length,
      upstreamTruncated: row.upstreamTruncated === true,
    });
  }

  async read(runId: string, stepId: string) {
    const run = await this.prisma.run.findFirst({ where: { id: runId, deletedAt: null }, select: { planId: true } });
    if (!run) throw new NotFoundException('run not found');
    const step = await this.prisma.stepRun.findFirst({ where: { id: stepId, runId, deletedAt: null }, select: { valuePreview: true } });
    if (!step) throw new NotFoundException('step not found');
    const { metadata } = decodeStepPreview(step.valuePreview);
    if (!metadata) return { available: false as const, reason: '历史记录未保留完整步骤结果。' };
    const stored = await this.landing.readLandedValue(stepResultSource(runId, metadata.resultId));
    const body = stored ?? (run.planId ? await this.backend.getStepResult(run.planId, metadata.resultId) : undefined);
    if (!isResultBody(body)) return { available: false as const, reason: '完整结果未归档，且后端结果已过期或不可用。' };
    return { available: true as const, raw: body.raw, upstreamTruncated: body.upstreamTruncated };
  }
}

function isResultBody(value: unknown): value is ResultBody {
  return !!value && typeof value === 'object' && typeof (value as ResultBody).raw === 'string'
    && typeof (value as ResultBody).upstreamTruncated === 'boolean';
}
