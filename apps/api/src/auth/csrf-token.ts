import { randomBytes, timingSafeEqual } from "node:crypto";

import { CSRF_TOKEN_PATTERN } from "@agroclimate/contracts";

/**
 * The CSRF token's value, its strict shape rule, and its comparison.
 *
 * 32 random bytes encoded base64url without padding is 43 characters — the size
 * *Amendment 4* fixed. `randomBytes` is the CSPRNG; `Math.random()` is not
 * mentioned anywhere and must not be, because a predictable token is not a token.
 *
 * The value is not a bearer credential. It authenticates nothing on its own: it
 * proves the request came from a page that could read this session's own response,
 * and the `HttpOnly` session cookie is what makes that claim meaningful.
 */

export const CSRF_TOKEN_BYTES = 32;
export const CSRF_HEADER = "x-csrf-token";

/** 43 base64url characters, no padding. */
export function createCsrfToken(): string {
  return randomBytes(CSRF_TOKEN_BYTES).toString("base64url");
}

/**
 * Strict shape check. A regex alone would accept non-canonical encodings (trailing
 * bits that decode to the same 32 bytes), so the decoded length and the re-encoded
 * form are both required to agree with the input.
 *
 * This runs *before* any comparison: `timingSafeEqual` throws on unequal lengths,
 * so a malformed header would otherwise become a different failure than a wrong
 * one, and the difference would be observable.
 */
export function isWellFormedCsrfToken(value: unknown): value is string {
  if (typeof value !== "string" || !CSRF_TOKEN_PATTERN.test(value)) return false;

  const bytes = Buffer.from(value, "base64url");
  return bytes.length === CSRF_TOKEN_BYTES && bytes.toString("base64url") === value;
}

/**
 * Constant-time comparison of two well-formed tokens.
 *
 * Lengths are equal by construction (both are 32-byte buffers), which is what
 * `timingSafeEqual` requires. The shape checks are repeated here rather than
 * assumed, because the stored value comes from the database and a `NULL` or
 * malformed column must be a refusal, never a comparison of unequal buffers.
 */
export function csrfTokensMatch(presented: unknown, stored: unknown): boolean {
  if (!isWellFormedCsrfToken(presented) || !isWellFormedCsrfToken(stored)) return false;

  return timingSafeEqual(Buffer.from(presented, "base64url"), Buffer.from(stored, "base64url"));
}

/**
 * Reads `X-CSRF-Token` from the request headers, treating anything ambiguous as
 * absent.
 *
 * Node joins repeated non-special headers with `", "`, so a duplicated header
 * arrives as one comma-containing string; Express may also hand back an array.
 * Neither is a token, and neither may be accepted by taking the first value — a
 * request that can carry two tokens is a request whose intent is unclear.
 */
export function readCsrfHeader(header: string | string[] | undefined): string | null {
  if (typeof header !== "string") return null;
  if (header.includes(",")) return null;
  return header.length > 0 ? header : null;
}
