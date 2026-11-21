import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import type { RuntimeConfig } from "../config/runtime-config.js";
import { AuthDatabaseModule } from "../database/auth-database.module.js";
import type { DatabaseClientFactory } from "../database/database.module.js";
import { AUTH_RATE_LIMITER, PASSWORD_HASHER } from "../tokens.js";
import { AuthController } from "./auth.controller.js";
import { AuthGuard } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import { CsrfValidator } from "./csrf-validator.js";
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
      // `AuthGuard` is the authentication boundary of every authenticated feature
      // module, and it is applied with `@UseGuards(AuthGuard)`. Nest resolves a
      // class-reference enhancer in the *consuming* module's injector, so the module
      // that applies it must also be able to see the guard's dependencies. Exporting
      // the three providers globally is what lets `FarmModule` do that without
      // importing `AuthModule.register(...)` again — a second registration would
      // create a second `app_auth` pool and a second rate limiter, which the
      // one-limiter-per-process comment above exists to prevent.
      //
      // The exported instances are the ones this module already created; the auth
      // database client and the password hasher stay unexported, so no other module
      // can reach them.
      global: true,
      exports: [AuthGuard, AuthService, CsrfValidator],
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
        CsrfValidator,
      ],
    };
  }
}
