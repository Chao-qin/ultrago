import { Body, Controller, Delete, Get, Param, Patch, Post, Query, HttpCode, Inject } from "@nestjs/common";
import { SchedulesService } from "./schedules.service.js";
import type { CreateScheduleInput, ParamMap, UpdateScheduleInput } from "@bcp/shared";

/** REST endpoints for the Schedule resource. The Schedules page is the
 *  primary UI for these. */
@Controller("api/schedules")
export class SchedulesController {
  constructor(@Inject(SchedulesService) private readonly schedules: SchedulesService) {}

  @Get()
  async list(@Query("includeDeleted") includeDeleted?: string) {
    const items = await this.schedules.list({ includeDeleted: includeDeleted === "true" });
    // Hydrate each row with its next 3 fire times. The DB doesn't store
    // these (they're derived from cron+timezone+now), so we compute on
    // every list call. Cheap for the expected scale (<100 schedules).
    return Promise.all(
      items.map(async (s) => ({
        ...s,
        nextFires: await this.schedules.nextFires(s.id, 3),
      })),
    );
  }

  @Get(":id")
  async find(@Param("id") id: string) {
    const s = await this.schedules.findById(id);
    return {
      ...s,
      nextFires: await this.schedules.nextFires(id, 3),
    };
  }

  @Post()
  create(@Body() body: CreateScheduleInput) {
    return this.schedules.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateScheduleInput) {
    return this.schedules.update(id, body);
  }

  @Post(":id/toggle")
  toggle(@Param("id") id: string) {
    return this.schedules.toggle(id);
  }

  @Post(":id/run")
  runNow(@Param("id") id: string, @Body() body: { paramsOverride?: ParamMap } = {}) {
    return this.schedules.runNow(id, body.paramsOverride);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    return this.schedules.remove(id);
  }
}
