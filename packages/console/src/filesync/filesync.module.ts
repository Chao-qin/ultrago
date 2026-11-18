import { Module } from "@nestjs/common";
import { FilesyncService } from "./filesync.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SchemasModule } from "../schemas/schemas.module.js";

@Module({
  imports: [PrismaModule, SchemasModule],
  providers: [FilesyncService],
  exports: [FilesyncService],
})
export class FilesyncModule {}
