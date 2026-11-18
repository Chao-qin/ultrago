import { BadRequestException, Injectable, NotFoundException, Inject } from "@nestjs/common";
import { PrismaService } from "../prisma/prisma.service.js";
import { FilesyncService } from "../filesync/filesync.service.js";
import { normalizeTags } from "@bcp/shared";

export type BookWithLastRun = Awaited<ReturnType<BooksService["list"]>>[number];

interface BookListItem {
  id: string;
  name: string;
  description: string | null;
  goal: string;
  goalDetail: string | null;
  paramSchema: string;
  /** JSON Schema fragment the book promises to produce; null = no contract. */
  outputSchema: string | null;
  deliveriesJson: string;
  stepsCount: number;
  enabled: boolean;
  tags: string | null;
  filePath: string;
  fileMtime: Date;
  fileHash: string;
  updatedAt: Date;
  /** Soft-delete timestamp, null = live. Declared, not just projected: the
   *  "含已删除" switch has nothing to mark a row with unless this survives the
   *  hand-written field list below, and without it in the type a future edit
   *  could drop the line and take the switch's meaning with it silently. */
  deletedAt: Date | null;
  /** Schedules attached to this book — surfaced in the Books list so the
   *  "Add schedule" affordance can be skipped when a schedule already exists. */
  schedules: Array<{ id: string; name: string; cronExpr: string; enabled: boolean }>;
  lastRun: {
    id: string;
    status: string;
    trigger: string;
    queuedAt: Date;
    finishedAt: Date | null;
    durationMs: number | null;
  } | null;
}

