import { Module } from "@nestjs/common";

import { FarmController } from "./farm.controller.js";
import { FarmService } from "./farm.service.js";

/**
 * The Farm feature module. No `imports`: the tenant database client is provided by
 * the global `DatabaseModule`, and `AuthGuard` by the global `AuthModule` — the
 * latter deliberately, so a feature module cannot create a second auth pool or a
 * second rate limiter by re-importing it.
 */
@Module({
  controllers: [FarmController],
  providers: [FarmService],
})
export class FarmModule {}
