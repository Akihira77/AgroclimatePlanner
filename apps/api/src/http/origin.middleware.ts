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

export function originValidation(
  options: OriginValidationOptions,
): (request: Request, response: Response, next: NextFunction) => void {
  const trusted = new Set(options.trustedOrigins);

  return (request, response, next) => {
    if (!STATE_CHANGING_METHODS.has(request.method)) return next();

    const origin = request.get("Origin");
    if (origin !== undefined && trusted.has(origin)) return next();

    const api: ApiRequest = request;
    response.status(403).json(errorResponseBody("FORBIDDEN", requestIdOf(api.requestId)));
  };
}
