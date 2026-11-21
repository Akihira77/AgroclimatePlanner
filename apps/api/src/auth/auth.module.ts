import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import type { RuntimeConfig } from "../config/runtime-config.js";
import { AuthDatabaseModule } from "../database/auth-database.module.js";
import type { DatabaseClientFactory } from "../database/database.module.js";
import { AUTH_RATE_LIMITER, PASSWORD_HASHER } from "../tokens.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { createPasswordHasher } from "./password-hasher.js";
import {
  AUTH_RATE_LIMIT,
  AUTH_RATE_WINDOW_MS,
  AuthRateLimitGuard,
  FixedWindowRateLimiter,
  MAX_TRACKED_CLIENTS,
} from "./rate-limit.guard.js";

/**
 * The authentication surface (`S7` registration, `S8` login and sessions). Scoped,
 * not global: the auth database pool must not be reachable from modules that serve
 * tenant data, and vice versa.
 *
 * The limiter is one instance per process and one instance per module — a
 * per-route instance would multiply the effective quota, which is why registration
 * and login share this provider instead of each constructing their own.
 */
@Module({})
export class AuthModule {
  static register(config: RuntimeConfig, createClient: DatabaseClientFactory): DynamicModule {
    return {
      module: AuthModule,
      imports: [AuthDatabaseModule.register(config, createClient)],
      controllers: [AuthController],
      providers: [
        {
          provide: PASSWORD_HASHER,
          useFactory: () => createPasswordHasher(config.passwordHashing),
        },
        {
          provide: AUTH_RATE_LIMITER,
          useFactory: () =>
            new FixedWindowRateLimiter({
              limit: AUTH_RATE_LIMIT,
              windowMs: AUTH_RATE_WINDOW_MS,
              maxKeys: MAX_TRACKED_CLIENTS,
            }),
        },
        AuthRateLimitGuard,
        AuthService,
        AuthGuard,
      ],
    };
  }
}
