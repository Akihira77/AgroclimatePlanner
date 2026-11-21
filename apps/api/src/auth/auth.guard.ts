import type { CanActivate, ExecutionContext } from "@nestjs/common";
import { HttpException, Injectable } from "@nestjs/common";
import type { Response } from "express";

import type { ApiRequest } from "../http/request-id.middleware.js";
import type { AuthenticatedUser } from "./auth.service.js";
import { AuthService } from "./auth.service.js";
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
 */
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(private readonly auth: AuthService) {}

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
