import { Injectable, NotFoundException, BadRequestException, Logger, Inject } from "@nestjs/common";
import parser from "cron-parser";
import { randomUUID } from 'node:crypto';
import { PrismaService } from "../prisma/prisma.service.js";
import { EnqueueService } from "../runs/enqueue.service.js";
import { DispatcherService } from "../runs/dispatcher.service.js";
import { ScriptsService } from "../scripts/scripts.service.js";
import { FlowsService } from "../flows/flows.service.js";
import {
  isParamMap,
  normalizeParams,
  parseConsoleDeliveries,
  parseConsoleParamSchema,
  parseConsoleParams,
  resolveParamDefaults,
  validateParams,
} from "@bcp/shared";
import type { CreateScheduleInput, Delivery, ParamMap, ParamSpec, UpdateScheduleInput } from "@bcp/shared";

/** All fields except one target id + cronExpr are optional and default to
 *  sensible values. */
const DEFAULT_TIMEZONE = "Asia/Shanghai";

/** The target kinds a Schedule can fire. A schedule points at exactly one,
 *  and the id columns (bookId/flowId/scriptId) are the target's own. */
type TargetKind = "book" | "flow" | "script";

interface ExecutionStats {
  totalFired: number;
  totalSuccess: number;
  lastFiredAt: Date | null;
  lastFiredRunId: string | null;
  lastFiredStatus: string | null;
}

