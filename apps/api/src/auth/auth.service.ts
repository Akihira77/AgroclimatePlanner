import { randomBytes } from "node:crypto";

import { Inject, Injectable, ServiceUnavailableException } from "@nestjs/common";
import type { PrismaClient } from "@agroclimate/database";
import {
  findAuthUserByEmail,
  insertSession,
  readSessionCsrfToken,
  resolveSession,
  resolveSessionCsrfToken,
  revokeSession,
} from "@agroclimate/database";

import { AUTH_DATABASE_CLIENT, PASSWORD_HASHER } from "../tokens.js";
import { MalformedPasswordHashError } from "./password-hasher.js";
import type { PasswordHasher } from "./password-hasher.js";
import { createCsrfToken } from "./csrf-token.js";
import { createSessionToken, hashSessionToken } from "./session-token.js";

/**
 * Login, session validation, and logout — the authentication track's application
 * layer (`ADR-004`, `ADR-005`, `ADR-006`).
 *
 * Two invariants are enforced here rather than trusted to callers:
 *
 * - **Uniform failure.** An unknown address, a wrong password, and an unreadable
 *   stored hash produce the same `null`, the same `401`, and the same work. The
 *   dummy verification is what makes the cost comparable; without it, "no such
 *   user" would return before Argon2id ran and the timing would be the oracle the
 *   response body refuses to be.
 * - **Secrets stay in.** `passwordHash` is never copied into a result type, and the
 *   raw token is returned only so the controller can place it in a cookie. Neither
 *   is ever logged.
 */

/** The safe user representation. No hash, no timestamps, no session identity. */
export interface AuthenticatedUser {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly locale: string;
  readonly timezone: string;
}

export interface LoginResult {
  readonly user: AuthenticatedUser;
  /** Raw bearer token. Returned for the cookie only; never serialised. */
  readonly token: string;
  readonly expiresAt: Date;
}

export interface SessionCheck {
  readonly user: AuthenticatedUser;
  readonly sessionId: string;
  /** The deadline the cookie should carry — extended only if the row was. */
  readonly expiresAt: Date;
}

@Injectable()
export class AuthService {
  /**
   * The dummy hash is computed once per process from the configured cost, then
   * reused. Computing it per failed login would add a hash to every failure; a
   * hard-coded PHC string would bake in the provisional parameters and drift from
   * configuration the moment they change.
   *
   * The promise is memoised, so concurrent first failures share one computation
   * instead of racing to produce several. A failed computation clears the memo
   * rather than caching a rejection forever.
   */
  private dummyHash: Promise<string> | undefined;

  constructor(
    @Inject(AUTH_DATABASE_CLIENT) private readonly client: PrismaClient,
    @Inject(PASSWORD_HASHER) private readonly hasher: PasswordHasher,
  ) {}

  /** `null` for every credential failure. Never distinguishes which one. */
  async login(email: string, password: string): Promise<LoginResult | null> {
    return this.withDatabaseErrors(async () => {
      const record = await findAuthUserByEmail(this.client, email);
      const verified = await this.verify(record?.passwordHash ?? null, password);
      if (record === null || !verified) return null;

      // Generated only after the password matched, so a failed login creates no
      // session row and no token that could be confused with a real one.
      const token = createSessionToken();
      const session = await insertSession(this.client, record.id, hashSessionToken(token));

      return {
        user: {
          id: record.id,
          email: record.email,
          role: record.role,
          locale: record.locale,
          timezone: record.timezone,
        },
        token,
        expiresAt: session.expiresAt,
      };
    });
  }

  /**
   * Resolves a presented token to a subject, extending the sliding deadline when
   * the five-minute throttle allows it.
   *
   * Validation and extension are **one statement** (`resolveSession`), so a logout
   * or expiry that races this call cannot be mistaken for a throttled extension.
   * The old two-call shape returned `null` from the extension in both cases, and
   * the caller fell back to the deadline it had read before the revocation — a
   * request could authenticate on a session that was already dead.
   *
   * Every non-active outcome is the same `null`: missing row, revoked, sliding
   * expiry, absolute expiry. `expiresAt` is whichever deadline the database holds
   * *after* the statement — extended or unchanged — so the cookie never publishes a
   * deadline the row does not have.
   */
  async authenticate(token: string): Promise<SessionCheck | null> {
    return this.withDatabaseErrors(async () => {
      const resolution = await resolveSession(this.client, hashSessionToken(token));
      if (resolution.outcome !== "active") return null;

      const { session } = resolution;
      return {
        sessionId: session.sessionId,
        expiresAt: session.expiresAt,
        user: {
          id: session.userId,
          email: session.email,
          role: session.role,
          locale: session.locale,
          timezone: session.timezone,
        },
      };
    });
  }

