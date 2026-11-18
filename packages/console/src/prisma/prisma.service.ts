import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

/** Extends PrismaClient with Nest lifecycle hooks + sqlite WAL pragmas.
 *  WAL lets readers proceed alongside the writer, which matters for the
 *  per-book enqueue transaction: a long-running run reading status doesn't
 *  block the next trigger from acquiring the writer lock. */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  async onModuleInit(): Promise<void> {
    await this.$connect();
    // Only the first of these three actually configures anything, and the
    // distinction matters because the other two used to be described here as
    // load-bearing.
    //
    // `journal_mode = WAL` is a property of the DATABASE FILE, not of a
    // connection: it is written into the header once and every later connection
    // inherits it. Setting it from one connection is therefore correct and
    // sufficient. It RETURNS the chosen mode ("wal") as a row, so it must go
    // through $queryRawUnsafe — $executeRawUnsafe refuses any statement that
    // yields results and would fail the whole boot.
    await this.$queryRawUnsafe("PRAGMA journal_mode = WAL");

    // The next two are per-CONNECTION session state, and a one-shot query in
    // Prisma is a self-contained operation that takes one arbitrary connection
    // out of a pool sized `num_physical_cpus * 2 + 1` (513 on the development
    // host). So these reach exactly one connection and NOTHING MAY DEPEND ON
    // THEM. They are kept only as an explicit statement of the state this
    // application requires.
    //
    // That is survivable because the engine already guarantees both on every
    // connection it opens, which was measured rather than assumed (2026-08-28):
    // a fresh PrismaClient, before either line runs, reports `foreign_keys = 1`
    // and `busy_timeout = 5000`. The vendored SQLite is built with
    // DEFAULT_FOREIGN_KEYS, and rusqlite calls sqlite3_busy_timeout(db, 5000)
    // on every open. Foreign keys ARE enforced on every write.
    //
    // This comment previously called the busy timeout "the bedrock of the no
    // two runs of the same book at once guarantee". It never was: that
    // guarantee comes from the interactive `$transaction` in
    // enqueue.service.ts plus the `uniq_book_active_dedupe` index, neither of
    // which consults these lines. A guarantee attributed to the wrong mechanism
    // is worse than an undocumented one — it sends the next reader to defend
    // something that was never holding the weight.
    await this.$queryRawUnsafe("PRAGMA busy_timeout = 5000");
    await this.$queryRawUnsafe("PRAGMA foreign_keys = ON");
    this.logger.log("Prisma connected (WAL mode)");
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }
}
