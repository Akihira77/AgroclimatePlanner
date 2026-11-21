import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Registration writes through the authentication boundary (`ADR-004`).
 *
 * The insert is raw SQL rather than `client.user.create`, and deliberately so:
 * Prisma's `create` returns every column, and `app_auth` has no `SELECT` on
 * `created_at` or `updated_at`, so the generated `RETURNING *` would fail with
 * `42501` after the row had been inserted. Naming the five columns the grant does
 * cover is what keeps the response inside the approved boundary (`H-1`).
 */

/** The columns `app_auth` may read back: no timestamps. */
export interface RegisteredUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly locale: string;
  readonly timezone: string;
}

/**
 * The duplicate-address signal, kept as its own type so the endpoint maps one
 * condition to `409 CONFLICT` instead of pattern-matching a driver message.
 */
export class EmailAlreadyRegisteredError extends Error {
  override readonly name = "EmailAlreadyRegisteredError";
}

/**
 * Inserts the account without a prior existence check (`IG-2`).
 *
 * The unique constraint is the atomic source of truth: two concurrent requests
 * both attempt the insert, PostgreSQL serialises them, and the loser sees
 * `23505`. A `SELECT` first would be racy and would also make the timing depend
 * on whether the address exists.
 */
export async function insertRegisteredUser(
  client: PrismaClient,
  email: string,
  passwordHash: string,
): Promise<RegisteredUser> {
  try {
    const rows = await client.$queryRaw<RegisteredUser[]>`
      INSERT INTO app.users (email, password_hash)
      VALUES (${email}, ${passwordHash})
      RETURNING id::text AS id, email, role, locale, timezone
    `;

    const row = rows[0];
    if (row === undefined) {
      // An insert that returned no row is not something the endpoint can answer;
      // failing beats fabricating a user.
      throw new Error("registration insert returned no row");
    }
    return row;
  } catch (error) {
    if (isUniqueViolation(error)) throw new EmailAlreadyRegisteredError();
    throw error;
  }
}

/**
 * PostgreSQL `23505` (`unique_violation`), independent of how Prisma wrapped it.
 *
 * Prisma 7 reports a failed raw query as `P2010` and nests the driver's own
 * fields — `meta.driverAdapterError.cause.originalCode` — rather than exposing the
 * SQLSTATE at the top level. Older shapes (`meta.code`) and a direct driver error
 * are checked too, because the wrapper is not part of the SQL contract. The
 * constraint name is not matched: `users` has one unique constraint on this path,
 * so the state alone is unambiguous here.
 */
export function isUniqueViolation(error: unknown, depth = 0): boolean {
  if (typeof error !== "object" || error === null || depth > 5) return false;

  const record = error as Record<string, unknown>;
  if (record["code"] === "23505" || record["originalCode"] === "23505") return true;

  const meta = record["meta"];
  if (typeof meta === "object" && meta !== null) {
    const nested = meta as Record<string, unknown>;
    if (nested["code"] === "23505") return true;
    if (nested["driverAdapterError"] !== undefined) {
      if (isUniqueViolation(nested["driverAdapterError"], depth + 1)) return true;
    }
  }

  return record["cause"] !== undefined && isUniqueViolation(record["cause"], depth + 1);
}
