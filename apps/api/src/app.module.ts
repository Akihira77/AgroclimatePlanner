import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import type { RuntimeConfig } from "./config/runtime-config.js";
import { ConfigModule } from "./config/config.module.js";
import type { DatabaseClientFactory } from "./database/database.module.js";
import { DatabaseModule } from "./database/database.module.js";
import { AuthModule } from "./auth/auth.module.js";
import { HealthModule } from "./health/health.module.js";

export interface AppDependencies {
  readonly config: RuntimeConfig;
  /** Overridable so a test can supply a double without a live PostgreSQL. */
  readonly createDatabaseClient: DatabaseClientFactory;
}

/**
 * Dynamic rather than plain: the client factory has to be injectable, and a
 * static module would force the test to reach for `@nestjs/testing` just to
 * replace one provider.
 */
@Module({})
export class AppModule {
  static register(deps: AppDependencies): DynamicModule {
    return {
      module: AppModule,
      imports: [
        ConfigModule.forConfig(deps.config),
        DatabaseModule.register(deps.config, deps.createDatabaseClient),
        AuthModule.register(deps.config, deps.createDatabaseClient),
        HealthModule,
      ],
    };
  }
}
