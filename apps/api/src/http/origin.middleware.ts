import type { NextFunction, Request, Response } from "express";

import { errorResponseBody, requestIdOf } from "./api-error.js";
import type { ApiRequest } from "./request-id.middleware.js";

/**
 * Exact `Origin` validation for state-changing requests (`ADR-006` D2.2).
 *
 * This is a plain Express middleware, not a Nest guard, and the placement is the
 * requirement: it must run before the body parser, so a forged `POST` is refused
 * without spending work on parsing, hashing, or a query. A guard runs after parsing
 * by construction — by then the body has already been read and decoded.
 *
 * Rules, all of them exact string comparisons:
 *
 * - `POST`, `PUT`, `PATCH`, `DELETE` require a trusted `Origin`.
 * - A missing header is refused. Browsers send it on state-changing requests; a
 *   non-browser client has no support in v1, and treating absence as trust is how
 *   a `401`-only check becomes bypassable.
 * - An unlisted origin is refused.
 * - `Origin: null` is refused because it is a string, not an origin, and it can
 *   never be configured: `CORS_ORIGINS` rejects any entry whose `URL.origin` is not
 *   the entry itself, and `new URL("null")` throws.
 * - No wildcard, suffix, or prefix matching. A `Set` lookup is an equality test;
 *   nothing here normalises case, slashes, or ports.
 *
 * `GET`, `HEAD`, and `OPTIONS` pass through. `OPTIONS` is the preflight, which the
 * CORS layer answers; refusing it would break the browser's credentialed request
 * before the real one was ever sent.
 *
 * The response is the established envelope, not an Express default: this runs
 * before Nest's routers, so it writes the body itself through the same builder the
 * exception filter uses.
 */

const STATE_CHANGING_METHODS: ReadonlySet<string> = new Set(["POST", "PUT", "PATCH", "DELETE"]);

export interface OriginValidationOptions {
  /** The existing `CORS_ORIGINS` list. One allowlist, never a second variable. */
  readonly trustedOrigins: readonly string[];
}

/**
 * Refusals are logged once per distinct origin, up to a cap. The line is the only
 * thing that says *which* origin was refused — the response body cannot, because it
 * would hand the allowlist to whoever asked. But the caller chooses the origin, so an
 * uncapped line is a log flood a scanner can drive: one line per origin, twenty
 * origins, then silence for the rest of the process's life.
 */
const MAX_LOGGED_ORIGINS = 20;

/** Terminal escapes and control bytes from a header have no business in a log line. */
function printable(value: string): string {
  return [...value.slice(0, 200)]
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      return code < 0x20 || code === 0x7f ? "?" : char;
    })
    .join("");
}

export function originValidation(
  options: OriginValidationOptions,
): (request: Request, response: Response, next: NextFunction) => void {
  const trusted = new Set(options.trustedOrigins);
  const logged = new Set<string>();

  return (request, response, next) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return next();

    const origin = request.get("Origin");
    if (origin !== undefined && trusted.has(origin)) return next();

    const api: ApiRequest = request;
    const requestId = requestIdOf(api.requestId);

    // A dev server moved with `WEB_PORT` leaves the API refusing a port it was never
    // told about, and "Tidak diizinkan." points nowhere. This line and the response
    // share a requestId, so an operator can join them.
    const key = origin ?? "(absent)";
    if (!logged.has(key) && logged.size < MAX_LOGGED_ORIGINS) {
      logged.add(key);
      console.warn(
        `[api] refused ${request.method} ${printable(request.path)} from Origin ` +
          `${printable(key)} (requestId ${requestId}); ` +
          `CORS_ORIGINS lists ${options.trustedOrigins.join(", ") || "(nothing)"}`,
      );
    }

    response.status(403).json(errorResponseBody("FORBIDDEN", requestId));
  };
}
