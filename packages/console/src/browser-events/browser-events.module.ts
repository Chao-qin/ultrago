import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import { RecordsModule } from "../records/records.module.js";
import { BrowserEventIngestController, BrowserEventsController } from "./browser-events.controller.js";
import { BrowserEventsService } from "./browser-events.service.js";

/** RecordsModule 是为了截图落盘：`RecordsService.save()` 已经做了内容哈希命名
 *  （同一张图重复推送不会占两份）、名字消毒和 `/api/records/<name>` 的回读路由。
 *  再写一份写文件逻辑等于给同一个目录开两个写入口。 */
@Module({
  imports: [PrismaModule, RecordsModule],
  controllers: [BrowserEventIngestController, BrowserEventsController],
  providers: [BrowserEventsService],
  exports: [BrowserEventsService],
})
export class BrowserEventsModule {}
