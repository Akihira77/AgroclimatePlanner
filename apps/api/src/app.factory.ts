import "reflect-metadata";

import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { GridRegistry } from "@agroclimate/contracts";
import type { NestExpressApplication } from "@nestjs/platform-express";
import { createPrismaClient } from "@agroclimate/database";
import type { DatabaseClientFactory } from "./database/database.module.js";
import cookieParser from "cookie-parser";
import type { Express } from "express";
import helmet from "helmet";

import { AppModule } from "./app.module.js";
import type { RuntimeConfig } from "./config/runtime-config.js";
import { ApiExceptionFilter } from "./http/api-exception.filter.js";
import { originValidation } from "./http/origin.middleware.js";
import { requestIdMiddleware } from "./http/request-id.middleware.js";

export interface CreateApplicationOptions {
  readonly config: RuntimeConfig;
  readonly createDatabaseClient?: DatabaseClientFactory;
  /** Test-only substitution for the grid registry; production omits it. */
  readonly gridRegistry?: GridRegistry;
}

/**
 * The largest request body the API accepts, stated instead of inherited.
 *
 * A registration body is bounded by the contract: a 1024-byte password plus a
 * 254-character address plus JSON overhead is well under 2 KiB. 16 KiB leaves
 * room for a generous future body while keeping the parser's allocation small;
 * the Nest/Express default (100 KiB) was implicit, and an implicit bound is one
 * nobody reviewed.
 */
export const REQUEST_BODY_LIMIT = "16kb";

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
  const app = await NestFactory.create<NestExpressApplication>(
    AppModule.register({
      config,
      // `createPrismaClient` takes the options object; the factory the module
      // wants takes the url. Adapting here keeps one Prisma entry point.
      createDatabaseClient:
        options.createDatabaseClient ??
        ((connectionString) => createPrismaClient({ connectionString })),
      ...(options.gridRegistry === undefined ? {} : { gridRegistry: options.gridRegistry }),
    }),
    // Errors are logged by the exception filter, which knows the request id.
    {
      logger: config.nodeEnv === "production" ? ["error", "warn"] : ["error", "warn", "log"],
    },
  );

  const express: Express = app.getHttpAdapter().getInstance();

  // `true` is rejected by configuration parsing: with it, any caller sets
  // `X-Forwarded-For` and picks their own client IP.
  express.set("trust proxy", config.trustProxy === false ? false : [...config.trustProxy]);
  express.disable("x-powered-by");

  // Order is a security property (`ADR-006`), not a preference:
  //
  // 1. The request id exists before anything can refuse a request, so the
  //    correlation id a client is given and the one in an error body agree —
  //    including for an `Origin` refusal that never reaches a controller.
  // 2. `Origin` is validated before the body is parsed, so a forged state-changing
  //    request costs no parsing, no hashing, and no query.
  // 3. Only then are bodies parsed, with an explicit bound rather than the
  //    adapter's implicit 100 KiB default.
  app.use(requestIdMiddleware({ trustIncoming: config.trustRequestIdHeader }));
  app.use(originValidation({ trustedOrigins: config.corsOrigins }));
  app.useBodyParser("json", { limit: REQUEST_BODY_LIMIT });
  app.useBodyParser("urlencoded", { extended: false, limit: REQUEST_BODY_LIMIT });

  app.use(helmet());
  // No secret: the session cookie is opaque and unsigned, by design (`ADR-006`).
  // Signing would imply a second trust decision nobody has made.
  app.use(cookieParser());

  app.enableCors({
    // No `origin: true`, no `*`: the allowlist is the policy. Credentialed CORS
    // requires exactly this — a wildcard origin with credentials is invalid by
    // specification, and reflecting any origin would defeat the cookie's scope.
    origin: [...config.corsOrigins],
    // The web app is a separate origin from the API (`ADR-006`), so the browser
    // sends the session cookie only if the response allows credentials.
    credentials: true,
    // `PUT` is here because `ADR-006` D2.1.5 names it as a state-changing method
    // and `originValidation` enforces it. Leaving it out of CORS made the preflight
    // answer "method not allowed" for the one verb the middleware had already
    // promised to protect.
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    // `X-CSRF-Token` is here because `AuthGuard` requires it on every
    // authenticated mutation; without the CORS entry the browser's preflight
    // would refuse the header the guard expects.
    allowedHeaders: ["Content-Type", "X-Request-Id", "Idempotency-Key", "If-Match", "X-CSRF-Token"],
    // The rate limiter's headers are useless to a browser client if CORS hides
    // them, and `Retry-After` is what a client backs off on.
    exposedHeaders: [
      "X-Request-Id",
      "RateLimit-Limit",
      "RateLimit-Remaining",
      "RateLimit-Reset",
      "Retry-After",
    ],
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
