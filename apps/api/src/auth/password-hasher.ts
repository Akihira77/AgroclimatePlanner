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

export interface PasswordHasher {
  hashPassword(password: string): Promise<string>;
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
     * property that makes a future cost increase safe: old hashes keep verifying.
     *
     * A malformed hash returns `false` rather than throwing. The alternative leaks
     * a distinction between "no such hash" and "wrong password" into the caller's
     * control flow, and S8's uniform-failure rule is easier to keep when the
     * primitive itself has one failure value.
     */
    async verifyPassword(passwordHash: string, password: string): Promise<boolean> {
      try {
        return await verify(passwordHash, password);
      } catch {
        return false;
      }
    },
  };
}
