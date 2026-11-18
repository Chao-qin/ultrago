import { Module } from "@nestjs/common";
import { StatsController } from "./stats.controller.js";
import { StatsService } from "./stats.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SchedulerModule } from "../scheduler/scheduler.module.js";

@Module({
  imports: [PrismaModule, SchedulerModule],
  controllers: [StatsController],
  providers: [StatsService],
  exports: [StatsService],
})
export class StatsModule {}
