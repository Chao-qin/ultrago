import { Controller, Get, Inject } from "@nestjs/common";
import { PrismaService } from "./prisma/prisma.service.js";
import { BackendClient } from "./backend-client/backend-client.service.js";

/** Liveness + readiness for the console itself. Combines DB ping with
 *  backend health so a single GET /api/health tells the UI whether to render
 *  the "backend is down, please start it" banner. */
@Controller("api/health")
export class HealthController {
  constructor(
    @Inject(PrismaService) private readonly prisma: PrismaService,
    @Inject(BackendClient) private readonly backend: BackendClient,
  ) {}

  @Get()
  async get(): Promise<{
    ok: boolean;
    db: boolean;
    backend: { ok: boolean; plans?: number; error?: string };
  }> {
    let db = false;
    try {
      await this.prisma.$queryRawUnsafe("SELECT 1");
      db = true;
    } catch (e) {
      // best-effort; surfaced as false
    }
    const backend = await this.backend.health();
    return {
      ok: db && backend.ok,
      db,
      backend,
    };
  }
}
