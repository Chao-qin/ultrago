import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RecordsController } from "./records.controller.js";
import { RecordsService } from "./records.service.js";

@Module({
  // PrismaModule is for the CONTROLLER, not the service: RecordsService stays a
  // pure filesystem service (four test files construct it as
  // `new RecordsService()`), and only the HTTP layer needs a record's stored
  // `contentType` to set the response header.
  imports: [PrismaModule],
  controllers: [RecordsController],
  providers: [RecordsService],
  exports: [RecordsService],
})
export class RecordsModule {}
