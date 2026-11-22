import type { GridRegistry } from "@agroclimate/contracts";
import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { GRID_REGISTRY } from "../tokens.js";
import { FieldController } from "./field.controller.js";
import { FieldService } from "./field.service.js";

/**
 * The Field feature module. No `imports`: the tenant client comes from the global
 * `DatabaseModule`, and `AuthGuard` from the global `AuthModule` — the same wiring
 * as `FarmModule`, so neither can create a second auth pool.
 *
 * `register` exists for one provider: the grid registry. Production passes
 * `syntheticGridRegistry`, which holds one `synthetic` entry and no provider grid;
 * a test passes its own isolated registry so a happy path can run without
 * pretending a real provider grid has been validated. Nothing is mutable — the
 * registry is a value bound at module construction, not a global a handler could
 * swap at runtime.
 */
@Module({})
export class FieldModule {
  static register(gridRegistry: GridRegistry): DynamicModule {
    return {
      module: FieldModule,
      controllers: [FieldController],
      providers: [FieldService, { provide: GRID_REGISTRY, useValue: gridRegistry }],
    };
  }
}
