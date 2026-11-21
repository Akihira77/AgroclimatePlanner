import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { HttpException, Injectable } from "@nestjs/common";
import type { Response } from "express";

import type { ApiRequest } from "../http/request-id.middleware.js";
import type { AuthenticatedUser } from "./auth.service.js";
import { AuthService } from "./auth.service.js";
import { CSRF_PROTECTED_METHODS, CsrfValidator } from "./csrf-validator.js";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "./session-cookie.js";
import { isWellFormedSessionToken } from "./session-token.js";

/**
 * The authenticated subject, derived from a validated database session and nothing
 * else. It is attached to the request after the lookup, so a handler can rely on it
 * without re-reading a cookie — and cannot receive it from a body, a query
 * parameter, or a client-supplied id.
 */
export interface AuthenticatedContext {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
}

export type AuthenticatedRequest = ApiRequest & { auth?: AuthenticatedContext };

/**
 * Guards protected routes.
 *
 * Order inside `canActivate` matters: the token's *shape* is checked before the
 * query, so a value that cannot be a token never becomes a lookup key. Revocation
 * and both expiry deadlines are checked by the query predicate, not here — a guard
 * that re-implemented them could disagree with the statement that owns them.
 *
 * Missing, malformed, unknown, expired, and revoked sessions are one answer:
 * `401 UNAUTHENTICATED`. The distinctions are useful in an operator's log and
 * dangerous in a response; none of them is a client's business.
 *
 * **CSRF is enforced here, not by route metadata.** Once the subject exists, a
 * `POST`/`PUT`/`PATCH`/`DELETE` must also present a valid synchronizer token. Any
 * authenticated mutation route gets that for free, and there is no per-route
 * annotation that can be forgotten — a route that uses this guard is protected,
 * and a route that does not use it is not authenticated either. `register`,
 * `login`, and `logout` are exempt because they never reach this guard; `Origin`
 * validation still covers them.
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(
    private readonly auth: AuthService,
    private readonly csrf: CsrfValidator,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const http = context.switchToHttp();
    const request = http.getRequest<AuthenticatedRequest>();
    const response = http.getResponse<Response>();

    const token = readSessionToken(request.cookies);
    if (token === null || !isWellFormedSessionToken(token)) throw unauthenticated();

    const session = await this.auth.authenticate(token);
    if (session === null) {
      // An unusable cookie is removed rather than left to be re-presented: the
      // browser should not keep sending a credential that cannot work.
      clearSessionCookie(response);
      throw unauthenticated();
    }

    request.auth = { user: session.user, sessionId: session.sessionId };

    // After authentication, before the handler. A `403` here means the session is
    // valid and the request is not authorised — re-authenticating would not help,
    // which is why it is not a `401`.
    if (CSRF_PROTECTED_METHODS.has(request.method.toUpperCase())) {
      await this.csrf.assertValid(request, session.sessionId);
    }

    // The deadline comes from the row, already clamped to the absolute deadline by
    // the extension statement. It is never computed here, so the cookie cannot
    // outlive the session it names.
    setSessionCookie(response, token, session.expiresAt);
    return true;
  }
}

export function unauthenticated(): HttpException {
  return new HttpException({ code: "UNAUTHENTICATED" }, 401);
}
