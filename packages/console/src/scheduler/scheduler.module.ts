import { Module } from "@nestjs/common";
import { SchedulerService } from "./scheduler.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { ScriptsModule } from "../scripts/scripts.module.js";
import { FlowsModule } from "../flows/flows.module.js";

@Module({
  imports: [PrismaModule, RunsModule, ScriptsModule, FlowsModule],
  providers: [SchedulerService],
  exports: [SchedulerService],
})
export class SchedulerModule {}
