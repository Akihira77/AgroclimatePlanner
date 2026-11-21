import { createHash, randomBytes } from "node:crypto";

/**
 * The session token (`ADR-005`).
 *
 * 32 bytes of CSPRNG output, base64url, 43 characters. The token carries no user
 * id, role, or timestamp: it is a lookup key, and a caller who decodes it learns
 * nothing. Only `sha256(token)` is persisted.
 *
 * The raw value exists in exactly two places — the caller's cookie and this
 * process's memory for the duration of the request. It is never returned in a
 * body, logged, or written to the database.
 */

export const SESSION_TOKEN_BYTES = 32;
export const SESSION_TOKEN_LENGTH = 43;

/** base64url, no padding: 32 bytes encode to exactly 43 characters. */
const WELL_FORMED_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function createSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString("base64url");
}

/**
 * Rejects anything that is not 43 base64url characters *before* it reaches a
 * query. The token is a bearer credential, and one that cannot be a token needs no
 * database round trip — and must not become one, because a malformed value reaching
 * the query would be a request an attacker chose the shape of.
 */
export function isWellFormedSessionToken(value: unknown): value is string {
  return typeof value === "string" && WELL_FORMED_TOKEN.test(value);
}

/**
 * SHA-256, hex, lowercase — the exact representation
 * `sessions_token_hash_shape_check` accepts (`D-1`).
 *
 * Unsalted SHA-256 is correct here and nowhere else: the input is 256 bits of
 * CSPRNG output, so there is no dictionary and no rainbow table. Passwords are the
 * Argon2id path and must never reuse this.
 */
export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
