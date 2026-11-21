import { hash, verify } from "@node-rs/argon2";
import type { Algorithm } from "@node-rs/argon2";
import { randomBytes } from "node:crypto";

import type { PasswordHashingConfig } from "../config/runtime-config.js";

/**
 * Argon2id password hashing (`IG-6`).
 *
 * The algorithm, salt length, output length, and PHC encoding are fixed here;
 * only the cost parameters come from configuration. Two reasons for that split:
 *
 * - `IG-6` approves Argon2id, a 16-byte salt, and a 32-byte output as decisions,
 *   not as tunables. Making them configurable would let a deployment quietly
 *   select something the owner never approved.
 * - The cost numbers are explicitly provisional. A benchmark changes them by
 *   changing configuration, and no code is edited to promote them.
 *
 * Every call generates a fresh salt: reusing one would make identical passwords
 * produce identical hashes.
 */

export const ARGON2_SALT_BYTES = 16;
export const ARGON2_OUTPUT_BYTES = 32;

/**
 * `Algorithm.Argon2id`. The library declares its enums ambient and `const`, which
 * `isolatedModules` forbids importing as values; the numeric member is stable
 * because it is part of the PHC format, and the type import keeps it checked.
 */
const ARGON2ID = 2 as Algorithm;

/**
 * Every hash this project writes matches this shape: Argon2id, version 19, the
 * three cost fields, a 22-character base64 salt (16 bytes) and a 43-character
 * base64 digest (32 bytes), no padding.
 *
 * It is a *shape* check, not a validity check — proving a PHC string is
 * cryptographically well-formed is the library's job. Its purpose is to separate
 * two outcomes that `@node-rs/argon2` reports with the same exception class: a
 * stored value that is not a hash at all (a truncated column, a NULL coerced to
 * text, a plaintext pasted into the wrong field) and a native failure while
 * verifying a real hash.
 */
const WELL_FORMED_HASH =
  /^\$argon2id\$v=19\$m=\d{1,7},t=\d{1,3},p=\d{1,3}\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/;

/**
 * A stored value that cannot be verified, as distinct from a wrong password.
 *
 * It is thrown rather than returned so the caller cannot accidentally treat it as
 * "no match" without deciding what to do. The authentication service turns it into
 * the same public failure as a wrong password *after* performing the dummy
 * verification, which keeps the response and its cost uniform.
 */
export class MalformedPasswordHashError extends Error {
  override readonly name = "MalformedPasswordHashError";
}

export function isWellFormedPasswordHash(value: string): boolean {
  return WELL_FORMED_HASH.test(value);
}

export interface PasswordHasher {
  hashPassword(password: string): Promise<string>;
  /**
   * `true` for a match, `false` for a mismatch.
   *
   * Throws `MalformedPasswordHashError` when the stored value is not a hash, and
   * lets any other failure propagate: a native-library or resource failure must
   * surface as an internal error, not as "wrong password". The previous version
   * swallowed everything, which would have turned an operational fault into a
   * silent `401` for every user at once — a failure that looks like a working
   * login form rejecting correct credentials.
   */
  verifyPassword(passwordHash: string, password: string): Promise<boolean>;
}

export function createPasswordHasher(config: PasswordHashingConfig): PasswordHasher {
  return {
    async hashPassword(password: string): Promise<string> {
      return hash(password, {
        algorithm: ARGON2ID,
        memoryCost: config.memoryCostKib,
        timeCost: config.timeCost,
        parallelism: config.parallelism,
        outputLen: ARGON2_OUTPUT_BYTES,
        salt: randomBytes(ARGON2_SALT_BYTES),
      });
    },

    /**
     * Verification reads the parameters from the stored PHC string, which is the
     * property that makes a future cost increase safe: old hashes keep verifying
     * under the parameters they were created with.
     */
    async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
      if (!isWellFormedPasswordHash(passwordHash)) throw new MalformedPasswordHashError();
      return verify(passwordHash, password);
    },
  };
}
