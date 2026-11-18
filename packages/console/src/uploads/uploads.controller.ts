import { Body, Controller, Get, Inject, Param, Post, Query, Res } from "@nestjs/common";
import type { Response } from "express";
import { UploadsService } from "./uploads.service.js";

/** Staging area for files picked in the console's attachment field.
 *
 * The body is the raw file — `main.ts` mounts express.raw() on this path ahead
 * of the JSON parser, so bytes never hit the 1mb JSON limit and no multipart
 * dependency is needed. The name/type the browser knows ride along as query
 * params because the body is bytes only. */
@Controller("api/uploads")
export class UploadsController {
  constructor(@Inject(UploadsService) private readonly uploads: UploadsService) {}

  @Post()
  create(@Body() body: Buffer, @Query("filename") filename?: string, @Query("mime") mime?: string) {
    return this.uploads.save(body, filename ?? "", mime ?? "");
  }

  /** Serve a staged file back so the picker can show a thumbnail for params
   * that were saved earlier (a schedule reopened days later). */
  @Get(":name")
  serve(@Param("name") name: string, @Res() res: Response): void {
    res.sendFile(this.uploads.resolveStored(name));
  }
}
