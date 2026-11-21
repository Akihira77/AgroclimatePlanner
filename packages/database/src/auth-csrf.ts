import type { PrismaClient } from "./generated/prisma/client.js";

/**
 * The session-bound CSRF synchronizer token (`ADR-006` §D2, `Amendment 4`).
 *
 * Two operations, both scoped to one session id and both through `app_auth`:
 * `readSessionCsrfToken` for validation and `resolveSessionCsrfToken` for lazy
 * issuance. Neither can name a session the caller has not already authenticated —
 * the id comes from the guard's validated `resolveSession` result, never from a
 * request body, query parameter, or header.
 *
 * Every statement here repeats the session's own validity predicates. The guard has
 * just checked them, but a token read that trusted that timing would keep answering
 * for a session revoked or expired in between, and the whole point of binding the
 * token to a session is that an unusable session has no usable token.
 *
 * **One instant per statement.** `now()` would be wrong for the reason it was wrong
 * in `resolveSession` — it is `transaction_timestamp()`, frozen before the row is
 * reached — but so is a bare `clock_timestamp()`, because two references in the same
 * `WHERE` can straddle the millisecond at which the session expires, and the two
 * deadlines would then be compared against different instants. Each statement reads
 * the clock exactly once into a `MATERIALIZED` CTE and compares both deadlines with
 * `ev.at`. `MATERIALIZED` is what makes "once" true: an inlined CTE is re-evaluated
 * per reference.
 *
 * The token is plaintext by decision, not by oversight: it must be re-served
 * unchanged on every retrieval, which a hash cannot do. It is not a bearer
 * credential — presenting it without the `HttpOnly` session cookie proves nothing.
 */

/**
 * The token already issued to this session, or `null` when none exists yet or the
 * session is no longer usable.
 *
 * `null` is not distinguished between those two cases on purpose: validation answers
 * the same `403` either way, and a caller that could tell them apart could probe for
 * a session's existence.
 *
 * A plain `SELECT` takes no row lock, so there is no blocking operation for the
 * timestamp to be captured behind; the CTE is evaluated as the statement starts.
 */
export async function readSessionCsrfToken(
  client: PrismaClient,
  sessionId: string,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ csrf_token: string | null }[]>`
    WITH evaluation AS MATERIALIZED (
      SELECT clock_timestamp() AS at
    )
    SELECT s.csrf_token
      FROM app.sessions s
      CROSS JOIN evaluation ev
     WHERE s.id = ${sessionId}
       AND s.revoked_at IS NULL
       AND s.expires_at > ev.at
       AND s.absolute_expires_at > ev.at
  `;

  return rows[0]?.csrf_token ?? null;
}

/**
 * Returns this session's CSRF token, minting one on the first retrieval.
 *
 * Lazy generation is what lets the column be nullable, which is what keeps every
 * existing session valid without a backfill. The write is conditional —
 * `WHERE csrf_token IS NULL` — so it is a claim, not an assignment: a token is
 * never overwritten and therefore never rotated, and a reload or a second tab gets
 * the same value back.
 *
 * Two simultaneous first retrievals must not leave two live values. Both mint a
 * candidate; `candidate` takes the row lock, so the second claim queues at the lock
 * rather than racing the first, and when it proceeds it sees the committed token and
 * matches no row. The loser then re-reads and adopts the winner's token. Its own
 * candidate is discarded and never stored — which is why the mint happens before the
 * claim rather than inside it.
 *
 * **The clock is read after the lock.** `evaluation` selects `FROM candidate`, so it
 * cannot run before the candidate scan has produced its row, and that scan cannot
 * produce it before the row lock is granted. A session that expires during the wait
 * is therefore compared against the instant the statement actually proceeded at, not
 * the instant it started queueing. Without `clock_timestamp()` here the claim could
 * write a token to a session whose deadline had already passed.
 *
 * `mint` is a parameter instead of an import so the database layer keeps no
 * opinion about token entropy: `crypto` belongs to the caller that already owns
 * `session-token.ts`, and a test can push a known candidate through the race.
 *
 * Returns `null` only when the session row is missing or no longer usable; it never
 * returns `null` because the token happened to be absent.
 */
export async function resolveSessionCsrfToken(
  client: PrismaClient,
  sessionId: string,
  mint: () => string,
): Promise<string | null> {
  const existing = await readSessionCsrfToken(client, sessionId);
  if (existing !== null) return existing;

  const claimed = await client.$queryRaw<{ csrf_token: string }[]>`
    WITH candidate AS (
      SELECT id
        FROM app.sessions
       WHERE id = ${sessionId}
       FOR UPDATE
    ),
    evaluation AS MATERIALIZED (
      SELECT clock_timestamp() AS at
        FROM candidate
    )
    UPDATE app.sessions s
       SET csrf_token = ${mint()}
      FROM evaluation ev
     WHERE s.id = ${sessionId}
       AND s.csrf_token IS NULL
       AND s.revoked_at IS NULL
       AND s.expires_at > ev.at
       AND s.absolute_expires_at > ev.at
    RETURNING s.csrf_token
  `;

  if (claimed[0] !== undefined) return claimed[0].csrf_token;

  // Lost the race, or the session became unusable between the read and the claim.
  return readSessionCsrfToken(client, sessionId);
}
