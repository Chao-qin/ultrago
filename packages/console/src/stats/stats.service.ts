import { Injectable, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";

/** The dashboard's time range. Anything outside 1..90 collapses to the default:
 *  a `?days=abc` or `?days=99999` must not turn into an unbounded query. */
export const DEFAULT_RANGE_DAYS = 7;
export function clampRangeDays(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 90) return DEFAULT_RANGE_DAYS;
  return n;
}

@Injectable()
export class StatsService {
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async overview(days: number = DEFAULT_RANGE_DAYS) {
    const range = clampRangeDays(days);
    const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const rangeAgo = new Date(Date.now() - range * 24 * 60 * 60 * 1000);

    const [
      bookCount,
      runsToday,
      runsInRange,
      successInRange,
      runningNow,
      recent,
      perDay,
      recentFailures,
      rangeRuns,
    // Every figure on this page is something a person reads and compares, so
    // all of them exclude deleted rows — a dashboard that counts things the
    // rest of the console refuses to show is a dashboard nobody can reconcile.
    ] = await Promise.all([
      this.prisma.book.count({ where: { deletedAt: null } }),
      this.prisma.run.count({ where: { deletedAt: null, queuedAt: { gte: dayAgo } } }),
      this.prisma.run.count({ where: { deletedAt: null, queuedAt: { gte: rangeAgo } } }),
      this.prisma.run.count({ where: { deletedAt: null, queuedAt: { gte: rangeAgo }, status: "success" } }),
      this.prisma.run.count({ where: { deletedAt: null, status: { in: ["pending", "queued", "starting", "running"] } } }),
      this.prisma.run.findMany({
        where: { deletedAt: null },
        orderBy: { queuedAt: "desc" },
        take: 10,
        include: { book: { select: { name: true } } },
      }),
      this.bucketRunsPerDay(rangeAgo, range),
      this.prisma.run.findMany({
         where: { deletedAt: null, status: { in: ["failed", "escalated"] } },
        orderBy: { queuedAt: "desc" },
        take: 5,
        include: { book: { select: { name: true } } },
      }),
      // One pass of (bookId, status) over the range feeds the per-book
      // ranking; a groupBy with two conditional counts would do too, but this
      // mirrors bucketRunsPerDay and the volume is console-sized.
      this.prisma.run.findMany({
        where: { deletedAt: null, queuedAt: { gte: rangeAgo }, bookId: { not: null } },
        select: { bookId: true, status: true },
      }),
    ]);

    const successRate = runsInRange > 0 ? successInRange / runsInRange : null;

    // Aggregate per book, rank by volume. A book whose runs all failed is the
    // most interesting row on the panel, so it must not be filtered out by a
    // "successful only" ranking — the rate column is what surfaces it.
    const perBook = new Map<string, { runs: number; success: number }>();
    for (const r of rangeRuns) {
      const key = r.bookId as string;
      const b = perBook.get(key) ?? { runs: 0, success: 0 };
      b.runs++;
      if (r.status === "success") b.success++;
      perBook.set(key, b);
    }
    const bookNames = new Map(
      (await this.prisma.book.findMany({
        where: { id: { in: [...perBook.keys()] }, deletedAt: null },
        select: { id: true, name: true },
      })).map((b) => [b.id, b.name]),
    );
    const topBooks = [...perBook.entries()]
      .map(([bookId, b]) => ({
        bookId,
        name: bookNames.get(bookId) ?? "已删除 Book",
        runs: b.runs,
        successRate: b.runs > 0 ? b.success / b.runs : null,
      }))
      .sort((a, b) => b.runs - a.runs)
      .slice(0, 8);

    return {
      days: range,
      bookCount,
      runsToday,
      runsThisWeek: runsInRange,
      successRate,
      runningNow,
      recent: recent.map((r) => ({
        id: r.id,
        book: { id: r.bookId, name: r.book?.name ?? "—", description: null },
        status: r.status,
        trigger: r.trigger,
        queuedAt: r.queuedAt,
        finishedAt: r.finishedAt,
        durationMs: r.durationMs,
        errorMessage: r.errorMessage,
      })),
      perDay,
      recentFailures: recentFailures.map((r) => ({
        id: r.id,
        book: { id: r.bookId, name: r.book?.name ?? "—", description: null },
        status: r.status,
        queuedAt: r.queuedAt,
        errorMessage: r.errorMessage,
      })),
      topBooks,
    };
  }

  /** Per-day run count for the last `range` days. Returns an array of {date,
   *  count, success, failed} for the chart on the dashboard. */
  private async bucketRunsPerDay(since: Date, range: number) {
    const runs = await this.prisma.run.findMany({
      where: { deletedAt: null, queuedAt: { gte: since } },
      select: { queuedAt: true, status: true },
    });
    const buckets = new Map<string, { date: string; count: number; success: number; failed: number }>();
    for (let i = range - 1; i >= 0; i--) {
      const d = new Date(Date.now() - i * 24 * 60 * 60 * 1000);
      const k = d.toISOString().slice(0, 10);
      buckets.set(k, { date: k, count: 0, success: 0, failed: 0 });
    }
    for (const r of runs) {
      const k = r.queuedAt.toISOString().slice(0, 10);
      const b = buckets.get(k);
      if (!b) continue;
      b.count++;
      if (r.status === "success") b.success++;
      else if (r.status === "failed") b.failed++;
    }
    return [...buckets.values()];
  }
}
