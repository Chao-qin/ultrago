import { Module } from "@nestjs/common";
import { RunsController } from "./runs.controller.js";
import { RunsService } from "./runs.service.js";
import { RunHistoryService } from './run-history.service.js';
import { EnqueueService } from "./enqueue.service.js";
import { DispatcherService } from "./dispatcher.service.js";
import { PrismaModule } from "../prisma/prisma.module.js";
import { BackendClientModule } from "../backend-client/backend-client.module.js";
import { RecordsModule } from "../records/records.module.js";
import { DeliveryIngestController } from "./delivery-ingest.controller.js";
import { DeliveryIngestService } from "./delivery-ingest.service.js";
import { OutputLandingService } from "./output-landing.service.js";
import { StepResultsService } from './step-results.service.js';

@Module({
  // RecordsModule because a run whose product has no resolvable schema lands
  // its bytes in resource/records/, and so does every file it wrote — see
  // OutputLandingService. That service is exported because the flow runner
  // lands its own product through the same door rather than a second one.
  imports: [PrismaModule, BackendClientModule, RecordsModule],
  controllers: [RunsController, DeliveryIngestController],
  providers: [RunsService, RunHistoryService, EnqueueService, DispatcherService, DeliveryIngestService, OutputLandingService, StepResultsService],
  exports: [RunsService, EnqueueService, DispatcherService, DeliveryIngestService, OutputLandingService],
})
export class RunsModule {}
