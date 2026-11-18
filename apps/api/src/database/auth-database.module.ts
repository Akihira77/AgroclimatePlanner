import type { OnModuleDestroy } from "@nestjs/common";
import { Inject, Injectable, Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { PrismaClient } from "@agroclimate/database";

import { AUTH_DATABASE_CLIENT } from "../tokens.js";
import type { RuntimeConfig } from "../config/runtime-config.js";
import type { DatabaseClientFactory } from "./database.module.js";

/**
 * Owns the authentication client's lifetime, exactly as `DatabaseLifecycle` owns
 * the tenant one — a driver adapter's `$disconnect()` ends that pool, and each
 * pool is closed by the module that created it.
 *
 * A separate class rather than a second instance of `DatabaseLifecycle`, because
 * that class injects `DATABASE_CLIENT` by token: reusing it would close the
 * tenant pool from the auth module.
 */
@Injectable()
export class AuthDatabaseLifecycle implements OnModuleDestroy {
  private closed = false;

  constructor(@Inject(AUTH_DATABASE_CLIENT) private readonly client: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.$disconnect();
  }
}

/**
 * The authentication database boundary (ADR-004).
 *
 * Not `@Global`, and not imported by `DatabaseModule`. The tenant client and the
 * auth client answer to different roles with different privileges, so making the
 * auth client reachable everywhere would invite a query to be written against
 * whichever client was closer to hand.
 *
 * Registration is intentionally left to the stage that needs it; assembling this
 * module in S3 would mount a pool nothing uses yet.
 */
@Module({})
export class AuthDatabaseModule {
  static register(config: RuntimeConfig, createClient: DatabaseClientFactory): DynamicModule {
    return {
      module: AuthDatabaseModule,
      providers: [
        {
          // Singleton scope: one pool per process, the same rule as the tenant
          // client. Two providers would mean two pools and two credential sets.
          provide: AUTH_DATABASE_CLIENT,
          useFactory: () => createClient(config.authDatabaseUrl),
        },
        AuthDatabaseLifecycle,
      ],
      exports: [AUTH_DATABASE_CLIENT, AuthDatabaseLifecycle],
    };
  }
}
