import { HttpException, Injectable } from "@nestjs/common";

import type { ApiRequest } from "../http/request-id.middleware.js";
import { AuthService } from "./auth.service.js";
import {
  CSRF_HEADER,
  csrfTokensMatch,
  isWellFormedCsrfToken,
  readCsrfHeader,
} from "./csrf-token.js";

/**
 * Synchronizer-token validation, run from `AuthGuard` after the session is known.
 *
 * It lives in the guard rather than in per-route metadata on purpose. A
 * `@UseGuards(AuthGuard, CsrfValidator)` on each mutation route fails open the day
 * someone adds a route and forgets the second guard; deriving the requirement from
 * the HTTP method inside the guard that already authenticates makes "authenticated
 * mutation" and "CSRF-checked mutation" the same set, permanently.
 *
 * That also produces the exemptions without a list: `register`, `login`, and
 * `logout` are not behind `AuthGuard` at all, so no metadata can accidentally
 * exempt something else, and no future route can accidentally opt out. They stay
 * covered by `Origin` validation, which runs before body parsing and is independent
 * of this check.
 */

/** `ADR-006` D2.1.5. `GET`/`HEAD`/`OPTIONS` are not state-changing. */
export const CSRF_PROTECTED_METHODS: ReadonlySet<string> = new Set([
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
]);

@Injectable()
export class CsrfValidator {
  constructor(private readonly auth: AuthService) {}

  /**
   * Every failure is the same `403 FORBIDDEN` with the standard envelope: absent,
   * empty, duplicated, malformed, wrong length, mismatched, or a session with no
   * token issued. A caller must not be able to tell a wrong token from a missing
   * one, and must not be told whether the session token or this token was the
   * component that failed.
   *
   * Operational failures are **not** caught here. A database error is a `503` via
   * `AuthService.withDatabaseErrors`, never a `403`: telling a client its
   * credentials were rejected because the server was down is a lie it will act on.
   */
  async assertValid(request: ApiRequest, sessionId: string): Promise<void> {
    const presented = readCsrfHeader(request.headers[CSRF_HEADER]);
    if (presented === null || !isWellFormedCsrfToken(presented)) throw csrfForbidden();

    const stored = await this.auth.storedCsrfToken(sessionId);
    if (!csrfTokensMatch(presented, stored)) throw csrfForbidden();
  }
}

export function csrfForbidden(): HttpException {
  return new HttpException({ code: "FORBIDDEN" }, 403);
}
