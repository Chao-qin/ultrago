import { Controller, Get, Inject, Param, Res } from "@nestjs/common";
import type { Response } from "express";
import { PrismaService } from "../prisma/prisma.service.js";
import { RecordsService } from "./records.service.js";

/** Serves a run's stored non-JSON output (markdown / images / any file that
 * didn't fit a schema column). GET only — records are written by the backend
 * when a run lands, not uploaded by a client. That's uploads.controller.ts's
 * job; this controller is read-only on purpose. */
@Controller("api/records")
export class RecordsController {
  constructor(
    @Inject(RecordsService) private readonly records: RecordsService,
    @Inject(PrismaService) private readonly prisma: PrismaService,
  ) {}

  /**
   * The media type comes from the ROW, not from the file name.
   *
   * `res.sendFile` alone types the response off the extension, and the
   * extension is routinely wrong here: a stored record's name is whatever the
   * producing run called its output file, while `contentType` was sniffed from
   * the bytes when the record landed. `resource/records/ef5594d5df06e766-asldjas.md`
   * is 222 bytes of `{"conversationId": …}` — JSON under a `.md` name, because
   * the doubao-ask book's `outputFile` parameter named it and the payload is
   * JSON regardless. The database says `application/json`; unpatched, the
   * response said `text/markdown`. `output-landing.service.ts:132` sniffs for
   * exactly this reason and its comment names another such row
   * (`1122askdjask.md`), so the column is the considered answer and the
   * extension is the guess.
   *
   * It sticks because send@0.19.2 (what express@4.22.2 resolves to here)
   * opens `SendStream.prototype.type` with
   * `if (res.getHeader('Content-Type')) return` — index.js:827 — so a header
   * that is already present suppresses its own extension lookup. What matters
   * is that the header is set by the time send types the stream, which happens
   * asynchronously; setting it before `sendFile` is simply the form that cannot
   * get that wrong. (Measured: moving this line after the `sendFile` call also
   * still works, since both run in the same synchronous block — so the ordering
   * here is defensive, not load-bearing.)
   *
   * No row → nothing overridden, and `sendFile` guesses from the extension as
   * before. That is the honest fallback: a file with no record behind it has no
   * sniffed truth to prefer. Soft-deleted rows are NOT excluded — the question
   * asked here is "how are these bytes encoded", which a tombstone does not
   * change; whether the bytes should still be served is a separate question
   * this endpoint has never asked.
   */
  @Get(":name")
  async serve(@Param("name") name: string, @Res() res: Response): Promise<void> {
    // resolveStored first: an unknown name must 404 from the service rather
    // than reach the database or set a header on a response that will not send.
    const absolute = this.records.resolveStored(name);
    // deletedAt is deliberately absent — see the doc block above: a tombstone
    // does not change how the bytes are encoded.
    const row = await this.prisma.schemaRecord.findFirst({
      where: { fileName: name },
      select: { contentType: true },
    });
    if (row) res.setHeader("Content-Type", row.contentType);
    res.sendFile(absolute);
  }
}
