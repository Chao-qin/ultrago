import { Module } from "@nestjs/common";
import { BackendClientModule } from "../backend-client/backend-client.module.js";
import { BrowserController } from "./browser.controller.js";

@Module({
  imports: [BackendClientModule],
  controllers: [BrowserController],
})
export class BrowserModule {}
