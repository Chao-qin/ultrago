import { Module } from "@nestjs/common";
import { SettingsController } from "./settings.controller.js";
import { ScriptRunnerService } from "./script-runner.service.js";
import { EnvSettingsService } from "./env-settings.service.js";

/** 设置面板：workspace 的 pnpm 脚本 + 仓库根 `.env`。不依赖 Prisma —— 这里的
 *  真相源是磁盘上的 package.json 与 .env，不是数据库。 */
@Module({
  controllers: [SettingsController],
  providers: [ScriptRunnerService, EnvSettingsService],
})
export class SettingsModule {}
