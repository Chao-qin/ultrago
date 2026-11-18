import { Controller, Get, Post, Body, Query, Inject, HttpCode, BadRequestException } from "@nestjs/common";
import { BackendClient } from "../backend-client/backend-client.service.js";

/**
 * Console's own /api/browser/* surface (spec §11.3) — a thin proxy onto the
 * backend's loopback internal HTTP. The console NEVER touches child processes
 * or the process supervisor directly.
 */
@Controller("api/browser")
export class BrowserController {
  constructor(@Inject(BackendClient) private readonly backend: BackendClient) {}

  @Get("status")
  status(@Query() q: { kind?: string; instanceId?: string }) {
    const selector: { kind?: "chrome" | "firefox"; instanceId?: string } = {};
    if (q.kind === "chrome" || q.kind === "firefox") selector.kind = q.kind;
    if (q.instanceId) selector.instanceId = q.instanceId;
    return this.backend.browserStatus(selector);
  }

  @Post("setup")
  @HttpCode(200)
  setup(@Body() body: { kind?: string; mode?: string; instanceId?: string; waitMs?: number }) {
    if (body.kind !== "chrome" && body.kind !== "firefox") {
      throw new BadRequestException(`kind must be "chrome" or "firefox"`);
    }
    if (body.mode !== undefined && body.mode !== "user" && body.mode !== "managed") {
      throw new BadRequestException(`mode must be "user" or "managed"`);
    }
    // mode 缺省 "user"（安全默认：user 实例永不归后端所有）。
    return this.backend.browserSetup({ kind: body.kind, mode: body.mode ?? "user", instanceId: body.instanceId, waitMs: body.waitMs });
  }

  @Post("stop")
  @HttpCode(200)
  stop(@Body() body: { kind?: string; instanceId?: string }) {
    if (body.kind !== "chrome" && body.kind !== "firefox" || !body.instanceId) {
      throw new BadRequestException("kind (chrome|firefox) and instanceId are required");
    }
    return this.backend.browserStop({ kind: body.kind, instanceId: body.instanceId });
  }
}
