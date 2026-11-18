import { Body, Controller, Get, HttpCode, Param, Post, Query, Inject } from "@nestjs/common";
import { RunsService } from "./runs.service.js";
import type { RunListQuery, TriggerRunInput } from "@bcp/shared";
import { RunHistoryService } from './run-history.service.js';
import type { HistoryQuery } from './run-history.js';
import { StepResultsService } from './step-results.service.js';

@Controller("api/runs")
export class RunsController {
  constructor(
    @Inject(RunsService) private readonly runs: RunsService,
    @Inject(RunHistoryService) private readonly history: RunHistoryService,
    @Inject(StepResultsService) private readonly stepResults: StepResultsService,
  ) {}

  @Get('history')
  listHistory(@Query() query: HistoryQuery) {
    return this.history.list(query);
  }

  @Get()
  list(
    @Query() query: RunListQuery & { limit?: string; status?: string | string[] },
    @Query("includeDeleted") includeDeleted?: string,
  ) {
    // Read out of the bag explicitly rather than forwarding it inside `query`:
    // every value in there is a string, and a bare `?includeDeleted=false`
    // would be truthy — which is exactly the wrong way for this flag to fail.
    return this.runs.list({ ...query, includeDeleted: includeDeleted === "true" });
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.runs.findById(id);
  }

  @Post()
  @HttpCode(202)
  trigger(@Body() body: TriggerRunInput) {
    return this.runs.trigger(body);
  }

  @Get(':id/steps/:stepId/result')
  stepResult(@Param('id') id: string, @Param('stepId') stepId: string) {
    return this.stepResults.read(id, stepId);
  }

  @Post(":id/cancel")
  cancel(@Param("id") id: string) {
    return this.runs.cancel(id);
  }

  @Post(":id/retry")
  retry(@Param("id") id: string) {
    return this.runs.retry(id);
  }
}
