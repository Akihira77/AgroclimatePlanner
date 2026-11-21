import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CSRF_TOKEN_PATTERN } from "@agroclimate/contracts";

import {
  CSRF_TOKEN_BYTES,
  createCsrfToken,
  csrfTokensMatch,
  isWellFormedCsrfToken,
  readCsrfHeader,
} from "../dist/auth/csrf-token.js";

/**
 * The token's value and its shape rule, without a server or a database.
 *
 * A token that is not 32 bytes of CSPRNG output is not a token, and a comparison
 * that is not constant-time is not the approved comparison; those two facts are the
 * whole point of this file.
 */

const BASE64URL = /^[A-Za-z0-9_-]+$/;

describe("token generation", () => {
  it("is 32 CSPRNG bytes as 43 unpadded base64url characters", () => {
    for (let index = 0; index < 200; index += 1) {
      const token = createCsrfToken();
      assert.equal(token.length, 43, token);
      assert.match(token, CSRF_TOKEN_PATTERN);
      assert.match(token, BASE64URL);
      assert.equal(token.includes("="), false, "unpadded");
      assert.equal(Buffer.from(token, "base64url").length, CSRF_TOKEN_BYTES);
    }
  });

  it("does not repeat across a large sample", () => {
    const tokens = new Set(Array.from({ length: 2_000 }, () => createCsrfToken()));
    assert.equal(tokens.size, 2_000);
  });
});

describe("strict shape validation", () => {
  it("accepts a generated token", () => {
    assert.equal(isWellFormedCsrfToken(createCsrfToken()), true);
  });

  it("rejects absent, non-string, empty, and wrong-length values", () => {
    for (const value of [undefined, null, 0, {}, "", "A".repeat(42), "A".repeat(44)]) {
      assert.equal(isWellFormedCsrfToken(value), false, String(value));
    }
  });

  it("rejects the standard base64 alphabet and padding", () => {
    for (const value of ["A".repeat(42) + "=", "A".repeat(42) + "+", "A".repeat(42) + "/"]) {
      assert.equal(isWellFormedCsrfToken(value), false, value);
    }
  });

  it("rejects a 43-character value that is not a canonical 32-byte encoding", () => {
    // 32 bytes is 256 bits, but 43 base64 characters carry 258: the final
    // character's low two bits are not part of the value. `B` (index 1) sets one of
    // them, so it decodes to 32 bytes and re-encodes as `A` — the regex accepts it
    // and only the canonical round-trip rejects it.
    const nonCanonical = "A".repeat(42) + "B";
    assert.match(nonCanonical, CSRF_TOKEN_PATTERN, "the regex alone would accept this");
    assert.equal(Buffer.from(nonCanonical, "base64url").length, 32);
    assert.equal(isWellFormedCsrfToken(nonCanonical), false);
  });

  it("rejects a duplicate value that Node joined into one header", () => {
    const token = createCsrfToken();
    assert.equal(isWellFormedCsrfToken(`${token}, ${token}`), false);
  });
});

describe("constant-time comparison", () => {
  it("matches equal tokens", () => {
    const token = createCsrfToken();
    assert.equal(csrfTokensMatch(token, token), true);
  });

  it("refuses different tokens and a missing stored value", () => {
    const first = createCsrfToken();
    let second = createCsrfToken();
    while (second === first) second = createCsrfToken();

    assert.equal(csrfTokensMatch(first, second), false);
    assert.equal(csrfTokensMatch(first, null), false);
    assert.equal(csrfTokensMatch(null, first), false);
    assert.equal(csrfTokensMatch(undefined, undefined), false);
  });

  it("refuses unequal lengths instead of throwing, because shape is checked first", () => {
    const token = createCsrfToken();
    assert.equal(csrfTokensMatch(token, token.slice(0, 42)), false);
    assert.equal(csrfTokensMatch("A".repeat(44), token), false);
  });
});

describe("header reading", () => {
  it("returns a single value unchanged", () => {
    const token = createCsrfToken();
    assert.equal(readCsrfHeader(token), token);
  });

  it("treats duplicate, joined, empty, and absent headers as absent", () => {
    const token = createCsrfToken();
    assert.equal(readCsrfHeader([token, token]), null, "array");
    assert.equal(readCsrfHeader(`${token},${token}`), null, "joined");
    assert.equal(readCsrfHeader(""), null);
    assert.equal(readCsrfHeader(undefined), null);
  });
});
