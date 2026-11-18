import { BadRequestException, Body, Controller, Inject, Post } from "@nestjs/common";
import { StudioService } from "./studio.service.js";
import { isStudioRequest } from "./studio.protocol.js";
import type { StudioResponse } from "./studio.protocol.js";

/** Single endpoint the embedded Prisma Studio talks to. Studio multiplexes
 *  everything (introspection, paging, filters, edits, the SQL editor) over
 *  this one POST, discriminated by `body.procedure`.
 *
 *  ⚠ This route executes SQL the browser composed, including writes — that IS
 *  Studio's edit feature, not an oversight. The console binds to 127.0.0.1
 *  only (see main.ts), so the blast radius is the local machine; exposing the
 *  console on a public interface would turn this into a remote DB shell.
 */
@Controller("api/studio")
export class StudioController {
  constructor(@Inject(StudioService) private readonly studio: StudioService) {}

  @Post()
  handle(@Body() body: unknown): Promise<StudioResponse> {
    if (!isStudioRequest(body)) {
      throw new BadRequestException(`unknown studio procedure: ${JSON.stringify((body as { procedure?: unknown })?.procedure)}`);
    }
    return this.studio.handle(body);
  }
}
