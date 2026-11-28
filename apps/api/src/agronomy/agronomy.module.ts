import { Module } from "@nestjs/common";

import { AgronomyController } from "./agronomy.controller.js";
import { AgronomyService } from "./agronomy.service.js";

@Module({
  controllers: [AgronomyController],
  providers: [AgronomyService],
  exports: [AgronomyService],
})
export class AgronomyModule {}
