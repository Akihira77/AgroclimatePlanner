/**
 * Database access. Phase 2.2.1 exposed the client factory; Phase 2.2.3 adds the
 * one entry point through which tenant-owned data may be read or written.
 *
 * The generated client lives in `src/generated/prisma` and is rebuilt by
 * `pnpm build` before `tsc` runs. It is not committed.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export { PrismaClient } from "./generated/prisma/client.js";
export { Prisma } from "./generated/prisma/client.js";
export {
  EMAIL_UNIQUE_CONSTRAINT,
  EmailAlreadyRegisteredError,
  findAuthUserByEmail,
  insertRegisteredUser,
  isEmailUniqueViolation,
} from "./auth-registration.js";
export type { AuthUserRecord, RegisteredUser } from "./auth-registration.js";
export { extendSession, findActiveSession, insertSession, revokeSession } from "./auth-sessions.js";
export type { ActiveSession, IssuedSession } from "./auth-sessions.js";
export { createTenantScope, normaliseTenantId, TenantContextError } from "./tenant.js";
export type { TenantScope, TenantTransaction } from "./tenant.js";

export interface DatabaseOptions {
  /** `postgresql://…` connection string. Validated by `pg`, not by us. */
  readonly connectionString: string;
  /**
   * Pool size. Only the connection-reuse tests set this — `1` forces every
   * transaction onto the same physical connection, which is the condition under
   * which a leaked `app.user_id` would actually cross tenants.
   */
  readonly poolMax?: number;
}

/**
 * Prisma 7 talks to PostgreSQL through a driver adapter; there is no bundled
 * query engine. That also means connection pooling is `pg`'s Pool.
 *
 * This factory is the *runtime* identity. It must never be handed
 * `MIGRATION_DATABASE_URL`: migrations connect as the schema owner, and the
 * runtime roles are the ones the RLS policies are written against.
 */
export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...(options.poolMax === undefined ? {} : { max: options.poolMax }),
  });
  return new PrismaClient({ adapter });
}
