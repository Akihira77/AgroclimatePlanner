import { Controller, Get, Inject, ServiceUnavailableException } from "@nestjs/common";
import { CONTRACTS_VERSION, weatherDataClassSchema } from "@agroclimate/contracts";
import type { PrismaClient } from "@agroclimate/database";

import { DATABASE_CLIENT } from "../tokens.js";

interface HealthResponse {
  status: "ok";
  contractsVersion: string;
  dataClassCount: number;
}

interface ReadyResponse {
  status: "ok";
  checks: { database: "ok" };
}

/** A readiness probe must answer, not hang. Chosen to sit under any sane LB timeout. */
const READINESS_TIMEOUT_MS = 2000;

@Controller("health")
export class HealthController {
  constructor(@Inject(DATABASE_CLIENT) private readonly client: PrismaClient) {}

  /**
   * The handler deliberately loads a runtime value from `@agroclimate/contracts`.
   * A type-only import would prove nothing about workspace resolution.
   *
   * Liveness only: it touches nothing, so a database outage cannot make the
   * process look dead and get it restarted for no reason.
   */
  @Get()
  check(): HealthResponse {
    return {
      status: "ok",
      contractsVersion: CONTRACTS_VERSION,
      dataClassCount: weatherDataClassSchema.options.length,
    };
  }

  /**
   * Readiness, including the database.
   *
   * Three bounds, and they cover different things:
   *
   * - `SET LOCAL statement_timeout` is the only one that bounds *the database
   *   doing the work*. PostgreSQL aborts the statement at the deadline and returns
   *   `57014`, so the server stops executing; the connection is then free. This was
   *   verified against the development server, not assumed: `SET LOCAL
   *   statement_timeout = 200; SELECT pg_sleep(1);` returns
   *   `ERROR: canceling statement due to statement timeout`.
   * - `maxWait` bounds waiting for a pooled connection. It is a client-side
   *   rejection: the pool's own connect attempt is not aborted by it, so a host
   *   that blackholes SYNs can still leave one pending attempt behind. It
   *   eventually fails on TCP timeout.
   * - `timeout` bounds the transaction as a whole and makes Prisma roll it back,
   *   which is what releases the connection back to the pool.
   *
   * `Promise.race` was the previous mechanism and bounded only how long the HTTP
   * response waited; the query kept running. `SET LOCAL` is scoped to the
   * transaction, so it cannot leak into any other borrower of the same connection.
   *
   * Redis is not checked: it is not provisioned, and reporting on a dependency
   * that does not exist would be permanently red.
   */
  @Get("ready")
  async ready(): Promise<ReadyResponse> {
    try {
      await this.client.$transaction(
        async (tx) => {
          // A constant from this file, never a caller value, so interpolation is
          // safe; `SET` does not accept bind parameters.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${READINESS_TIMEOUT_MS}`);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: READINESS_TIMEOUT_MS, maxWait: READINESS_TIMEOUT_MS },
      );
    } catch {
      // The reason stays out of the probe response; the filter logs the code and
      // the request id, nothing more.
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    return { status: "ok", checks: { database: "ok" } };
  }
}
