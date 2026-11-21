import type {
  CsrfTokenResponse,
  Envelope,
  LoginRequest,
  RegisterRequest,
  RegisteredUser,
} from "@agroclimate/contracts";
import { loginRequestSchema, registerRequestSchema } from "@agroclimate/contracts";
import {
  Body,
  ConflictException,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { PrismaClient } from "@agroclimate/database";
import { EmailAlreadyRegisteredError, insertRegisteredUser } from "@agroclimate/database";
import type { Response } from "express";

import { AUTH_DATABASE_CLIENT, PASSWORD_HASHER } from "../tokens.js";
import type { AuthenticatedRequest } from "./auth.guard.js";
import { AuthGuard, unauthenticated } from "./auth.guard.js";
import { AuthService } from "./auth.service.js";
import type { PasswordHasher } from "./password-hasher.js";
import { AuthRateLimitGuard } from "./rate-limit.guard.js";
import { clearSessionCookie, readSessionToken, setSessionCookie } from "./session-cookie.js";
import { isWellFormedSessionToken } from "./session-token.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";

/**
 * The authentication surface. Everything here runs before a tenant context exists,
 * so it never calls `withTenant` and never sets `app.user_id`; the credential
 * boundary is `AUTH_DATABASE_CLIENT` (`app_auth`), not the tenant pool.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AUTH_DATABASE_CLIENT) private readonly client: PrismaClient,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
    private readonly auth: AuthService,
  ) {}

  /**
   * Registration (S7). Order is a security property:
   *
   * 1. `AuthRateLimitGuard` runs before the handler, so a refused request costs
   *    neither an Argon2id run nor a query.
   * 2. The password is hashed before the insert. A prior existence check would let
   *    response timing reveal whether an address is registered; hashing first makes
   *    a duplicate take as long as a fresh registration, and the database
   *    constraint decides the conflict (`IG-2`).
   * 3. Only then does the insert happen, and the email constraint's violation
   *    becomes `409 CONFLICT`.
   *
   * It issues no session, cookie, or token (`IG-3`).
   */
  @Post("register")
  @HttpCode(201)
  @UseGuards(AuthRateLimitGuard)
  async register(
    @Body(new ZodValidationPipe(registerRequestSchema)) body: RegisterRequest,
  ): Promise<Envelope<RegisteredUser>> {
    const passwordHash = await this.hasher.hashPassword(body.password);

    try {
      const user = await insertRegisteredUser(this.client, body.email, passwordHash);
      return { data: user };
    } catch (error) {
      if (error instanceof EmailAlreadyRegisteredError) {
        // No `details`: `IG-2` accepts that existence is disclosed by the status,
        // and elaborating would disclose more.
        throw new ConflictException({ code: "CONFLICT" });
      }
      throw error;
    }
  }

  /**
   * Login (S8).
   *
   * The rate limiter is the same instance registration uses, so the approved
   * 30 requests per minute is one quota per client IP across the auth endpoints
   * rather than one per route.
   *
   * `200`, not `201`: login authenticates, it does not create an addressable
   * resource. The token appears only in the `Set-Cookie` header.
   */
  @Post("login")
  @HttpCode(200)
  @UseGuards(AuthRateLimitGuard)
  async login(
    @Body(new ZodValidationPipe(loginRequestSchema)) body: LoginRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Envelope<RegisteredUser>> {
    const result = await this.auth.login(body.email, body.password);
    if (result === null) throw unauthenticated();

    setSessionCookie(response, result.token, result.expiresAt);
    return { data: result.user };
  }

  /** The current subject, from the session the guard validated. */
  @Get("me")
  @UseGuards(AuthGuard)
  me(@Req() request: AuthenticatedRequest): Envelope<RegisteredUser> {
    const context = request.auth;
    // The guard either attached a subject or refused; this is a wiring assertion,
    // not a second authentication check.
    if (context === undefined) throw unauthenticated();
    return { data: context.user };
  }

  /**
   * The CSRF synchronizer token for this session (`ADR-006` §D2.1, `Amendment 4`).
   *
   * Generated on first retrieval and never rotated, so a second tab or a reload gets
   * the same value. `no-store` because the value is session-scoped: a shared cache
   * that kept it would hand one session's token to another.
   *
   * This is the **only** response that carries the token. It is not in `/me`, login,
   * registration, an error body, or a log line.
   *
   * `null` from the service means the session became unusable between the guard's
   * statement and this read; the same `401` the guard would have answered is the
   * only honest reply.
   */
  @Get("csrf")
  @UseGuards(AuthGuard)
  async csrf(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Envelope<CsrfTokenResponse>> {
    const context = request.auth;
    if (context === undefined) throw unauthenticated();

    const token = await this.auth.issueCsrfToken(context.sessionId);
    if (token === null) throw unauthenticated();

    response.setHeader("Cache-Control", "no-store");
    return { data: { token } };
  }

  /**
   * Logout (S8). Idempotent by design, and the four cases are deliberately one
   * outcome:
   *
   * | Presented cookie | Result |
   * |---|---|
   * | absent | `204`, nothing revoked |
   * | malformed | `204`, nothing revoked |
   * | valid and active | `revoked_at` set, `204` |
   * | already revoked or expired | `204`, nothing changed |
   *
   * `204` every time, because "this session is not usable now" is the postcondition
   * the caller asked for. A `401` would make a retried logout after a lost response
   * look like a client bug.
   *
   * The row is revoked, never deleted: no runtime role holds `DELETE`, and the row
   * is the evidence that the session existed. The cookie is cleared with the same
   * attributes it was set with, and only after the database answered — a claimed
   * revocation that did not happen must not look successful.
   */
  @Post("logout")
  @HttpCode(204)
  async logout(
    @Req() request: AuthenticatedRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = readSessionToken(request.cookies);
    if (token !== null && isWellFormedSessionToken(token)) {
      await this.auth.logout(token);
    }

    clearSessionCookie(response);
  }
}
