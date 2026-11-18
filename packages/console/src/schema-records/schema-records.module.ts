import { Module } from "@nestjs/common";
import { SchemaRecordsController } from "./schema-records.controller.js";
import { SchemaRecordsService } from "./schema-records.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";

@Module({
  imports: [PrismaModule],
  controllers: [SchemaRecordsController],
  providers: [SchemaRecordsService],
  exports: [SchemaRecordsService],
})
export class SchemaRecordsModule {}
