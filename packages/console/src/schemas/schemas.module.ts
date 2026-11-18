import { Module } from "@nestjs/common";
import { SchemasController } from "./schemas.controller.js";
import { SchemasService } from "./schemas.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  controllers: [SchemasController],
  providers: [SchemasService],
  exports: [SchemasService],
})
export class SchemasModule {}
