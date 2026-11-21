import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * Session operations (`ADR-005`), all through `app_auth`.
 *
 * Two things about this file are security properties rather than style:
 *
 * 1. **Every statement names its columns.** `app_auth` holds column-level grants,
 *    so `SELECT *` or `RETURNING *` fails with `42501`; and the credential must not
 *    receive columns it has no reason to see.
 * 2. **Every statement is constrained by `token_hash`.** `app_auth` can read every
 *    session row — RLS on this table is `USING (true)` by design — so the query
 *    shape is the isolation. Nothing here scans, counts, or lists sessions.
 *
 * The raw token never reaches this layer; callers pass `sha256(token)`.
 */

/** A live session joined to the user it authenticates. */
export interface ActiveSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
  readonly email: string;
  readonly role: string;
  readonly locale: string;
  readonly timezone: string;
}

export interface IssuedSession {
  readonly id: string;
  readonly expiresAt: Date;
  readonly absoluteExpiresAt: Date;
}

/**
 * Deadline arithmetic lives in SQL, not in JavaScript.
 *
 * `created_at` defaults to `now()`, which is the transaction timestamp. A deadline
 * computed from `Date.now()` is already later than `created_at + 90 days` by the
 * time the transaction started, and fails `sessions_absolute_expiry_cap_check`.
 * Using `now()` for all three timestamps makes the constraint hold by
 * construction. `expires_at > created_at` is likewise satisfied because the
 * interval is positive.
 */
export async function insertSession(
  client: PrismaClient,
  userId: string,
  tokenHash: string,
): Promise<IssuedSession> {
  const rows = await client.$queryRaw<RawIssued[]>`
    INSERT INTO app.sessions (user_id, token_hash, expires_at, absolute_expires_at)
    VALUES (${userId}, ${tokenHash}, now() + INTERVAL '30 days', now() + INTERVAL '90 days')
    RETURNING id::text AS id, expires_at, absolute_expires_at
  `;

  const row = rows[0];
  if (row === undefined) throw new Error("session insert returned no row");

  return {
    id: row.id,
    expiresAt: toDate(row.expires_at),
    absoluteExpiresAt: toDate(row.absolute_expires_at),
  };
}

/**
 * Resolves one session by its hash, and only if it is usable right now.
 *
 * All three validity conditions are in the predicate rather than in JavaScript:
 * a revoked, sliding-expired, or absolutely-expired row must never be returned as
 * a subject. Garbage collection is unrelated — it reclaims rows nobody can use,
 * and a row it has not reached is still rejected here.
 */
export async function findActiveSession(
  client: PrismaClient,
  tokenHash: string,
): Promise<ActiveSession | null> {
  const rows = await client.$queryRaw<RawActive[]>`
    SELECT s.id::text       AS "sessionId",
           s.user_id::text  AS "userId",
           s.expires_at,
           s.absolute_expires_at,
           u.email,
           u.role,
           u.locale,
           u.timezone
      FROM app.sessions s
      JOIN app.users u ON u.id = s.user_id
     WHERE s.token_hash = ${tokenHash}
       AND s.revoked_at IS NULL
       AND s.expires_at > now()
       AND s.absolute_expires_at > now()
     LIMIT 1
  `;

  const row = rows[0];
  if (row === undefined) return null;

  return {
    sessionId: row.sessionId,
    userId: row.userId,
    expiresAt: toDate(row.expires_at),
    absoluteExpiresAt: toDate(row.absolute_expires_at),
    email: row.email,
    role: row.role,
    locale: row.locale,
    timezone: row.timezone,
  };
}

/**
 * Extends the sliding deadline at most once per five minutes, atomically.
 *
 * The window is rechecked in the same `UPDATE` predicate that writes the row,
 * which is the whole mechanism: a concurrent request blocks on the row lock, then
 * PostgreSQL re-evaluates the predicate against the row the winner committed. The
 * loser's `last_seen_at <= now() - interval '5 minutes'` is then false, so it
 * updates nothing. A read-then-write in application code could not make that
 * claim — both callers would have read the same stale `last_seen_at` before
 * either wrote.
 *
 * `LEAST(...)` clamps the result to the absolute deadline, and
 * `absolute_expires_at` itself is never assigned: the grant does not cover it and
 * the intent does not include it.
 *
 * Returns the new sliding deadline, or `null` when the session was invalid or the
 * throttle held. The caller has already validated the session, so `null` is
 * "nothing to publish", not "unauthenticated".
 */
export async function extendSession(
  client: PrismaClient,
  tokenHash: string,
): Promise<{ expiresAt: Date; absoluteExpiresAt: Date } | null> {
  const rows = await client.$queryRaw<RawExtend[]>`
    UPDATE app.sessions
       SET last_seen_at = now(),
           expires_at   = LEAST(now() + INTERVAL '30 days', absolute_expires_at)
     WHERE token_hash = ${tokenHash}
       AND revoked_at IS NULL
       AND expires_at > now()
       AND absolute_expires_at > now()
       AND last_seen_at <= now() - INTERVAL '5 minutes'
    RETURNING expires_at, absolute_expires_at
  `;

  const row = rows[0];
  if (row === undefined) return null;

  return {
    expiresAt: toDate(row.expires_at),
    absoluteExpiresAt: toDate(row.absolute_expires_at),
  };
}

/**
 * Revokes by setting `revoked_at`; it never deletes, because no runtime role holds
 * `DELETE` and a deleted row would erase the evidence that a session existed.
 *
 * Idempotent by predicate: revoking an already-revoked session returns `false`
 * and changes nothing, including the original timestamp. Logout treats both
 * outcomes the same, so a retry after a lost response is not a failure.
 */
export async function revokeSession(client: PrismaClient, tokenHash: string): Promise<boolean> {
  const rows = await client.$queryRaw<{ id: string }[]>`
    UPDATE app.sessions
       SET revoked_at = now()
     WHERE token_hash = ${tokenHash}
       AND revoked_at IS NULL
    RETURNING id::text AS id
  `;

  return rows.length > 0;
}

/** `timestamptz` arrives as a `Date` through `pg`; a string is tolerated, not expected. */
function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}

interface RawIssued {
  readonly id: string;
  readonly expires_at: Date | string;
  readonly absolute_expires_at: Date | string;
}

interface RawExtend {
  readonly expires_at: Date | string;
  readonly absolute_expires_at: Date | string;
}

interface RawActive {
  readonly sessionId: string;
  readonly userId: string;
  readonly expires_at: Date | string;
  readonly absolute_expires_at: Date | string;
  readonly email: string;
  readonly role: string;
  readonly locale: string;
  readonly timezone: string;
}
