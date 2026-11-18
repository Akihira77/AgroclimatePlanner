import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import { createPrismaClient } from "@agroclimate/database";
import type { DatabaseClientFactory } from "./database/database.module.js";
import cookieParser from "cookie-parser";
import type { Express } from "express";
import helmet from "helmet";

import { AppModule } from "./app.module.js";
import type { RuntimeConfig } from "./config/runtime-config.js";
import { ApiExceptionFilter } from "./http/api-exception.filter.js";
import { requestIdMiddleware } from "./http/request-id.middleware.js";

export interface CreateApplicationOptions {
  readonly config: RuntimeConfig;
  readonly createDatabaseClient?: DatabaseClientFactory;
}

/**
 * Builds the application without listening, so tests can drive it through the
 * same wiring production uses instead of a hand-assembled mock.
 *
 * Order matters: middleware registered here is in place before Nest mounts the
 * routers in `init()`, which is why the request id exists by the time any
 * handler — or the exception filter — runs.
 */
export async function createApplication(
  options: CreateApplicationOptions,
): Promise<INestApplication> {
  const { config } = options;
  const app = await NestFactory.create(
    AppModule.register({
      config,
      // `createPrismaClient` takes the options object; the factory the module
      // wants takes the url. Adapting here keeps one Prisma entry point.
      createDatabaseClient:
        options.createDatabaseClient ??
        ((connectionString) => createPrismaClient({ connectionString })),
    }),
    // Errors are logged by the exception filter, which knows the request id.
    { logger: config.nodeEnv === "production" ? ["error", "warn"] : ["error", "warn", "log"] },
  );

  const express: Express = app.getHttpAdapter().getInstance();

  // `true` is rejected by configuration parsing: with it, any caller sets
  // `X-Forwarded-For` and picks their own client IP.
  express.set("trust proxy", config.trustProxy === false ? false : [...config.trustProxy]);
  express.disable("x-powered-by");

  app.use(helmet());
  // No secret: signed cookies are not part of this phase, and a secret here
  // would imply a trust decision nobody has made.
  app.use(cookieParser());
  app.use(requestIdMiddleware({ trustIncoming: config.trustRequestIdHeader }));

  app.enableCors({
    // No `origin: true`, no `*`: the allowlist is the policy.
    origin: [...config.corsOrigins],
    // Not enabled. Nothing in this phase issues a cookie, so allowing
    // credentialed cross-origin requests would only widen the surface.
    credentials: false,
    methods: ["GET", "POST", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "X-Request-Id", "Idempotency-Key", "If-Match"],
    exposedHeaders: ["X-Request-Id"],
    maxAge: 600,
  });

  // No global validation pipe: Zod schemas are bound per parameter with
  // `ZodValidationPipe`, because a global pipe has no way to know which schema
  // belongs to which argument and would silently validate nothing.
  app.useGlobalFilters(new ApiExceptionFilter(config));

  // Probes stay outside the version prefix: a version bump must not break the
  // thing that decides whether the process is alive.
  app.setGlobalPrefix("v1", { exclude: ["health", "health/ready"] });

  // Makes SIGTERM/SIGINT run `onModuleDestroy`, which is what closes the pool.
  app.enableShutdownHooks();

  return app;
}
