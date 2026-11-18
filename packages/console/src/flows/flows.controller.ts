import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query, Req, Res } from "@nestjs/common";
import type { Request, Response } from 'express';
import type { ParamMap } from "@bcp/shared";
import { redactDiagnostic } from '@bcp/shared';
import { FlowsService, type UpsertFlowInput } from "./flows.service.js";
import { FlowRunnerService } from "./flow-runner.service.js";

@Controller("api/flows")
export class FlowsController {
  constructor(
    @Inject(FlowsService) private readonly flows: FlowsService,
    // The dry-run below spawns a script, and the runner is where scripts are
    // spawned. Routing it through FlowsService would put a cycle between the
    // two modules — flow-runner already imports the schema resolver from it.
    @Inject(FlowRunnerService) private readonly runner: FlowRunnerService,
  ) {}

  @Get()
  list(@Query("includeDeleted") includeDeleted?: string) {
    return this.flows.list({ includeDeleted: includeDeleted === "true" });
  }

  @Post()
  create(@Body() body: UpsertFlowInput) {
    return this.flows.create(body);
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.flows.findById(id);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpsertFlowInput) {
    return this.flows.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.flows.remove(id);
  }

  /** Everything wrong with the graph. Called on save and on demand, so the
   *  canvas can show problems without having to re-derive them itself. */
  @Post(":id/validate")
  @HttpCode(200)
  validate(@Param("id") id: string) {
    return this.flows.validate(id);
  }

  @Post(":id/trigger")
  @HttpCode(202)
  trigger(@Param("id") id: string, @Body() body: { params?: ParamMap; mode?: string }) {
    return this.flows.trigger(id, body?.params ?? {}, "manual", body?.mode);
  }

  /**
   * Run ONE script node's code against sample inputs, without a flow run.
   *
   * Deliberately not under `:id` — a node being tried out may not be saved yet,
   * and making the author save a half-written script to see what it does is how
   * a "try it" button stops being used. The body carries the node config
   * itself, so what runs is what is on screen.
   *
   * `@HttpCode(200)`: this settles synchronously and returns the outcome,
   * unlike `trigger` which hands back a queued run.
   */
  @Post("script/dry-run")
  @HttpCode(200)
  async dryRunScript(
    @Body() body: { config?: unknown; params?: Record<string, unknown> },
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    const controller = new AbortController();
    const stop = (): void => controller.abort();
    request.once('aborted', stop);
    response.once('close', stop);
    try {
      return await this.runner.dryRunScript(body?.config, body?.params ?? {}, controller.signal);
    } finally {
      request.off('aborted', stop);
      response.off('close', stop);
    }
  }
}

@Controller("api/flow-runs")
export class FlowRunsController {
  constructor(@Inject(FlowsService) private readonly flows: FlowsService) {}

  @Get()
  list(
    @Query("flowId") flowId?: string,
    @Query("limit") limit?: string,
    @Query("includeDeleted") includeDeleted?: string,
  ) {
    return this.flows.listRuns(flowId, limit ? Number(limit) : undefined, {
      includeDeleted: includeDeleted === "true",
    });
  }

  @Get(":id")
  async find(@Param("id") id: string) {
    return redactDiagnostic(await this.flows.getRun(id));
  }

  @Post(":id/cancel")
  @HttpCode(200)
  cancel(@Param("id") id: string) {
    return this.flows.cancelRun(id);
  }

  /** Re-run a failed run from where it stopped, inheriting what already
   *  succeeded. 202 rather than 200: this queues work, it does not do it. */
  @Post(":id/resume")
  @HttpCode(202)
  resume(@Param("id") id: string) {
    return this.flows.resumeRun(id);
  }
}
