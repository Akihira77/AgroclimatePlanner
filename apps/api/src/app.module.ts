import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import type { GridRegistry } from "@agroclimate/contracts";
import { syntheticGridRegistry } from "@agroclimate/weather-core";

import type { RuntimeConfig } from "./config/runtime-config.js";
import { ConfigModule } from "./config/config.module.js";
import type { DatabaseClientFactory } from "./database/database.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { ActivityModule } from "./activity/activity.module.js";
import { AgronomyModule } from "./agronomy/agronomy.module.js";
import { ClimateModule } from "./climate/climate.module.js";
import { CropModule } from "./crop/crop.module.js";
import { FarmModule } from "./farm/farm.module.js";
import { FieldModule } from "./field/field.module.js";
import { HealthModule } from "./health/health.module.js";

export interface AppDependencies {
  readonly config: RuntimeConfig;
  /** Overridable so a test can supply a double without a live PostgreSQL. */
  readonly createDatabaseClient: DatabaseClientFactory;
  /**
   * Overridable so a resolution test can use a registry of its own. Production
   * gets `syntheticGridRegistry` — one `synthetic` entry, no provider grid — and
   * there is no second instance to drift from it.
   */
  readonly gridRegistry?: GridRegistry;
}

/**
 * Dynamic rather than plain: the client factory has to be injectable, and a
 * static module would force the test to reach for `@nestjs/testing` just to
 * replace one provider.
 */
@Module({})
export class AppModule {
  static register(deps: AppDependencies): DynamicModule {
    // One value, bound twice: the resolution route and the climate read route must
    // resolve the same coordinates to the same cell, and two constructions would be
    // two registries that could drift apart.
    const gridRegistry = deps.gridRegistry ?? syntheticGridRegistry;

    return {
      module: AppModule,
      imports: [
        ConfigModule.forConfig(deps.config),
        DatabaseModule.register(deps.config, deps.createDatabaseClient),
        AuthModule.register(deps.config, deps.createDatabaseClient),
        FarmModule,
        FieldModule.register(gridRegistry),
        ClimateModule.register(gridRegistry),
        CropModule,
        ActivityModule,
        AgronomyModule,
        HealthModule,
      ],
    };
  }
}
