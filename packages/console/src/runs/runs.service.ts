import { BadRequestException, Injectable, Logger, NotFoundException, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { EnqueueService } from "./enqueue.service.js";
import { BackendClient } from "../backend-client/backend-client.service.js";
import { DispatcherService } from "./dispatcher.service.js";
import { DeliveryIngestService } from "./delivery-ingest.service.js";
import { isParamMap, parseConsoleDeliveries, parseConsoleParams, parseRunStatusFilter } from "@bcp/shared";
import type { Delivery, ParamMap, TriggerRunInput } from "@bcp/shared";
import { decodeStepPreview } from './step-preview.js';

@Injectable()
export class RunsService {
  private readonly logger = new Logger(RunsService.name);
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(EnqueueService) private readonly enqueue: EnqueueService,
    @Inject(BackendClient) private readonly backend: BackendClient,
    @Inject(DispatcherService) private readonly dispatcher: DispatcherService,
    @Inject(DeliveryIngestService) private readonly deliveryIngest: DeliveryIngestService,
  ) {}

  async list(query: { bookId?: string; status?: string | string[]; limit?: string | number; includeDeleted?: boolean }) {
    const where: Record<string, unknown> = {};
    if (!query.includeDeleted) where.deletedAt = null;
    if (query.bookId) where.bookId = query.bookId;
    const statuses = (() => {
      try { return parseRunStatusFilter(query.status); } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    })();
    if (statuses?.length) where.status = { in: statuses };
    if (statuses && statuses.length === 0) return [];
    return this.prisma.run.findMany({
      where,
      orderBy: { queuedAt: "desc" },
      take: Math.min(Number(query.limit) || 100, 500),
      include: {
        book: { select: { id: true, name: true, description: true } },
        flow: { select: { id: true, name: true } },
        script: { select: { id: true, name: true } },
      },
    });
  }

  async findById(id: string) {
    const run = await this.prisma.run.findFirst({
      where: { id, deletedAt: null },
      include: {
        book: true,
        flow: { select: { id: true, name: true } },
        script: { select: { id: true, name: true } },
        steps: { where: { deletedAt: null }, orderBy: { stepIndex: "asc" } },
        // The run's product and the files it wrote are deliberately NOT joined
        // in: they are SchemaRecord rows, fetched by source through
        // /api/schema-records. Including them would put this endpoint back in
        // the business of shipping a multi-megabyte payload on every poll of a
        // page that refetches every 2s while a run is active.
        deliveries: { where: { deletedAt: null }, orderBy: { deliveryIndex: "asc" } },
      },
    });
    if (!run) throw new NotFoundException(`run ${id} not found`);
    return { ...run, steps: run.steps.map(step => {
      const { preview, metadata } = decodeStepPreview(step.valuePreview);
      return {
        ...step, valuePreview: step.valuePreview === null ? null : preview,
        resultAvailable: !!metadata,
        resultChars: metadata?.chars,
        previewTruncated: metadata?.truncated,
        upstreamTruncated: metadata?.upstreamTruncated,
      };
    }) };
  }

  /** Public entry point for the API. Enqueue + immediately nudge the
   *  dispatcher so the user doesn't have to wait for the next tick.
   *  Optional `dedupeKey` lets the caller be idempotent across retries
   *  or double-clicks; the enqueue layer derives one if you don't. */
  async trigger(input: TriggerRunInput) {
    if (!input.bookId) throw new BadRequestException("bookId is required");
    if (!isParamMap(input.params)) throw new BadRequestException("params must be a plain object map");
    if (input.deliveryOverrides !== undefined && !Array.isArray(input.deliveryOverrides)) {
      throw new BadRequestException("deliveryOverrides must be an array");
    }
    const r = await this.enqueue.enqueue({
      bookId: input.bookId,
      params: input.params,
      mode: input.mode ?? "auto",
      trigger: "manual",
      dedupeKey: input.dedupeKey,
      deliveryOverrides: input.deliveryOverrides,
    });
    // Nudge dispatcher so a manual trigger doesn't sit in pending for up
    // to the 200ms polling tick.
    this.dispatcher.kick();
    return r;
  }

  async cancel(id: string) {
    // Entry gate: a deleted run is not on any page the user could press Cancel
    // from, so reaching this with one is an API call about something already
    // withdrawn. The state transition further down is deliberately NOT filtered
    // — once a row is admitted here, its status machine runs to completion.
    const run = await this.prisma.run.findFirst({ where: { id, deletedAt: null } });
    if (!run) throw new NotFoundException(`run ${id} not found`);
    if (run.status === 'cancelled') {
      return run.planId ? this.stopBackendPlan(run.planId) : { ok: true, status: 'cancelled' };
    }
    if (run.finishedAt || ["success", "failed", "escalated", "cancelled"].includes(run.status)) {
      return { ok: false, error: `run already finished (${run.status})` };
    }
    // Commit the user's cancellation before asking the backend to stop. A late
    // backend terminal snapshot then becomes a no-op at the ingest boundary.
    const cancelledAt = new Date();
    // deletedAt is deliberately absent here — this is the transition the gate
    // above admits to. Once a row passes that check its status machine runs to
    // completion; re-filtering would leave a soft-deleted run stuck mid-flight
    // with nothing able to stop it.
    const claimed = await this.prisma.run.updateMany({
      where: {
        id,
        finishedAt: null,
        status: { in: ["pending", "queued", "starting", "running", "needsConfirm", "needsJudge", "noAction"] },
      },
      data: { status: "cancelled", finishedAt: cancelledAt, errorMessage: "cancelled by user", startClaimToken: null, startClaimUntil: null },
    });
    if (claimed.count !== 1) {
      const current = await this.prisma.run.findUnique({ where: { id } });
      return { ok: false, error: `run already finished (${current?.status ?? "unknown"})` };
    }

    await this.deliveryIngest.enqueueCancelled(id);
    if (!run.planId) {
      return { ok: true, status: "cancelled" };
    }
    return this.stopBackendPlan(run.planId);
  }

  private async stopBackendPlan(planId: string) {
    try {
      const result = await this.backend.cancelRun(planId);
      return { ok: true, status: result.status };
    } catch (e) {
      this.logger.warn(`backend cancelRun failed: ${e instanceof Error ? e.message : String(e)}`);
      const msg = e instanceof Error ? e.message : "";
      if (msg.includes('not found') || msg.includes('already finished') || msg.includes('HTTP 404')) {
        return { ok: true, status: 'cancelled', note: 'backend run was already gone or finished' };
      }
      throw e;
    }
  }

  /** Spawn a new run that reuses the original's params. Same enqueue
   *  semantics: if a run for this book is already active, retry queues. */
  async retry(id: string) {
    const old = await this.prisma.run.findFirst({ where: { id, deletedAt: null } });
    if (!old) throw new NotFoundException(`run ${id} not found`);
    let params: ParamMap;
    try {
      params = parseConsoleParams(old.paramsJson);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
    let deliveryOverrides: Delivery[] | undefined;
    const snapshot = old.deliverySnapshotJson ?? old.deliveryOverridesJson;
    if (snapshot) {
      try {
        const parsed = JSON.parse(snapshot);
        if (!Array.isArray(parsed)) throw new Error("delivery overrides must be an array");
        deliveryOverrides = parseConsoleDeliveries(snapshot) as Delivery[];
      } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }
    const r = await this.enqueue.enqueue({
      bookId: old.bookId!,
      params,
      mode: old.mode as "assisted" | "auto",
      trigger: "manual",
      parentRunId: old.id,
      attempt: old.attempt + 1,
      deliveryOverrides,
    });
    this.dispatcher.kick();
    return r;
  }
}
