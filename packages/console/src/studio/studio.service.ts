import { Injectable, Logger, OnModuleDestroy } from "@nestjs/common";
// Type-only: erased at compile time. The runtime handle is loaded lazily in
// connect() because `node:sqlite` only exists on Node >= 22.5, while this repo
// supports Node >= 20 (root package.json engines). A static import would make
// the WHOLE console fail to boot on Node 20 instead of just this one page.
import type { DatabaseSync } from "node:sqlite";
import { createNodeSQLiteExecutor } from "@prisma/studio-core/data/node-sqlite";
import { lintSQLiteWithExplainFallback } from "@prisma/studio-core/data/sqlite-core";
import { serializeError } from "@prisma/studio-core/data/bff";
import type { Executor } from "@prisma/studio-core/data";
import type { StudioRequest, StudioResponse } from "./studio.protocol.js";

/** `Executor` declares `executeTransaction` optional because some backends
 *  can't batch. The node-sqlite one always implements it (BEGIN/COMMIT around
 *  the batch), so we narrow once at connect time instead of null-checking on
 *  every edit Studio sends. */
type SqliteExecutor = Executor & Required<Pick<Executor, "executeTransaction">>;

/** The lint helper's options type requires an AbortSignal. node-sqlite runs
 *  the EXPLAIN synchronously and never consults it, so one shared
 *  never-aborted signal satisfies the type without pretending we support
 *  cancellation. */
const NEVER_ABORTED = new AbortController().signal;

/** Backend-for-frontend behind the embedded Prisma Studio (`@prisma/studio-core`).
 *  The Studio React component compiles every browse/edit gesture into SQL and
 *  POSTs it here; this service executes it and answers in Studio's `[error]` /
 *  `[null, result]` tuple shape.
 *
 *  It deliberately does NOT go through PrismaService: Studio speaks raw SQL
 *  against `sqlite_master` and arbitrary tables, which the Prisma client can't
 *  express. So we open a SECOND connection to the same file — safe because the
 *  DB is in WAL mode (readers never block the writer) and this connection sets
 *  the same busy_timeout, so a write racing an in-flight run waits instead of
 *  failing with SQLITE_BUSY.
 */
@Injectable()
export class StudioService implements OnModuleDestroy {
  private readonly logger = new Logger(StudioService.name);
  private connection: { db: DatabaseSync; executor: SqliteExecutor } | null = null;

  async handle(request: StudioRequest): Promise<StudioResponse> {
    const { executor } = await this.connect();
    switch (request.procedure) {
      case "query": {
        const [error, rows] = await executor.execute(request.query);
        return error ? [serializeError(error)] : [null, rows];
      }
      case "transaction": {
        const [error, results] = await executor.executeTransaction(request.queries);
        return error ? [serializeError(error)] : [null, results];
      }
      case "sequence": {
        // Two dependent queries, run in order. The client expects a tuple per
        // query, and stops reading at the first failure.
        const [first, second] = request.sequence;
        const [firstError, firstRows] = await executor.execute(first);
        if (firstError) return [[serializeError(firstError)]];
        const [secondError, secondRows] = await executor.execute(second);
        if (secondError) return [[null, firstRows], [serializeError(secondError)]];
        return [[null, firstRows], [null, secondRows]];
      }
      case "sql-lint": {
        // Diagnostics for the SQL editor's squiggles. The official helper
        // lints via EXPLAIN — it compiles the statement without running it.
        const [error, result] = await lintSQLiteWithExplainFallback(executor, { sql: request.sql, schema: request.schema }, { abortSignal: NEVER_ABORTED });
        if (error) return [serializeError(error)];
        return [null, { ...result, schemaVersion: request.schemaVersion }];
      }
    }
  }

  onModuleDestroy(): void {
    this.connection?.db.close();
    this.connection = null;
  }

  /** Opens the sqlite handle on first use, so a console that never visits the
   *  数据库 page never pays for a second connection — and, on a Node too old
   *  for `node:sqlite`, only this page fails rather than the whole app. */
  private async connect(): Promise<{ db: DatabaseSync; executor: SqliteExecutor }> {
    if (this.connection) return this.connection;

    let DatabaseSyncCtor: typeof DatabaseSync;
    try {
      ({ DatabaseSync: DatabaseSyncCtor } = await import("node:sqlite"));
    } catch {
      throw new Error(`数据库页需要 Node >= 22.5（内置 node:sqlite），当前 ${process.version}`);
    }

    // main.ts normalizes DATABASE_URL to an absolute `file:` URL before Nest
    // boots, so this is the same file PrismaService is attached to.
    const url = process.env.DATABASE_URL;
    if (!url?.startsWith("file:")) {
      throw new Error(`Prisma Studio needs a sqlite DATABASE_URL, got: ${url ?? "(unset)"}`);
    }
    const file = url.slice("file:".length).split("?")[0];

    const db = new DatabaseSyncCtor(file);
    // Mirror PrismaService's pragmas so Studio sees the same DB semantics the
    // app does — notably ON DELETE CASCADE actually cascading.
    db.exec("PRAGMA busy_timeout = 5000");
    db.exec("PRAGMA foreign_keys = ON");
    this.logger.log(`Prisma Studio attached to ${file}`);

    this.connection = { db, executor: createNodeSQLiteExecutor(db) as SqliteExecutor };
    return this.connection;
  }
}
