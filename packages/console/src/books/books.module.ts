import { Module } from "@nestjs/common";
import { BooksController } from "./books.controller.js";
import { BooksService } from "./books.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { FilesyncModule } from "../filesync/filesync.module.js";

@Module({
  imports: [PrismaModule, FilesyncModule],
  controllers: [BooksController],
  providers: [BooksService],
  exports: [BooksService],
})
export class BooksModule {}
