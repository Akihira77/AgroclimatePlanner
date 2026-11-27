import { Module } from "@nestjs/common";

import { CropController } from "./crop.controller.js";
import { CropService } from "./crop.service.js";

/**
 * The crop catalog feature module. No `imports`: the tenant client comes from the
 * global `DatabaseModule` and `AuthGuard` from the global `AuthModule`.
 *
 * No `register`: the catalog needs no grid registry and no config beyond the
 * database, so a factory would only add a second way to construct the same module.
 */
@Module({
  controllers: [CropController],
  providers: [CropService],
})
export class CropModule {}
