import { Module, OnModuleInit, Injectable, Logger, Inject } from "@nestjs/common";
import { ScheduleModule } from "@nestjs/schedule";
import { PrismaModule } from "./prisma/prisma.module.js";
import { BooksModule } from "./books/books.module.js";
import { FilesyncModule } from "./filesync/filesync.module.js";
import { RunsModule } from "./runs/runs.module.js";
import { SchedulerModule } from "./scheduler/scheduler.module.js";
import { BackendClientModule } from "./backend-client/backend-client.module.js";
import { StatsModule } from "./stats/stats.module.js";
import { SchedulesModule } from "./schedules/schedules.module.js";
import { HealthController } from "./health.controller.js";
import { PrismaService } from "./prisma/prisma.service.js";
import { BackendClient } from "./backend-client/backend-client.service.js";
import { BrowserModule } from "./browser/browser.module.js";
import { UploadsModule } from "./uploads/uploads.module.js";
import { ImageBedModule } from "./image-bed/image-bed.module.js";
import { RecordsModule } from "./records/records.module.js";
import { StudioModule } from "./studio/studio.module.js";
import { SchemasModule } from "./schemas/schemas.module.js";
import { SchemaRecordsModule } from "./schema-records/schema-records.module.js";
import { FlowsModule } from "./flows/flows.module.js";
import { ScriptsModule } from "./scripts/scripts.module.js";
import { SettingsModule } from "./settings/settings.module.js";
import { BrowserEventsModule } from "./browser-events/browser-events.module.js";
import { LlmCallsModule } from "./llm-calls/llm-calls.module.js";

/**
 * Wires up the console. AppModule is responsible only for composition — each
 * feature lives in its own module.
 *
 * Filesync is MANUAL as of 2026-08-28: nothing indexes `resource/playbooks/`
 * on its own, and `POST /api/books/rescan` is the only thing that does. It
 * used to run here at boot and again inside every `BooksService.list()`, which
 * meant opening the Books page rewrote `Book.fileMtime` and bumped Prisma's
 * `@updatedAt` on all six rows — an unconditional upsert with no
 * "did the file actually change" test — so the tracked `resource/db/console.db`
 * could never stay clean. Boot no longer writes to the database at all.
 */
@Module({
  imports: [
    PrismaModule,
    ScheduleModule.forRoot(),
    BackendClientModule,
    BooksModule,
    FilesyncModule,
    RunsModule,
    SchedulerModule,
    StatsModule,
    SchedulesModule,
    BrowserModule,
    UploadsModule,
    ImageBedModule,
    RecordsModule,
    StudioModule,
    SchemasModule,
    SchemaRecordsModule,
    FlowsModule,
    ScriptsModule,
    SettingsModule,
    BrowserEventsModule,
    LlmCallsModule,
  ],
  controllers: [HealthController],
})
export class AppModule implements OnModuleInit {
  private readonly logger = new Logger(AppModule.name);
  constructor(@Inject(PrismaService) private readonly prisma: PrismaService) {}

  async onModuleInit(): Promise<void> {
    // Prisma will create the DB if it doesn't exist, but the SCHEMA is owned by
    // `prisma migrate deploy`. We surface a clear error if the user forgot to
    // migrate.
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
    } catch (e) {
      this.logger.error(
        `console database not initialized. Run \`pnpm --filter @bcp/console prisma:deploy\` (or \`pnpm run init\` from repo root). (${
          e instanceof Error ? e.message : String(e)
        })`,
      );
      throw e;
    }
    // Filesync is manual; boot does not index anything. Report what is already
    // in the table so an empty one is visible in the log rather than showing up
    // later as "the Books page is blank" — on a database that has never been
    // scanned, that is the expected state and `POST /api/books/rescan` (the
    // Books page's 重新扫描 button) is what fills it.
    const indexed = await this.prisma.book.count({ where: { deletedAt: null } });
    this.logger.log(
      indexed === 0
        ? "filesync: no books indexed yet — `pnpm start` indexes resource/playbooks/ right after boot (or POST /api/books/rescan)"
        : `filesync: manual only — ${indexed} book(s) already indexed, POST /api/books/rescan to re-index`,
    );
    // Same reasoning for the Schema registry, which has the same shape of
    // problem and a worse failure mode. Seeding it is a manual bootstrap
    // (`node scripts/register-schemas.mjs`, which posts to this server and so
    // needs it already listening) that `scripts/init.sh` cannot run for you.
    // Nothing else populates the table, and an empty one is not loudly broken:
    // `resolveRef` deliberately returns null rather than throwing
    // (filesync.service.ts), so a book citing `paramSchemaRef` silently falls
    // back to its inline contract with only a warning, while landed
    // SchemaRecord rows keep naming a contract the registry cannot resolve.
    // A line at boot is what turns "I forgot after resetting the database"
    // into something you can see.
    const registered = await this.prisma.schema.count({ where: { deletedAt: null } });
    this.logger.log(
      registered === 0
        ? "schema registry: EMPTY — books citing paramSchemaRef/outputSchemaRef will fall back to their inline contract. `pnpm start` seeds it right after boot; otherwise run `node scripts/seed-console.mjs`"
        : `schema registry: ${registered} schema(s) registered`,
    );
  }
}
