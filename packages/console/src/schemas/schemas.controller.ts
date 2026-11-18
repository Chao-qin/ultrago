import { Body, Controller, Delete, Get, Param, Patch, Post, Query, Inject } from "@nestjs/common";
import { SchemasService } from "./schemas.service.js";
import type { RegisterSchemaInput, UpdateSchemaInput } from "@bcp/shared";

@Controller("api/schemas")
export class SchemasController {
  constructor(@Inject(SchemasService) private readonly schemas: SchemasService) {}

  @Get()
  list(
    @Query("kind") kind?: string,
    @Query("entity") entity?: string,
    @Query("includeInactive") includeInactive?: string,
    @Query("includeDeleted") includeDeleted?: string,
    @Query("q") q?: string,
  ) {
    return this.schemas.list({
      kind,
      entity,
      includeInactive: includeInactive === "true",
      includeDeleted: includeDeleted === "true",
      q,
    });
  }

  /** Resolve by citation. Placed before `:id` so the literal segment wins the
   *  route match. Omitting `version` yields the current active one. */
  @Get("by-name/:name")
  resolve(@Param("name") name: string, @Query("version") version?: string) {
    return this.schemas.resolve(name, version === undefined ? undefined : Number(version));
  }

  @Get(":id")
  find(@Param("id") id: string) {
    return this.schemas.findById(id);
  }

  @Post()
  register(@Body() body: RegisterSchemaInput) {
    return this.schemas.register(body);
  }

  @Patch(":id")
  update(@Param("id") id: string, @Body() body: UpdateSchemaInput) {
    return this.schemas.update(id, body);
  }

  @Delete(":id")
  remove(@Param("id") id: string) {
    return this.schemas.remove(id);
  }
}