  /**
   * The CSRF token for this session, minted on the first retrieval.
   *
   * `null` means the session is no longer usable — revoked, expired, or gone
   * between the guard's statement and this one. The controller answers that with the
   * same `401` the guard would have given, so the caller learns nothing new.
   *
   * Nothing here logs the value: it is a secret in transit, and a length is the most
   * that may appear in a diagnostic.
   */
  async issueCsrfToken(sessionId: string): Promise<string | null> {
    return this.withDatabaseErrors(() =>
      resolveSessionCsrfToken(this.client, sessionId, createCsrfToken),
    );
  }

  /**
   * The token already stored for this session, for comparison against a header.
   *
   * A read, not a mint: validation must never create a token, or a request that
   * never fetched one would be authenticated by the act of being checked.
   */
  async storedCsrfToken(sessionId: string): Promise<string | null> {
    return this.withDatabaseErrors(() => readSessionCsrfToken(this.client, sessionId));
  }

  /**
   * Revokes if the token names an active session. Unknown, malformed, already
   * revoked, and expired all end the same way: nothing to revoke, no error.
   */
  async logout(token: string): Promise<void> {
    await this.withDatabaseErrors(() => revokeSession(this.client, hashSessionToken(token)));
  }

  private async verify(storedHash: string | null, password: string): Promise<boolean> {
    if (storedHash === null) {
      await this.dummyVerify(password);
      return false;
    }

    try {
      return await this.hasher.verifyPassword(storedHash, password);
    } catch (error) {
      if (!(error instanceof MalformedPasswordHashError)) throw error;

      // An unreadable stored hash is a credential failure for the caller, but the
      // account's existence must still not be observable, so the same work is
      // performed before answering.
      await this.dummyVerify(password);
      return false;
    }
  }

  /**
   * Verifies against a hash of a value nobody knows. The result is discarded: this
   * exists to spend the same time and memory as a real verification, not to
   * authenticate anything.
   *
   * A failure here propagates. Swallowing it would turn a native or resource fault
   * into a silent `401`, which is the one thing the classification exists to stop.
   */
  private async dummyVerify(password: string): Promise<void> {
    await this.hasher.verifyPassword(await this.dummyHashValue(), password);
  }

  private dummyHashValue(): Promise<string> {
    if (this.dummyHash === undefined) {
      this.dummyHash = this.hasher
        .hashPassword(randomBytes(32).toString("base64url"))
        .catch((error: unknown) => {
          this.dummyHash = undefined;
          throw error;
        });
    }
    return this.dummyHash;
  }

  /**
   * An unreachable session store is `503`, never an anonymous request and never a
   * generic `500` that a client might retry as if it were a bug. `ADR-005` names
   * the distinction; the code set already carries `DEPENDENCY_UNAVAILABLE`.
   */
  private async withDatabaseErrors<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (!isDatabaseUnavailable(error)) throw error;
      throw new ServiceUnavailableException({ code: "DEPENDENCY_UNAVAILABLE" });
    }
  }
}

const UNAVAILABLE_PRISMA = new Set(["P1000", "P1001", "P1002", "P1008", "P1010", "P1017"]);
const UNAVAILABLE_NETWORK = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EPIPE",
  "ENOTFOUND",
]);
const UNAVAILABLE_POSTGRES = new Set(["57P01", "57P02", "57P03", "08000", "08003", "08006"]);

/**
 * Walks the wrapper chain for a code that means "the store is not answering".
 * Deliberately narrow: an unrecognised error must keep propagating as an internal
 * error, or a real bug would be reported as a retryable outage.
 */
export function isDatabaseUnavailable(error: unknown, depth = 0): boolean {
  if (depth > 5 || typeof error !== "object" || error === null) return false;

  const record = error as Record<string, unknown>;
  for (const key of ["code", "originalCode", "sqlState"] as const) {
    const value = record[key];
    if (typeof value !== "string") continue;
    if (
      UNAVAILABLE_PRISMA.has(value) ||
      UNAVAILABLE_NETWORK.has(value) ||
      UNAVAILABLE_POSTGRES.has(value)
    ) {
      return true;
    }
  }

  return isDatabaseUnavailable(record["cause"], depth + 1);
}
