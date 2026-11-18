import type { DynamicModule } from "@nestjs/common";
import { Global, Module } from "@nestjs/common";

import { APP_CONFIG } from "../tokens.js";
import type { RuntimeConfig } from "./runtime-config.js";

/**
 * Holds the parsed configuration for the lifetime of the process, so no provider
 * re-reads `process.env` and two components cannot disagree about the same
 * variable. Global because every module that needs configuration would otherwise
 * have to re-import this one explicitly.
 */
@Global()
@Module({})
export class ConfigModule {
  static forConfig(config: RuntimeConfig): DynamicModule {
    return {
      module: ConfigModule,
      providers: [{ provide: APP_CONFIG, useValue: config }],
      exports: [APP_CONFIG],
    };
  }
}
