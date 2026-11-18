import { performance } from "node:perf_hooks";

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

/**
 * The readiness budget, in two shares that cannot both be spent.
 *
 * `maxWait` and the transaction `timeout` are separate client-side waits, so
 * setting both to the whole budget would bound a request at twice the budget. The
 * shares are sequential and disjoint, which makes acquisition + execution ≤
 * `READINESS_BUDGET_MS` by construction rather than by hope. 1 s each is ample for
 * `SELECT 1`: a database that needs longer than a second to hand over a pooled
 * connection is not ready, and saying so is the probe's job.
 */
const READINESS_BUDGET_MS = 2000;
const ACQUISITION_BUDGET_MS = 1000;
const EXECUTION_BUDGET_MS = READINESS_BUDGET_MS - ACQUISITION_BUDGET_MS;

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
   * One budget, spent in two stages that cannot overlap:
   *
   * - `maxWait` bounds waiting for a pooled connection.
   * - `timeout` bounds the transaction as a whole and makes Prisma roll it back,
   *   which is what releases the connection back to the pool.
   * - `SET LOCAL statement_timeout` is the only bound on *the database doing the
   *   work*. PostgreSQL aborts the statement at the deadline and returns `57014`,
   *   so the server stops executing; the connection is then free. It is scoped to
   *   the transaction, so it cannot leak into another borrower of that connection,
   *   and its value is the budget still remaining when the transaction starts —
   *   the monotonic clock, never a wall clock a time adjustment can move.
   *
   * It was verified against the development server, not assumed: `SET LOCAL
   * statement_timeout = 200; SELECT pg_sleep(1);` returns `ERROR: canceling
   * statement due to statement timeout`.
   *
   * What this does *not* buy: `maxWait` is a client-side rejection. The pool's own
   * connect attempt is not aborted by it, so a host that blackholes SYNs can still
   * leave one pending attempt behind until the TCP timeout. The HTTP response is
   * bounded; the socket is not.
   *
   * `Promise.race` was the previous mechanism and bounded only how long the HTTP
   * response waited; the query kept running.
   *
   * Redis is not checked: it is not provisioned, and reporting on a dependency
   * that does not exist would be permanently red.
   */
  @Get("ready")
  async ready(): Promise<ReadyResponse> {
    const deadline = performance.now() + READINESS_BUDGET_MS;

    try {
      await this.client.$transaction(
        async (tx) => {
          const remaining = Math.min(EXECUTION_BUDGET_MS, Math.floor(deadline - performance.now()));

          // Acquisition consumed the whole budget, so there is nothing left to
          // give the statement; failing here beats a `SET LOCAL ... = 0`, which
          // PostgreSQL reads as "no limit".
          if (remaining <= 0) throw new Error("readiness budget exhausted");

          // A constant derived from this file's own budget, never a caller value,
          // so interpolation is safe; `SET` does not accept bind parameters.
          await tx.$executeRawUnsafe(`SET LOCAL statement_timeout = ${remaining}`);
          await tx.$queryRaw`SELECT 1`;
        },
        { timeout: EXECUTION_BUDGET_MS, maxWait: ACQUISITION_BUDGET_MS },
      );
    } catch {
      // The reason stays out of the probe response; the filter logs the code and
      // the request id, nothing more.
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    return { status: "ok", checks: { database: "ok" } };
  }
}
