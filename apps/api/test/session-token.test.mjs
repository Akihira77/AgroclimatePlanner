import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";

import {
  createSessionToken,
  hashSessionToken,
  isWellFormedSessionToken,
  SESSION_TOKEN_LENGTH,
} from "../dist/auth/session-token.js";

describe("session tokens", () => {
  it("are 43 base64url characters", () => {
    for (let index = 0; index < 100; index += 1) {
      const token = createSessionToken();
      assert.equal(token.length, SESSION_TOKEN_LENGTH);
      assert.match(token, /^[A-Za-z0-9_-]+$/);
      assert.equal(isWellFormedSessionToken(token), true);
    }
  });

  it("are unique", () => {
    const tokens = new Set(Array.from({ length: 1_000 }, () => createSessionToken()));
    assert.equal(tokens.size, 1_000);
  });

  it("hash to 64 lowercase hex characters, matching node's sha256", () => {
    const token = createSessionToken();
    const digest = hashSessionToken(token);

    assert.equal(digest.length, 64);
    assert.match(digest, /^[0-9a-f]{64}$/);
    assert.equal(digest, createHash("sha256").update(token, "utf8").digest("hex"));
  });

  it("reject anything that is not a token before it can become a query key", () => {
    const rejected = [
      "",
      "short",
      "A".repeat(42),
      "A".repeat(44),
      `${"A".repeat(42)}=`,
      `${"A".repeat(42)}+`,
      `${"A".repeat(42)}/`,
      `${"A".repeat(42)}.`,
      null,
      undefined,
      42,
      { token: "A".repeat(43) },
    ];

    for (const value of rejected) assert.equal(isWellFormedSessionToken(value), false);
  });
});
