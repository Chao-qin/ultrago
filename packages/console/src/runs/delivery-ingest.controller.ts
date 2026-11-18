import { Body, Controller, HttpCode, Post, Inject } from "@nestjs/common";
import { DeliveryIngestService, type DeliveryIngestInput } from "./delivery-ingest.service.js";

/** Loopback-only durable boundary for backend/MCP terminal snapshots. */
@Controller("internal/deliveries")
export class DeliveryIngestController {
  constructor(@Inject(DeliveryIngestService) private readonly ingestService: DeliveryIngestService) {}

  @Post("ingest")
  @HttpCode(200)
  ingest(@Body() body: DeliveryIngestInput) {
    return this.ingestService.ingest(body);
  }
}
