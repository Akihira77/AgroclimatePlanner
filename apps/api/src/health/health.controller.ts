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
   * Readiness, including the database. `SELECT 1` through the pooled client is
   * the cheapest statement that proves a connection can be obtained — a pool
   * that exists but cannot connect is exactly the failure this must not miss.
   *
   * Redis is not checked: it is not provisioned, and reporting on a dependency
   * that does not exist would be a lie that is permanently red.
   */
  @Get("ready")
  async ready(): Promise<ReadyResponse> {
    try {
      await withTimeout(this.client.$queryRaw`SELECT 1`, READINESS_TIMEOUT_MS);
    } catch {
      // The reason stays in the log at the filter level; a probe response is not
      // the place to describe a connection string to an unauthenticated caller.
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE" });
    }
    return { status: "ok", checks: { database: "ok" } };
  }
}

async function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`readiness check exceeded ${ms} ms`)), ms);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
