import { Module } from "@nestjs/common";
import { ScriptsService } from "./scripts.service.js";
import { ScriptsController } from "./scripts.controller.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { SchemasModule } from '../schemas/schemas.module.js';

@Module({
  imports: [PrismaModule, SchemasModule],
  controllers: [ScriptsController],
  providers: [ScriptsService],
  exports: [ScriptsService],
})
export class ScriptsModule {}
