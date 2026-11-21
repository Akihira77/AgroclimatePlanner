import type { CookieOptions, Response } from "express";

/**
 * The approved session cookie (`IG-8`, `ADR-006` D1).
 *
 * `__Host-` is browser-enforced, not decorative: a cookie with that prefix is
 * accepted only when it is `Secure`, has `Path=/`, and carries no `Domain`. The
 * three strongest mistakes — a cleartext cookie, a cookie scoped to every
 * subdomain, or a cookie set on a path the browser then sends everywhere — become
 * impossible instead of review-dependent.
 *
 * There is no development variant. `Secure` is not dropped for localhost; browsers
 * treat loopback as trustworthy, and the deployment guidance is to use a loopback
 * origin or local TLS. A dev-only relaxation is how the production path ships
 * untested.
 */

export const SESSION_COOKIE_NAME = "__Host-agroclimate_session";

/**
 * `expires` is always the database's sliding deadline, already clamped to the
 * absolute deadline by the `LEAST(...)` in the extension statement. The cookie is
 * therefore never given a later deadline than the row it points at.
 *
 * `domain` is absent by construction, which is what the `__Host-` prefix requires.
 */
const BASE_ATTRIBUTES: CookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "lax",
  path: "/",
};

export function setSessionCookie(response: Response, token: string, expiresAt: Date): void {
  response.cookie(SESSION_COOKIE_NAME, token, { ...BASE_ATTRIBUTES, expires: expiresAt });
}

/**
 * Clears with the same attributes it was set with. A mismatched `Path` or `Secure`
 * leaves the original cookie in place, so "clearing" would be cosmetic.
 */
export function clearSessionCookie(response: Response): void {
  response.clearCookie(SESSION_COOKIE_NAME, { ...BASE_ATTRIBUTES, expires: new Date(0) });
}

/** Reads the raw token from a parsed cookie jar, or `null` when absent. */
export function readSessionToken(
  cookies: Readonly<Record<string, unknown>> | undefined,
): string | null {
  if (cookies === undefined) return null;
  const value = cookies[SESSION_COOKIE_NAME];
  return typeof value === "string" ? value : null;
}
