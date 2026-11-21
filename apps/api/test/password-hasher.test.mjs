import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { describe, it } from "node:test";

import { parseOptions } from "@node-rs/argon2";

import {
  createPasswordHasher,
  isWellFormedPasswordHash,
  MalformedPasswordHashError,
} from "../dist/auth/password-hasher.js";
import { parseRuntimeConfig } from "../dist/config/runtime-config.js";

/**
 * The real library, with the cheapest parameters that still exercise the PHC
 * format: these assertions are about shape and verification, and the cost
 * parameters are the benchmark's subject, not this file's.
 */
const FAST = { memoryCostKib: 8, timeCost: 1, parallelism: 1 };

describe("password hashing", () => {
  const hasher = createPasswordHasher(FAST);

  it("produces an Argon2id PHC string, never the plaintext", async () => {
    const password = "correct horse battery staple";
    const digest = await hasher.hashPassword(password);

    assert.match(digest, /^\$argon2id\$v=19\$/);
    assert.equal(digest.includes(password), false);
    assert.notEqual(digest, password);
  });

  it("uses a 16-byte salt and a 32-byte output", async () => {
    const digest = await hasher.hashPassword("correct horse battery staple");
    const parsed = parseOptions(digest);

    assert.equal(parsed.saltLen, 16);
    assert.equal(parsed.outputLen, 32);
    assert.equal(parsed.memoryCost, FAST.memoryCostKib);
    assert.equal(parsed.timeCost, FAST.timeCost);
    assert.equal(parsed.parallelism, FAST.parallelism);
  });

  it("salts every hash, so the same password hashes differently", async () => {
    const first = await hasher.hashPassword("correct horse battery staple");
    const second = await hasher.hashPassword("correct horse battery staple");
    assert.notEqual(first, second);
  });

  it("verifies the right password and rejects the wrong one", async () => {
    const digest = await hasher.hashPassword("correct horse battery staple");
    assert.equal(await hasher.verifyPassword(digest, "correct horse battery staple"), true);
    assert.equal(await hasher.verifyPassword(digest, "correct horse battery stapl"), false);
  });

  it("verifies a hash whose parameters differ from the configured ones", async () => {
    // The property that makes a cost increase safe: verify() reads m/t/p from the
    // stored string rather than from configuration.
    const expensive = createPasswordHasher({ memoryCostKib: 16, timeCost: 2, parallelism: 1 });
    const digest = await expensive.hashPassword("correct horse battery staple");
    assert.equal(await hasher.verifyPassword(digest, "correct horse battery staple"), true);
  });

  it("throws a classified error when the stored value is not a hash", async () => {
    // Distinct from a wrong password: the authentication service turns this into
    // the same public failure only after doing the dummy work, and an unexpected
    // native failure must stay distinguishable from both.
    for (const malformed of [
      "",
      "not-a-phc-string",
      "plaintextpassword",
      "$argon2i$v=19$m=8,t=1,p=1$c2hvcnQ$c2hvcnQ",
      "$argon2id$v=19$m=8,t=1,p=1$c2hvcnQ$c2hvcnQ",
      "a".repeat(96),
    ]) {
      await assert.rejects(
        () => hasher.verifyPassword(malformed, "whatever"),
        MalformedPasswordHashError,
        `expected a classification for ${JSON.stringify(malformed)}`,
      );
      assert.equal(isWellFormedPasswordHash(malformed), false);
    }
  });

  it("recognises the hashes it writes", async () => {
    const digest = await hasher.hashPassword("correct horse battery staple");
    assert.equal(isWellFormedPasswordHash(digest), true, digest);
  });

  it("does not hash Unicode-normalised or trimmed input", async () => {
    const exact = "  e\u0301\u{1F600}".padEnd(24, "x");
    const digest = await hasher.hashPassword(exact);
    assert.equal(await hasher.verifyPassword(digest, exact), true);
    assert.equal(await hasher.verifyPassword(digest, exact.trim()), false);
  });

  it("does not log or return the password", async () => {
    const password = randomBytes(24).toString("base64");
    const digest = await hasher.hashPassword(password);
    assert.equal(digest.includes(password), false);
    assert.equal(JSON.stringify({ digest }).includes(password), false);
  });
});

describe("password hashing configuration", () => {
  it("falls back to the provisional IG-6 baseline", () => {
    const config = parseRuntimeConfig({ NODE_ENV: "development", APP_API_PASSWORD: "devsecret" });
    assert.deepEqual(config.passwordHashing, { memoryCostKib: 19456, timeCost: 2, parallelism: 1 });
  });

  it("reads the cost from the environment", () => {
    const config = parseRuntimeConfig({
      NODE_ENV: "development",
      APP_API_PASSWORD: "devsecret",
      ARGON2_MEMORY_KIB: "65536",
      ARGON2_TIME_COST: "3",
      ARGON2_PARALLELISM: "4",
    });
    assert.deepEqual(config.passwordHashing, { memoryCostKib: 65536, timeCost: 3, parallelism: 4 });
  });

  it("rejects a malformed cost without echoing the value", () => {
    assert.throws(
      () =>
        parseRuntimeConfig({
          NODE_ENV: "development",
          APP_API_PASSWORD: "devsecret",
          ARGON2_MEMORY_KIB: "lots",
        }),
      /ARGON2_MEMORY_KIB must be an integer/,
    );
  });
});
