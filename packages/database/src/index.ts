/**
 * Database access. Phase 2.2.1 exposes the client factory and nothing else —
 * there are no models yet, so there is nothing domain-specific to export.
 *
 * The generated client lives in `src/generated/prisma` and is rebuilt by
 * `pnpm build` before `tsc` runs. It is not committed.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export { PrismaClient } from "./generated/prisma/client.js";
export { Prisma } from "./generated/prisma/client.js";

export interface DatabaseOptions {
  /** `postgresql://…` connection string. Validated by `pg`, not by us. */
  readonly connectionString: string;
}

/**
 * Prisma 7 talks to PostgreSQL through a driver adapter; there is no bundled
 * query engine. That also means connection pooling is `pg`'s Pool, which is
 * what the pool-leak tests in Phase 2.2.3 will need to assert against.
 */
export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({ connectionString: options.connectionString });
  return new PrismaClient({ adapter });
}
