import { Module } from "@nestjs/common";
import { FlowRunsController, FlowsController } from "./flows.controller.js";
import { FlowsService } from "./flows.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SchemasModule } from "../schemas/schemas.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { RecordsModule } from "../records/records.module.js";
import { FlowRunnerService } from "./flow-runner.service.js";

@Module({
  // SchemasModule because a script or transform node cites its contract by
  // name@version — resolving those is the registry's job, not a second lookup
  // reimplemented here.
  // RunsModule for EnqueueService and DispatcherService: a book node is
  // enqueued through the same door a manual trigger uses, and the runner rides
  // the dispatcher's tick. The dependency runs one way only — runs knows
  // nothing about flows.
  // RecordsModule so a book node can read back a product that landed on the
  // file branch, through records/'s own accessor rather than a second copy of
  // the store path.
  imports: [PrismaModule, SchemasModule, RunsModule, RecordsModule],
  controllers: [FlowsController, FlowRunsController],
  providers: [FlowsService, FlowRunnerService],
  exports: [FlowsService, FlowRunnerService],
})
export class FlowsModule {}
