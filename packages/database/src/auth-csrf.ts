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
 * token to a session is that an unusable session has no usable token. `now()`
 * would be wrong for the same reason it was wrong in `resolveSession`: it is
 * `transaction_timestamp()`, frozen before the row is reached.
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
 */
export async function readSessionCsrfToken(
  client: PrismaClient,
  sessionId: string,
): Promise<string | null> {
  const rows = await client.$queryRaw<{ csrf_token: string | null }[]>`
    SELECT csrf_token
      FROM app.sessions
     WHERE id = ${sessionId}
       AND revoked_at IS NULL
       AND expires_at > clock_timestamp()
       AND absolute_expires_at > clock_timestamp()
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
 * candidate; the conditional UPDATE lets exactly one persist it, the loser's
 * UPDATE matches no row, and the loser re-reads and adopts the winner's token. The
 * loser's candidate is discarded and never stored — which is why the mint happens
 * before the claim rather than inside it.
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
    UPDATE app.sessions
       SET csrf_token = ${mint()}
     WHERE id = ${sessionId}
       AND csrf_token IS NULL
       AND revoked_at IS NULL
       AND expires_at > clock_timestamp()
       AND absolute_expires_at > clock_timestamp()
    RETURNING csrf_token
  `;

  if (claimed[0] !== undefined) return claimed[0].csrf_token;

  // Lost the race, or the session became unusable between the read and the claim.
  return readSessionCsrfToken(client, sessionId);
}
