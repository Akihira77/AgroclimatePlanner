import type { OnModuleDestroy } from "@nestjs/common";
import { Global, Inject, Injectable, Module } from "@nestjs/common";
import type { DynamicModule } from "@nestjs/common";
import type { PrismaClient } from "@agroclimate/database";

import { DATABASE_CLIENT } from "../tokens.js";
import type { RuntimeConfig } from "../config/runtime-config.js";

/**
 * The one place a runtime database client is created. The factory is a parameter
 * rather than an inline call so a test can substitute a double without a live
 * PostgreSQL, and so the production path stays exactly one line.
 */
export type DatabaseClientFactory = (connectionString: string) => PrismaClient;

/**
 * Owns the client's lifetime. `$disconnect()` with a driver adapter ends the
 * underlying `pg` pool, so this is what actually releases connections on
 * SIGTERM — Nest only calls it when shutdown hooks are enabled, which
 * `createApplication` does.
 *
 * Injection is by token, so the API never reaches into `src/generated/prisma`.
 */
@Injectable()
export class DatabaseLifecycle implements OnModuleDestroy {
  private closed = false;

  constructor(@Inject(DATABASE_CLIENT) private readonly client: PrismaClient) {}

  async onModuleDestroy(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.$disconnect();
  }
}

@Global()
@Module({})
export class DatabaseModule {
  static register(config: RuntimeConfig, createClient: DatabaseClientFactory): DynamicModule {
    return {
      module: DatabaseModule,
      providers: [
        {
          // Singleton scope: the factory runs once per process, so an injected
          // client is always the same pool rather than a new one per consumer.
          provide: DATABASE_CLIENT,
          useFactory: () => createClient(config.databaseUrl),
        },
        DatabaseLifecycle,
      ],
      exports: [DATABASE_CLIENT, DatabaseLifecycle],
    };
  }
}
