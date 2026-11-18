import { Module } from "@nestjs/common";
import { PrismaModule } from "../prisma/prisma.module.js";
import {
  LlmCallIngestController,
  LlmCallsController,
  LlmChannelsController,
} from "./llm-calls.controller.js";
import { LlmCallsService } from "./llm-calls.service.js";
import { LlmGatewayClient } from "./llm-gateway.client.js";

@Module({
  imports: [PrismaModule],
  controllers: [LlmCallIngestController, LlmCallsController, LlmChannelsController],
  providers: [LlmCallsService, LlmGatewayClient],
  exports: [LlmCallsService],
})
export class LlmCallsModule {}
