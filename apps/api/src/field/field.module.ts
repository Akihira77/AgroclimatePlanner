import { Module } from "@nestjs/common";

import { FieldController } from "./field.controller.js";
import { FieldService } from "./field.service.js";

/**
 * The Field feature module. No `imports`: the tenant client comes from the global
 * `DatabaseModule`, and `AuthGuard` from the global `AuthModule` — the same wiring
 * as `FarmModule`, so neither can create a second auth pool.
 */
@Module({
  controllers: [FieldController],
  providers: [FieldService],
})
export class FieldModule {}