@Injectable()
export class BooksService {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(FilesyncService) private readonly filesync: FilesyncService,
  ) {}

  /** Read the indexed books, each with its most recent run.
   *
   *  This does NOT re-read `resource/playbooks/` — a list request is a read,
   *  and it used to be a write: `rescan()` upserts unconditionally, with no
   *  "did the file change" test, so every load of the Books page rewrote
   *  `fileMtime` and bumped `@updatedAt` on every row and dirtied the tracked
   *  `resource/db/console.db`. A playbook edited on disk therefore shows up
   *  here only after `POST /api/books/rescan` (the page's 重新扫描 button). */
  async list(opts: { includeDeleted?: boolean } = {}): Promise<BookListItem[]> {
    const books = await this.prisma.book.findMany({
      where: opts.includeDeleted ? {} : { deletedAt: null },
      orderBy: { name: "asc" },
      include: {
        // The nested filters are not redundant with the outer one: a live book
        // can own a run or schedule that was deleted on its own, and "last run"
        // must mean the last one the user can still see.
        runs: {
          where: { deletedAt: null },
          orderBy: { queuedAt: "desc" },
          take: 1,
        },
        schedules: {
          where: { deletedAt: null },
          select: { id: true, name: true, cronExpr: true, enabled: true },
          orderBy: { createdAt: "asc" },
        },
      },
    });
    return books.map((b) => ({
      id: b.id,
      name: b.name,
      description: b.description,
      goal: b.goal,
      goalDetail: b.goalDetail,
      paramSchema: b.paramSchema,
      outputSchema: b.outputSchema,
      deliveriesJson: b.deliveriesJson,
      stepsCount: b.stepsCount,
      enabled: b.enabled,
      tags: normalizeTags(b.tags),
      filePath: b.filePath,
      fileMtime: b.fileMtime,
      fileHash: b.fileHash,
      updatedAt: b.updatedAt,
      deletedAt: b.deletedAt,
      schedules: b.schedules,
      lastRun: b.runs[0]
        ? {
            id: b.runs[0].id,
            status: b.runs[0].status,
            trigger: b.runs[0].trigger,
            queuedAt: b.runs[0].queuedAt,
            finishedAt: b.runs[0].finishedAt,
            durationMs: b.runs[0].durationMs,
          }
        : null,
    }));
  }

  // findFirst rather than findUnique: `deletedAt` is not part of any unique
  // key, and findUnique's `where` only accepts unique fields. Every detail
  // lookup below makes the same switch for the same reason.
  async findById(id: string) {
    const book = await this.prisma.book.findFirst({
      where: { id, deletedAt: null },
      include: {
        runs: {
          where: { deletedAt: null },
          orderBy: { queuedAt: "desc" },
          take: 20,
        },
      },
    });
    if (!book) throw new NotFoundException(`book ${id} not found`);
    return book;
  }

  async findByName(name: string) {
    return this.prisma.book.findFirst({ where: { name, deletedAt: null } });
  }

  /** Patch management metadata. Refuses to touch fields owned by the JSON
   *  file (goal / filePath / stepsCount / paramSchema / fileHash) — those
   *  come from the file and are reset on next rescan.
   *
   *  Resolves the row through `deletedAt: null` first, like every other mutator
   *  here and in flows / schedules / schemas. Without it a PATCH against a
   *  soft-deleted book succeeded and handed the caller a row that `findById`
   *  and `list()` both refuse to show — editing something already deleted, and
   *  `enabled: true` on it would be a resurrection the delete never sanctioned.
   *
   *  The check and the write share one transaction, like `delete()` below. Read
   *  then write as two statements leaves a window where a concurrent `delete()`
   *  commits between them, and the resurrection this guard exists to stop walks
   *  straight through it. Validation stays outside: rejecting a malformed patch
   *  is not a database decision and should not hold a transaction open. */
  async update(
    id: string,
    patch: { description?: string | null; enabled?: boolean; tags?: string | null },
  ) {
    const data: Record<string, unknown> = {};
    if ("description" in patch) data.description = patch.description;
    if ("enabled" in patch) data.enabled = patch.enabled;
    if ("tags" in patch) {
      try { data.tags = normalizeTags(patch.tags); } catch (error) {
        throw new BadRequestException(error instanceof Error ? error.message : String(error));
      }
    }
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.book.findFirst({ where: { id, deletedAt: null } });
      if (!existing) throw new NotFoundException(`book ${id} not found`);
      return tx.book.update({ where: { id }, data });
    });
  }

  /** Remove the console's view of a book. The JSON file is left in place
   *  (deleting it is the user's choice — UI offers both).
   *
   *  Soft delete, and the descendants go with it in ONE transaction. The
   *  foreign keys still say `onDelete: Cascade`, but that only fires on a real
   *  DELETE — nothing in the database mirrors it for a `deletedAt` write, so
   *  the cascade has to be spelled out here or the book's runs, steps,
   *  deliveries and schedules stay visible (and, in the scheduler's case, keep
   *  firing) with no parent to reach them from.
   *
   *  Not cascaded: the run's landed `SchemaRecord` rows. That table holds no
   *  foreign key to anything by design (see its model comment) — a payload
   *  outlives the bookkeeping that produced it, and the registry is meant to be
   *  discoverable rather than load-bearing. */
  async delete(id: string) {
    const deletedAt = new Date();
    return this.prisma.$transaction(async (tx) => {
      const book = await tx.book.findFirst({ where: { id, deletedAt: null } });
      if (!book) throw new NotFoundException(`book ${id} not found`);
      // Children first: if the transaction rolls back midway, a half-deleted
      // parent is worse than a half-deleted subtree.
      const ofBook = { run: { bookId: id }, deletedAt: null };
      await tx.stepRun.updateMany({ where: ofBook, data: { deletedAt } });
      await tx.deliveryRun.updateMany({ where: ofBook, data: { deletedAt } });
      await tx.run.updateMany({ where: { bookId: id, deletedAt: null }, data: { deletedAt } });
      // Schedules are children too (`onDelete: Cascade` on Schedule.bookId).
      // Skipping them would leave the scheduler firing a deleted book.
      await tx.schedule.updateMany({ where: { bookId: id, deletedAt: null }, data: { deletedAt } });
      return tx.book.update({ where: { id }, data: { deletedAt } });
    });
  }

  /** Really delete the row, letting the database's `onDelete: Cascade` take the
   *  descendants with it. Kept for the day someone genuinely needs the storage
   *  back; no controller reaches it, because "delete" in the UI means the
   *  reversible one above. */
  async purge(id: string) {
    return this.prisma.book.delete({ where: { id } });
  }

  /** Re-index `resource/playbooks/`. Forwards the whole `RescanResult` rather
   *  than the count it used to return: `missing` names books whose JSON file is
   *  no longer on disk, and that half is only useful if it reaches the caller —
   *  the Books page turns it into a warning. */
  async rescan() {
    return this.filesync.rescan();
  }
}
