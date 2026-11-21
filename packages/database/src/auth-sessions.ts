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

/** What a presented token resolved to. Only `active` carries a subject. */
export type SessionOutcome = "active" | "revoked" | "expired" | "unknown";

export type SessionResolution =
  | {
      readonly outcome: "active";
      /** Whether this request also moved the sliding deadline. */
      readonly extended: boolean;
      readonly session: ActiveSession;
    }
  | { readonly outcome: "revoked" | "expired" | "unknown" };

/**
 * Validates a session and extends it, in **one statement**.
 *
 * The previous shape was `findActiveSession()` followed by `extendSession()`. The
 * second call returned `null` both when the throttle held and when the session had
 * been revoked or had expired in between, and the caller could not tell the two
 * apart — so a request that lost the race to a concurrent logout authenticated on
 * the row it had read *before* the revocation. Two round trips cannot fix that:
 * the window between them is exactly the window a logout needs.
 *
 * One statement closes it, because `SELECT ... FOR UPDATE` in `candidate` takes a
 * row lock that is held until the statement ends. Two consequences, both required:
 *
 * - A concurrent revoke waits for this statement, so it either lands before the
 *   read (the row is then seen revoked) or after the subject has been established.
 *   It can never land in between and be ignored.
 * - A concurrent extension waits too, then sees the committed `last_seen_at`, so
 *   the throttle's predicate is evaluated against the winner's write rather than a
 *   stale snapshot.
 *
 * The outcome is classified in SQL, but the classification is only used to *describe*
 * a failure for the operator (`revoked`, `expired`, `unknown`); every non-active
 * outcome collapses to the same `null` in the service and the same `401` on the
 * wire. Distinguishing them for the client would tell an attacker whether a
 * stolen, revoked token ever existed.
 *
 * `FOR UPDATE` needs `UPDATE` privilege on at least one column, which `app_auth`
 * already holds on `expires_at`/`last_seen_at`/`revoked_at`; no privilege or
 * migration was added for this statement.
 */
export async function resolveSession(
  client: PrismaClient,
  tokenHash: string,
): Promise<SessionResolution> {
  const rows = await client.$queryRaw<RawResolution[]>`
    WITH candidate AS (
      SELECT id, user_id, expires_at, absolute_expires_at, last_seen_at, revoked_at
        FROM app.sessions
       WHERE token_hash = ${tokenHash}
       FOR UPDATE
    ),
    extended AS (
      UPDATE app.sessions s
         SET last_seen_at = now(),
             expires_at   = LEAST(now() + INTERVAL '30 days', s.absolute_expires_at)
        FROM candidate c
       WHERE s.id = c.id
         AND c.revoked_at IS NULL
         AND c.expires_at > now()
         AND c.absolute_expires_at > now()
         AND c.last_seen_at <= now() - INTERVAL '5 minutes'
      RETURNING s.id, s.expires_at, s.absolute_expires_at
    )
    SELECT CASE
             WHEN c.revoked_at IS NOT NULL THEN 'revoked'
             WHEN c.expires_at <= now() OR c.absolute_expires_at <= now() THEN 'expired'
             ELSE 'active'
           END AS outcome,
           (e.id IS NOT NULL) AS extended,
           COALESCE(e.expires_at, c.expires_at) AS "expiresAt",
           COALESCE(e.absolute_expires_at, c.absolute_expires_at) AS "absoluteExpiresAt",
           c.id::text       AS "sessionId",
           c.user_id::text  AS "userId",
           u.email,
           u.role,
           u.locale,
           u.timezone
      FROM candidate c
      LEFT JOIN extended e ON e.id = c.id
      LEFT JOIN app.users u ON u.id = c.user_id
  `;

  const row = rows[0];
  // No candidate row at all: the token names no session. Reported as `unknown`
  // rather than folded into `expired`, because a deleted row and an expired one
  // are different operator facts even though they are the same client answer.
  if (row === undefined) return { outcome: "unknown" };
  if (row.outcome !== "active") return { outcome: row.outcome };

  // A live session whose user row is missing cannot be authenticated. The foreign
  // key makes this unreachable; failing is better than inventing a subject.
  if (row.email === null || row.role === null || row.locale === null || row.timezone === null) {
    throw new Error("session resolved without its user row");
  }

  return {
    outcome: "active",
    extended: row.extended,
    session: {
      sessionId: row.sessionId,
      userId: row.userId,
      expiresAt: toDate(row.expiresAt),
      absoluteExpiresAt: toDate(row.absoluteExpiresAt),
      email: row.email,
      role: row.role,
      locale: row.locale,
      timezone: row.timezone,
    },
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

interface RawResolution {
  readonly outcome: SessionOutcome;
  readonly extended: boolean;
  readonly expiresAt: Date | string;
  readonly absoluteExpiresAt: Date | string;
  readonly sessionId: string;
  readonly userId: string;
  readonly email: string | null;
  readonly role: string | null;
  readonly locale: string | null;
  readonly timezone: string | null;
}
