import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Patch, Post, Query } from "@nestjs/common";
import { ScriptsService } from "./scripts.service.js";
import type { ParamMap } from "@bcp/shared";

@Controller("api/scripts")
export class ScriptsController {
  constructor(@Inject(ScriptsService) private readonly scripts: ScriptsService) {}

  @Get()
  list(@Query("includeDeleted") includeDeleted?: string) {
    return this.scripts.list({ includeDeleted: includeDeleted === "true" });
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.scripts.findById(id);
  }

  @Post()
  create(@Body() body: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) {
    return this.scripts.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: { name?: string; description?: string; language?: string; source?: string; inputSchema?: string; outputSchema?: string }) {
    return this.scripts.update(id, body);
  }

  @Post(":id/test")
  @HttpCode(200)
  test(@Param("id") id: string, @Body() body: { params?: ParamMap; timeoutMs?: number } = {}) {
    return this.scripts.test(id, body?.params, body?.timeoutMs);
  }

  @Post(':id/run')
  @HttpCode(200)
  run(@Param('id') id: string, @Body() body: { params?: ParamMap; timeoutMs?: number } = {}) {
    return this.scripts.runManual(id, body?.params, body?.timeoutMs);
  }

  @Delete(":id")
  @HttpCode(204)
  remove(@Param("id") id: string) {
    return this.scripts.remove(id);
  }
}
