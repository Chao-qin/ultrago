import { Module } from "@nestjs/common";
import { ImageBedController } from "./image-bed.controller.js";
import { ImageBedService } from "./image-bed.service.js";
import { ImageBedConfigService } from "./image-bed.config.js";
import { GitHubImageBedService } from "./github-image-bed.service.js";

@Module({
  controllers: [ImageBedController],
  providers: [ImageBedConfigService, GitHubImageBedService, ImageBedService],
  exports: [ImageBedService],
})
export class ImageBedModule {}
