import type { Envelope, RegisterRequest, RegisteredUser } from "@agroclimate/contracts";
import { registerRequestSchema } from "@agroclimate/contracts";
import {
  Body,
  ConflictException,
  Controller,
  HttpCode,
  Inject,
  Post,
  UseGuards,
} from "@nestjs/common";
import type { PrismaClient } from "@agroclimate/database";
import { EmailAlreadyRegisteredError, insertRegisteredUser } from "@agroclimate/database";

import { AUTH_DATABASE_CLIENT, PASSWORD_HASHER } from "../tokens.js";
import type { PasswordHasher } from "./password-hasher.js";
import { AuthRateLimitGuard } from "./rate-limit.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";

/**
 * Registration (S7). It runs before a tenant context exists, so it never calls
 * `withTenant` and never sets `app.user_id`; the credential boundary is
 * `AUTH_DATABASE_CLIENT` (`app_auth`), not the tenant pool.
 *
 * It issues no session, cookie, or token (`IG-3`). Login is the only issuance
 * path, and it arrives with S8.
 */
@Controller("auth")
export class AuthController {
  constructor(
    @Inject(AUTH_DATABASE_CLIENT) private readonly client: PrismaClient,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  /**
   * Order is a security property, not a style choice:
   *
   * 1. `AuthRateLimitGuard` runs before the handler, so a refused request costs
   *    neither an Argon2id run nor a query.
   * 2. The password is hashed before the insert. A prior existence check would
   *    let response timing reveal whether an address is registered; hashing first
   *    makes a duplicate take as long as a fresh registration, and the database
   *    constraint, not a `SELECT`, decides the conflict (`IG-2`).
   * 3. Only then does the insert happen, and a `23505` becomes `409 CONFLICT`.
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
        // No `details`: `IG-2` says the existence disclosure is accepted but not
        // elaborated on, and a client learns nothing more than the status.
        throw new ConflictException({ code: "CONFLICT" });
      }
      throw error;
    }
  }
}
