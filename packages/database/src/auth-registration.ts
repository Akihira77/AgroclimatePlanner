import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * The authentication boundary's user operations (`ADR-004`).
 *
 * Everything here runs through `app_auth` and is written as explicit SQL rather
 * than Prisma's model API, for one measured reason: the generated queries select
 * every column, and `app_auth` has no `SELECT` on `created_at` or `updated_at`.
 * `RETURNING *` fails with `42501` *after* the row was inserted, so a registration
 * that used `client.user.create` would report a failure that did not happen.
 * Naming the columns the grant covers is what keeps the read inside the approved
 * boundary (`H-1`).
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
 * A credential row. This type never leaves the authentication process: it carries
 * `passwordHash`, and serialising it would be the leak the whole boundary exists
 * to prevent.
 */
export interface AuthUserRecord extends RegisteredUser {
  readonly passwordHash: string;
}

/**
 * The duplicate-address signal, kept as its own type so the endpoint maps one
 * condition to `409 CONFLICT` instead of pattern-matching a driver message.
 */
export class EmailAlreadyRegisteredError extends Error {
  override readonly name = "EmailAlreadyRegisteredError";
}

/** The one constraint that means "this address is taken". */
export const EMAIL_UNIQUE_CONSTRAINT = "users_email_key";

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
    if (isEmailUniqueViolation(error)) throw new EmailAlreadyRegisteredError();
    throw error;
  }
}

/**
 * Looks a credential up by the normalized address, through `app_auth`.
 *
 * `email` is expected to have been normalised by the shared contract function;
 * this layer does not normalise, because two places applying the rule is how they
 * start disagreeing. The lookup is an equality match on the unique index, and it
 * is the only read on this table that returns `password_hash`.
 */
export async function findAuthUserByEmail(
  client: PrismaClient,
  email: string,
): Promise<AuthUserRecord | null> {
  const rows = await client.$queryRaw<AuthUserRecord[]>`
    SELECT id::text AS id,
           email,
           password_hash AS "passwordHash",
           role,
           locale,
           timezone
      FROM app.users
     WHERE email = ${email}
       AND deleted_at IS NULL
     LIMIT 1
  `;

  return rows[0] ?? null;
}

/** Looks up an active user by id through `app_auth` for password verification. */
export async function findAuthUserById(
  client: PrismaClient,
  userId: string,
): Promise<AuthUserRecord | null> {
  const rows = await client.$queryRaw<AuthUserRecord[]>`
    SELECT id::text AS id,
           email,
           password_hash AS "passwordHash",
           role,
           locale,
           timezone
      FROM app.users
     WHERE id = ${userId}::uuid
       AND deleted_at IS NULL
     LIMIT 1
  `;

  return rows[0] ?? null;
}

/**
 * Updates the user's password hash (`AUTH-14`) and revokes all other active
 * sessions via the narrow `SECURITY DEFINER` function granted to `app_auth`.
 */
export async function changeUserPassword(
  client: PrismaClient,
  userId: string,
  newPasswordHash: string,
  keepSessionId: string | null = null,
): Promise<boolean> {
  const rows = await client.$queryRaw<{ changed: boolean }[]>`
    SELECT app.change_user_password(
      ${userId}::uuid,
      ${newPasswordHash},
      ${keepSessionId}::uuid
    ) AS changed
  `;
  return rows[0]?.changed === true;
}

/**
 * Soft-deletes an account (`OPEN-04`) and revokes all of its live sessions via
 * the narrow `SECURITY DEFINER` function granted to `app_auth`.
 */
export async function softDeleteAccount(client: PrismaClient, userId: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ deleted: boolean }[]>`
    SELECT app.soft_delete_account(${userId}::uuid) AS deleted
  `;
  return rows[0]?.deleted === true;
}

/**
 * `true` only for a violation of `users_email_key`.
 *
 * The earlier version treated every SQLSTATE `23505` as a duplicate address. That
 * was wrong for a table with two unique constraints: `app.users` also has a
 * primary key, so an unrelated collision would have been reported to the caller as
 * `409` for an address that was never taken.
 *
 * The constraint identity is read structurally from wherever the driver put it —
 * `pg` exposes `error.constraint`, Prisma 7 nests it at
 * `meta.driverAdapterError.cause.constraint.index` — and matched by name.
 *
 * **When the name cannot be found, the answer is `false`.** An unattributable
 * unique violation becomes an internal error, which is honest; guessing "email"
 * would be the bug this function was fixed to remove. No message text is parsed:
 * `originalMessage` is a human string, and a constraint name cannot be derived
 * from it safely.
 */
export function isEmailUniqueViolation(error: unknown): boolean {
  const found = { unique: false, constraints: new Set<string>() };
  collect(error, 0, found);
  return found.unique && found.constraints.has(EMAIL_UNIQUE_CONSTRAINT);
}

interface Found {
  unique: boolean;
  constraints: Set<string>;
}

/** Bounded depth: the shapes are known, and an unbounded walk is a cycle risk. */
function collect(value: unknown, depth: number, found: Found): void {
  if (depth > 6 || typeof value !== "object" || value === null) return;

  if (Array.isArray(value)) {
    for (const item of value) collect(item, depth + 1, found);
    return;
  }

  const record = value as Record<string, unknown>;

  if (
    record["code"] === "23505" ||
    record["originalCode"] === "23505" ||
    record["sqlState"] === "23505"
  ) {
    found.unique = true;
  }

  for (const key of ["constraint", "index", "constraintName", "name"] as const) {
    const candidate = record[key];
    if (typeof candidate === "string") found.constraints.add(candidate);
  }

  for (const key of ["meta", "cause", "driverAdapterError", "constraint"] as const) {
    const nested = record[key];
    if (nested !== undefined && nested !== null) collect(nested, depth + 1, found);
  }
}
