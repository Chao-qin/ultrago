import { Body, Controller, Get, Inject, Param, Post, Put, Query, UseGuards } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import { findEntry, readRegistry, type ScriptRegistry } from "./script-registry.js";
import { ScriptRunnerService } from "./script-runner.service.js";
import { EnvSettingsService } from "./env-settings.service.js";
import { LoopbackGuard } from "./loopback.guard.js";

/**
 * The 设置 page's API.
 *
 * GET endpoints are open like the rest of the console. Everything that runs a
 * script or writes `.env` sits behind LoopbackGuard — see that file for why.
 */
@Controller("api/settings")
export class SettingsController {
  constructor(
    @Inject(ScriptRunnerService) private readonly runner: ScriptRunnerService,
    @Inject(EnvSettingsService) private readonly env: EnvSettingsService,
  ) {}

  /** Every package.json script in the workspace. Re-read per request: editing
   *  a package.json is exactly when you'd come look at this page, and caching
   *  it would show you the list from whenever the console last booted. */
  @Get("scripts")
  scripts(): ScriptRegistry {
    return readRegistry();
  }

  @Get("scripts/runs")
  runs() {
    return this.runner.list();
  }

  /** Tail of the detached log. Deliberately outside the run records: the runs
   *  it belongs to are the ones that kill this process. */
  @Get("scripts/detached-log")
  detachedLog(@Query("since") since?: string) {
    return this.runner.detachedLog(Number(since) || 0);
  }

  @Get("scripts/runs/:id")
  run(@Param("id") id: string, @Query("cursor") cursor?: string) {
    return this.runner.logSince(id, Number(cursor) || 0);
  }

  /**
   * Start one script. The (dir, script) pair is looked up in the registry and
   * the registry's own argv is what gets spawned — nothing from the request
   * body reaches the command line, so this is "pick a script that exists", not
   * "run a string".
   */
  @Post("scripts/run")
  @UseGuards(LoopbackGuard)
  start(@Body() body: { dir?: string; script?: string; confirm?: boolean }) {
    if (!body?.dir || !body?.script) throw new BadRequestException("要 dir 和 script 两个字段");
    const entry = findEntry(readRegistry(), body.dir, body.script);
    if (!entry) throw new BadRequestException(`${body.dir} 里没有名为 ${body.script} 的脚本`);
    // The confirmation is enforced here, not only in the dialog: the dangerous
    // set is defined server-side, and a client that skipped the dialog would
    // otherwise skip the whole protection.
    if (entry.danger && body.confirm !== true) {
      throw new BadRequestException(`${entry.script} 需要确认后才能运行：${entry.reason}`);
    }
    if (entry.detach) {
      return { detached: true, ...this.runner.startDetached(entry) };
    }
    return { detached: false, exec: this.runner.start(entry) };
  }

  @Post("scripts/runs/:id/stop")
  @UseGuards(LoopbackGuard)
  stop(@Param("id") id: string) {
    return this.runner.stop(id);
  }

  @Get("env")
  readEnv() {
    return this.env.read();
  }

  @Get("env/reveal")
  @UseGuards(LoopbackGuard)
  reveal(@Query("key") key?: string) {
    if (!key) throw new BadRequestException("要 key");
    return this.env.reveal(key);
  }

  @Put("env")
  @UseGuards(LoopbackGuard)
  writeEnv(@Body() body: { updates?: Record<string, string> }) {
    if (!body?.updates || typeof body.updates !== "object") throw new BadRequestException("要 updates 对象");
    return this.env.write(body.updates);
  }
}
