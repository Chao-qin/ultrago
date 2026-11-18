import { Controller, Get, Inject, Query } from "@nestjs/common";
import { StatsService, clampRangeDays } from "./stats.service.js";

/** Stats endpoints that don't need the scheduler. (The /api/schedules
 *  endpoints are now under SchedulesController — the scheduler status
 *  endpoint is removed because schedules carry their own nextFires.) */
@Controller("api")
export class StatsController {
  constructor(@Inject(StatsService) private readonly stats: StatsService) {}

  @Get("stats/overview")
  overview(@Query("days") days?: string) {
    return this.stats.overview(clampRangeDays(days));
  }
}
