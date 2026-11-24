import type { GridRegistry } from "@agroclimate/contracts";
import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { GRID_REGISTRY } from "../tokens.js";
import { ClimateController } from "./climate.controller.js";
import { ClimateService } from "./climate.service.js";

/**
 * The climate read feature module. No `imports`: the tenant client comes from the
 * global `DatabaseModule` and `AuthGuard` from the global `AuthModule`, the same
 * wiring as `FarmModule` and `FieldModule`.
 *
 * `register` exists for the grid registry, for the same reason it does in
 * `FieldModule`: the resolver is the only field → cell mapping this build has, and
 * production binds one instance (`syntheticGridRegistry` — one `synthetic` entry
 * and no provider grid). A test binds its own isolated registry so a happy path can
 * run without pretending a provider grid has been validated.
 */
@Module({})
export class ClimateModule {
  static register(gridRegistry: GridRegistry): DynamicModule {
    return {
      module: ClimateModule,
      controllers: [ClimateController],
      providers: [ClimateService, { provide: GRID_REGISTRY, useValue: gridRegistry }],
    };
  }
}
