import { Module } from "@nestjs/common";
import { SchedulesService } from "./schedules.service.js";
import { SchedulesController } from "./schedules.controller.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RunsModule } from "../runs/runs.module.js";
import { ScriptsModule } from "../scripts/scripts.module.js";
import { FlowsModule } from "../flows/flows.module.js";

@Module({
  imports: [PrismaModule, RunsModule, ScriptsModule, FlowsModule],
  controllers: [SchedulesController],
  providers: [SchedulesService],
  exports: [SchedulesService],
})
export class SchedulesModule {}