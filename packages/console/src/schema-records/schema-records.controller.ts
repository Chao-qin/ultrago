import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Inject } from "@nestjs/common";
import { SchemaRecordsService } from "./schema-records.service.js";
import type { CreateSchemaRecordInput, UpdateSchemaRecordInput } from "@bcp/shared";

@Controller("api/schema-records")
export class SchemaRecordsController {
  constructor(@Inject(SchemaRecordsService) private readonly svc: SchemaRecordsService) {}

  @Get()
  list(
    @Query("schemaName") schemaName?: string,
    @Query("sourcePrefix") sourcePrefix?: string,
    @Query("includeDeleted") includeDeleted?: string,
    @Query("preview") preview?: string,
  ) {
    return this.svc.list({
      schemaName,
      sourcePrefix,
      includeDeleted: includeDeleted === "true",
      preview: preview === "true",
    });
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.svc.findById(id);
  }

  @Post()
  create(@Body() body: CreateSchemaRecordInput) {
    return this.svc.create(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateSchemaRecordInput) {
    return this.svc.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.svc.remove(id);
  }

  @Post(":id/restore")
  restore(@Param("id") id: string) {
    return this.svc.restore(id);
  }
}