@Injectable()
export class SchedulesService {
  private readonly logger = new Logger(SchedulesService.name);

  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EnqueueService) private readonly enqueue: EnqueueService,
    @Inject(DispatcherService) private readonly dispatcher: DispatcherService,
    @Inject(ScriptsService) private readonly scripts: ScriptsService,
    @Inject(FlowsService) private readonly flows: FlowsService,
  ) {}

  /** Resolve the target row a schedule points at. Returns { id, name, enabled,
   *  kind, paramSchema }. Throws if the target is gone (404). */
  private async resolveTarget(input: {
    targetType?: string;
    bookId?: string;
    flowId?: string;
    scriptId?: string;
  }): Promise<{ kind: TargetKind; id: string; name: string; enabled: boolean; paramSchema?: string }> {
    const kind = (input.targetType ?? "book") as TargetKind;
    if (kind !== "book" && kind !== "flow" && kind !== "script") {
      throw new BadRequestException(`targetType must be "book" | "flow" | "script", got "${input.targetType}"`);
    }
    const id = kind === "book" ? input.bookId : kind === "flow" ? input.flowId : input.scriptId;
    if (!id) throw new BadRequestException(`${kind}Id is required for targetType "${kind}"`);
    // Exactly one id must be set (the others null) so a schedule can't point
    // at two targets and "it fires two" is never the reading a bug has to
    // explain.
    const otherIds = (kind === "book" ? [input.flowId, input.scriptId] : kind === "flow" ? [input.bookId, input.scriptId] : [input.bookId, input.flowId]).filter(Boolean);
    if (otherIds.length > 0) {
      throw new BadRequestException(`targetType "${kind}" must set exactly one of bookId/flowId/scriptId`);
    }

    if (kind === "book") {
      const book = await this.prisma.book.findFirst({ where: { id, deletedAt: null } });
      if (!book) throw new NotFoundException(`book ${id} not found`);
      return { kind, id, name: book.name, enabled: book.enabled, paramSchema: book.paramSchema };
    }
    if (kind === "flow") {
      const flow = await this.prisma.flow.findFirst({ where: { id, deletedAt: null } });
      if (!flow) throw new NotFoundException(`flow ${id} not found`);
      return { kind, id, name: flow.name, enabled: flow.enabled };
    }
    const script = await this.prisma.script.findFirst({ where: { id, deletedAt: null } });
    if (!script) throw new NotFoundException(`script ${id} not found`);
    return { kind, id, name: script.name, enabled: true };
  }

  /** List all schedules with their target info and run stats. Used by the
   *  /schedules page. Sorted by most-recently-fired first, then by name. */
  async list(opts: { includeDeleted?: boolean } = {}): Promise<
    Array<{
      id: string;
      name: string;
      description: string | null;
      targetType: TargetKind;
      book?: { id: string; name: string; enabled: boolean; deliveriesJson: string; deletedAt: Date | null } | null;
      flow?: { id: string; name: string; enabled: boolean; deletedAt: Date | null } | null;
      script?: { id: string; name: string; language: string; deletedAt: Date | null } | null;
      cronExpr: string;
      timezone: string;
      mode: string;
      paramsJson: string;
      deliveryOverridesJson: string | null;
      enabled: boolean;
      timeoutMs: number | null;
      createdAt: Date;
      updatedAt: Date;
      deletedAt: Date | null;
      lastFiredAt: Date | null;
      lastFiredStatus: string | null;
      lastFiredRunId: string | null;
      totalFired: number;
      totalSuccess: number;
    }>
  > {
    const rows = await this.prisma.schedule.findMany({
      where: opts.includeDeleted ? {} : { deletedAt: null },
      include: {
        book: { select: { id: true, name: true, enabled: true, deliveriesJson: true, deletedAt: true } },
        flow: { select: { id: true, name: true, enabled: true, deletedAt: true } },
        script: { select: { id: true, name: true, language: true, deletedAt: true } },
      },
      orderBy: [{ lastFiredAt: "desc" }, { name: "asc" }],
    });
    const kind = (r: { targetType: string }): TargetKind => (r.targetType === 'flow' ? 'flow' : r.targetType === 'script' ? 'script' : 'book');
    const [flowStats, scriptStats] = await Promise.all([
      this.executionStats(rows.filter(row => kind(row) === 'flow').map(row => row.id), 'flow'),
      this.executionStats(rows.filter(row => kind(row) === 'script').map(row => row.id), 'script'),
    ]);
    const listed = rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      targetType: kind(r),
      book: r.book ? { id: r.book.id, name: r.book.name, enabled: r.book.enabled, deliveriesJson: r.book.deliveriesJson, deletedAt: r.book.deletedAt } : null,
      flow: r.flow ? { id: r.flow.id, name: r.flow.name, enabled: r.flow.enabled, deletedAt: r.flow.deletedAt } : null,
      script: r.script ? { id: r.script.id, name: r.script.name, language: r.script.language, deletedAt: r.script.deletedAt } : null,
      cronExpr: r.cronExpr,
      timezone: r.timezone,
      mode: r.mode,
      paramsJson: r.paramsJson,
      deliveryOverridesJson: r.deliveryOverridesJson,
      enabled: r.enabled,
      timeoutMs: r.timeoutMs,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      deletedAt: r.deletedAt,
      lastFiredAt: r.lastFiredAt,
      lastFiredStatus: r.lastFiredStatus,
      lastFiredRunId: r.lastFiredRunId,
      totalFired: r.totalFired,
      totalSuccess: r.totalSuccess,
      ...(flowStats.get(r.id) ?? scriptStats.get(r.id) ?? {}),
    }));
    return listed.sort((a, b) => (b.lastFiredAt?.getTime() ?? 0) - (a.lastFiredAt?.getTime() ?? 0) || a.name.localeCompare(b.name));
  }

  async findById(id: string) {
    const s = await this.prisma.schedule.findFirst({
      where: { id, deletedAt: null },
      include: {
        book: { select: { id: true, name: true, enabled: true, deletedAt: true } },
        flow: { select: { id: true, name: true, enabled: true, deletedAt: true } },
        script: { select: { id: true, name: true, language: true, deletedAt: true } },
      },
    });
    if (!s) throw new NotFoundException(`schedule ${id} not found`);
    const kind: TargetKind = s.targetType === 'flow' ? 'flow' : s.targetType === 'script' ? 'script' : 'book';
    const stats = kind === 'book' ? undefined : (await this.executionStats([s.id], kind)).get(s.id);
    return {
      ...s,
      targetType: kind,
      book: s.book ? { id: s.book.id, name: s.book.name, enabled: s.book.enabled, deletedAt: s.book.deletedAt } : null,
      flow: s.flow ? { id: s.flow.id, name: s.flow.name, enabled: s.flow.enabled, deletedAt: s.flow.deletedAt } : null,
      script: s.script ? { id: s.script.id, name: s.script.name, language: s.script.language, deletedAt: s.script.deletedAt } : null,
      ...(stats ?? {}),
    };
  }

  private async executionStats(scheduleIds: string[], kind: 'flow' | 'script'): Promise<Map<string, ExecutionStats>> {
    const stats = new Map<string, ExecutionStats>(scheduleIds.map(id => [id, {
      totalFired: 0, totalSuccess: 0, lastFiredAt: null, lastFiredRunId: null, lastFiredStatus: null,
    }]));
    if (!scheduleIds.length) return stats;
    const group = {
      by: ['scheduleId' as const, 'status' as const],
      where: { scheduleId: { in: scheduleIds } },
      _count: { _all: true as const },
      _max: { queuedAt: true as const },
    };
    // 终态归属以运行记录为准，取消、失败和重启后的补偿不依赖计数器回调。
    const groups = kind === 'flow' ? await this.prisma.flowRun.groupBy(group) : await this.prisma.run.groupBy(group);
    for (const row of groups) {
      const entry = row.scheduleId ? stats.get(row.scheduleId) : undefined;
      if (!entry) continue;
      entry.totalFired += row._count._all;
      if (row.status === 'success') entry.totalSuccess += row._count._all;
      if (row._max.queuedAt && (!entry.lastFiredAt || row._max.queuedAt > entry.lastFiredAt)) entry.lastFiredAt = row._max.queuedAt;
    }
    const conditions = [...stats].flatMap(([scheduleId, entry]) => entry.lastFiredAt ? [{ scheduleId, queuedAt: entry.lastFiredAt }] : []);
    if (!conditions.length) return stats;
    const latest = {
      where: { OR: conditions },
      orderBy: { id: 'desc' as const },
      select: { id: true, status: true, scheduleId: true },
    };
    const lastRuns = kind === 'flow' ? await this.prisma.flowRun.findMany(latest) : await this.prisma.run.findMany(latest);
    for (const row of lastRuns) {
      const entry = row.scheduleId ? stats.get(row.scheduleId) : undefined;
      if (!entry || entry.lastFiredRunId) continue;
      entry.lastFiredRunId = row.id;
      entry.lastFiredStatus = row.status;
    }
    return stats;
  }

  /** Validate cron + check the target exists before insert. */
  async create(input: CreateScheduleInput) {
    const target = await this.resolveTarget(input);
    const cronExpr = input.cronExpr.trim();
    const timezone = input.timezone ?? DEFAULT_TIMEZONE;
    this.assertValidCron(cronExpr, timezone);
    this.assertValidTimeout(input.timeoutMs);

    // Default name = target name (so users don't HAVE to think of one for
    // the common single-schedule-per-target case).
    const name = (input.name ?? "").trim() || target.name;

    const paramsJson = target.kind === "book"
      ? normalizeScheduleParams(target.paramSchema!, input.paramsJson)
      : normalizeScheduleParamsAny(input.paramsJson);
    const deliveryOverridesJson = normalizeScheduleDeliveries(input.deliveryOverridesJson);

    const data = {
      targetType: target.kind as TargetKind,
      targetKey: `${target.kind}:${target.id}`,
      bookId: target.kind === "book" ? target.id : null,
      flowId: target.kind === "flow" ? target.id : null,
      scriptId: target.kind === "script" ? target.id : null,
      name,
      description: input.description ?? null,
      cronExpr,
      timezone,
      mode: input.mode ?? "auto",
      paramsJson,
      deliveryOverridesJson,
      enabled: input.enabled ?? true,
      timeoutMs: target.kind === "script" ? (input.timeoutMs ?? 60_000) : null,
    };
    return this.prisma.schedule.create({ data });
  }

  async update(id: string, input: UpdateScheduleInput) {
    const existing = await this.prisma.schedule.findFirst({
      where: { id, deletedAt: null },
      include: { book: { select: { paramSchema: true } } },
    });
    if (!existing) throw new NotFoundException(`schedule ${id} not found`);

    if (input.cronExpr !== undefined || input.timezone !== undefined) {
      this.assertValidCron(input.cronExpr ?? existing.cronExpr, input.timezone ?? existing.timezone);
    }
    this.assertValidTimeout(input.timeoutMs);
    const paramsJson = input.paramsJson === undefined
      ? undefined
      : (existing.targetType === "book" && existing.book
          ? normalizeScheduleParams(existing.book.paramSchema, input.paramsJson)
          : normalizeScheduleParamsAny(input.paramsJson));
    const deliveryOverridesJson = input.deliveryOverridesJson === undefined
      ? undefined
      : normalizeScheduleDeliveries(input.deliveryOverridesJson);

    return this.prisma.schedule.update({
      where: { id },
      data: {
        name: input.name,
        description: input.description,
        cronExpr: input.cronExpr,
        timezone: input.timezone,
        mode: input.mode,
        paramsJson,
        deliveryOverridesJson,
        enabled: input.enabled,
        timeoutMs: input.timeoutMs === null ? null : input.timeoutMs,
      },
    });
  }

  /** Quick toggle: flip enabled without going through a full PATCH.
   *
   *  The read and the write share one transaction so a concurrent `remove()`
   *  can't slip between them and resurrect a deleted row. */
  async toggle(id: string) {
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.schedule.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException(`schedule ${id} not found`);
      return tx.schedule.update({ where: { id }, data: { enabled: !existing.enabled } });
    });
  }

  /** 手动触发使用独立随机键，同一毫秒内的两次请求也不会共用运行。 */
  async runNow(id: string, paramsOverride?: ParamMap) {
    const s = await this.prisma.schedule.findFirst({
      where: { id, deletedAt: null },
      include: {
        book: { select: { id: true, name: true, enabled: true } },
        flow: { select: { id: true, name: true, enabled: true } },
        script: { select: { id: true, name: true, language: true, source: true, inputSchema: true, outputSchema: true } },
      },
    });
    if (!s) throw new NotFoundException(`schedule ${id} not found`);
    if (paramsOverride !== undefined && !isParamMap(paramsOverride)) {
      throw new BadRequestException("paramsOverride must be a plain object map");
    }
    const baseParams = parseParamMap(s.paramsJson);
    const params = { ...baseParams, ...(paramsOverride ?? {}) };
    const execution = { scheduleId: s.id, dedupeKey: `manual:${s.id}:${randomUUID()}` };
    // Rows predating the expansion may have a NULL/empty targetType; treat them
    // as book (the only kind history could have been).
    const targetType = s.targetType === "flow" || s.targetType === "script" ? s.targetType : "book";

    if (targetType === "book") {
      if (!s.bookId || !s.book) throw new BadRequestException("book schedule is out of sync");
      if (!s.book.enabled) throw new BadRequestException(`book "${s.book.name}" is disabled`);
      const result = await this.enqueue.enqueue({
        bookId: s.bookId,
        params,
        mode: s.mode === "assisted" ? "assisted" : "auto",
        trigger: "schedule",
        scheduleId: s.id,
        timezone: s.timezone,
        deliveryOverrides: parseScheduleDeliveries(s.deliveryOverridesJson),
        dedupeKey: execution.dedupeKey,
      });
      this.dispatcher.kick();
      return result;
    }
    if (targetType === "flow") {
      if (!s.flowId) throw new BadRequestException("flow schedule is out of sync");
      const run = await this.flows.trigger(s.flowId, params, 'schedule', s.mode, undefined, execution);
      this.dispatcher.kick();
      return run;
    }
    // script
    if (!s.scriptId || !s.script) throw new BadRequestException("script schedule is out of sync");
    const timeoutMs = s.timeoutMs ?? 60_000;
    const { runId, status } = await this.scripts.runForSchedule(s.script, params, new Date(), timeoutMs, execution);
    return { runId, status };
  }

  /** Soft delete — no cascade. A Schedule's Runs are NOT its children. */
  async remove(id: string) {
    const existing = await this.prisma.schedule.findFirst({ where: { id, deletedAt: null } });
    if (!existing) throw new NotFoundException(`schedule ${id} not found`);
    await this.prisma.schedule.update({ where: { id }, data: { deletedAt: new Date() } });
    return { ok: true };
  }

  /** Real delete; Runs still get scheduleId=null via `onDelete: SetNull`. */
  async purge(id: string) {
    await this.prisma.schedule.delete({ where: { id } });
    return { ok: true };
  }

  /** Compute the next N fire times for a schedule. Used by the list view
   *  to show countdowns. */
  async nextFires(id: string, n = 3): Promise<Date[]> {
    const s = await this.prisma.schedule.findUnique({ where: { id } });
    if (!s) throw new NotFoundException(`schedule ${id} not found`);
    if (!s.enabled || s.deletedAt) return [];
    try {
      this.assertValidCron(s.cronExpr, s.timezone);
      return this.computeNextFires(s.cronExpr, s.timezone, n);
    } catch (error) {
      this.logger.warn(`schedule ${id} preview unavailable: ${error instanceof Error ? error.message : String(error)}`);
      return [];
    }
  }

  private computeNextFires(cronExpr: string, timezone: string, n: number): Date[] {
    const interval = parser.parseExpression(cronExpr, { currentDate: new Date(), tz: timezone });
    const out: Date[] = [];
    for (let i = 0; i < n; i++) {
      try {
        out.push(interval.next().toDate());
      } catch {
        break;
      }
    }
    return out;
  }

  private assertValidCron(cronExpr: string, timezone: string): void {
    try {
      if (typeof cronExpr !== 'string' || cronExpr.trim().split(/\s+/).length !== 5) {
        throw new Error('expected five cron fields (minute hour day month weekday)');
      }
      new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
      parser.parseExpression(cronExpr, { tz: timezone });
    } catch (e) {
      throw new BadRequestException(
        `invalid cron expression "${cronExpr}" for timezone "${timezone}": ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
  }

  private assertValidTimeout(timeoutMs: unknown): void {
    if (timeoutMs === undefined || timeoutMs === null) return;
    if (typeof timeoutMs !== 'number' || !Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
      throw new BadRequestException('timeoutMs must be a positive integer');
    }
  }
}

/** Normalize a schedule's persisted parameter map with the shared runtime for a
 *  book target (whose declared schema we can validate against). */
export function normalizeScheduleParams(paramSchema: string, paramsJson = "{}"): string {
  const raw = parseParamMap(paramsJson);
  let declared: ParamSpec[];
  try {
    declared = parseConsoleParamSchema(paramSchema);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
  const resolved = resolveParamDefaults(declared, raw);
  const normalized = normalizeParams(declared, resolved);
  const errors = validateParams(declared, normalized);
  if (errors.length) throw new BadRequestException(errors.join("; "));
  return JSON.stringify(normalized);
}

/** Normalize a schedule's params for a non-book target (flow/script) — no
 *  declared schema, so just require a plain map and pass it through. */
function normalizeScheduleParamsAny(paramsJson = "{}"): string {
  const raw = parseParamMap(paramsJson);
  return JSON.stringify(raw);
}

function parseParamMap(json: string): ParamMap {
  try {
    return parseConsoleParams(json);
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
}

export function normalizeScheduleDeliveries(value?: string | null): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new BadRequestException("deliveryOverridesJson must be a JSON string");
  if (value.trim() === "") return null;
  try {
    return JSON.stringify(parseConsoleDeliveries(value, "deliveryOverridesJson"));
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
}

function parseScheduleDeliveries(value: string | null): Delivery[] | undefined {
  if (!value) return undefined;
  try {
    return parseConsoleDeliveries(value, "deliveryOverridesJson");
  } catch (error) {
    throw new BadRequestException(error instanceof Error ? error.message : String(error));
  }
}
