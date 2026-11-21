import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema, registeredUserSchema } from "@agroclimate/contracts";

import { startApp } from "./helpers.mjs";

/** Cheap Argon2id cost: these tests are about wiring, not parameter selection. */
const FAST_HASHING = { passwordHashing: { memoryCostKib: 8, timeCost: 1, parallelism: 1 } };

const VALID_PASSWORD = "correct horse battery staple";

/** `Origin` is mandatory on state-changing requests (`ADR-006` D2.2). */
const ORIGIN = "http://localhost:5173";

async function register(base, body, headers = {}) {
  return fetch(`${base}/v1/auth/register`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/auth/register", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp({ config: FAST_HASHING }));
  });

  after(async () => {
    await app.close();
  });

  it("creates a user and returns only the safe representation", async () => {
    const response = await register(base, {
      email: "  New.User@Example.com ",
      password: VALID_PASSWORD,
    });

    assert.equal(response.status, 201);
    const body = await response.json();
    assert.deepEqual(Object.keys(body), ["data"]);

    const parsed = registeredUserSchema.safeParse(body.data);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(body.data.email, "new.user@example.com", "email must be normalised");
    assert.equal(body.data.role, "owner");

    const serialised = JSON.stringify(body);
    assert.equal(serialised.includes(VALID_PASSWORD), false);
    assert.equal(serialised.includes("$argon2"), false);
    assert.equal("createdAt" in body.data, false);
    assert.equal("passwordHash" in body.data, false);

    assert.equal(response.headers.get("set-cookie"), null, "registration must not set a cookie");
  });

  it("persists only an Argon2id PHC hash through the auth client", async () => {
    database.state.inserts.length = 0;
    const response = await register(base, {
      email: "hash-check@example.com",
      password: VALID_PASSWORD,
    });
    assert.equal(response.status, 201);

    assert.equal(database.state.inserts.length, 1);
    const insert = database.state.inserts[0];
    assert.equal(insert.email, "hash-check@example.com");
    assert.notEqual(insert.passwordHash, VALID_PASSWORD);
    assert.match(insert.passwordHash, /^\$argon2id\$v=19\$/);
  });

  it("rejects a password shorter than 12 code points", async () => {
    const response = await register(base, {
      email: "short@example.com",
      password: "short",
    });

    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(errorResponseSchema.safeParse(body).success, true);
    assert.equal(body.error.code, "VALIDATION_FAILED");
    assert.equal(
      database.state.inserts.some((entry) => entry.email === "short@example.com"),
      false,
    );
  });

  it("rejects an unknown key instead of ignoring it", async () => {
    const response = await register(base, {
      email: "unknown-key@example.com",
      password: VALID_PASSWORD,
      role: "admin",
    });
    assert.equal(response.status, 400);
    const body = await response.json();
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });

  it("maps a unique-constraint violation to 409 CONFLICT with no details", async () => {
    database.state.duplicateEmails.add("taken@example.com");
    try {
      const response = await register(base, {
        email: "taken@example.com",
        password: VALID_PASSWORD,
      });

      assert.equal(response.status, 409);
      const body = await response.json();
      assert.equal(errorResponseSchema.safeParse(body).success, true);
      assert.equal(body.error.code, "CONFLICT");
      assert.equal("details" in body.error, false);
    } finally {
      database.state.duplicateEmails.delete("taken@example.com");
    }
  });

  it("rejects a body over the explicit 16 KiB limit with 413", async () => {
    const response = await register(base, {
      email: "oversized@example.com",
      password: "a".repeat(17 * 1024),
    });

    assert.equal(response.status, 413);
    const body = await response.json();
    assert.equal(errorResponseSchema.safeParse(body).success, true);
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });
});

describe("registration rate limiting", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp({ config: FAST_HASHING }));
  });

  after(async () => {
    await app.close();
  });

  it("allows 30 requests then refuses with 429 and Retry-After", async () => {
    for (let index = 0; index < 30; index += 1) {
      const response = await register(base, {
        email: `limit-${index}@example.com`,
        password: VALID_PASSWORD,
      });
      assert.equal(response.status, 201, `request ${index + 1} should succeed`);
    }

    const refused = await register(base, {
      email: "limit-refused@example.com",
      password: VALID_PASSWORD,
    });

    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("retry-after")) >= 1);
    assert.equal(refused.headers.get("ratelimit-limit"), "30");
    assert.equal(refused.headers.get("ratelimit-remaining"), "0");

    const body = await refused.json();
    assert.equal(errorResponseSchema.safeParse(body).success, true);
    assert.equal(body.error.code, "RATE_LIMITED");

    // The refused request never reached the handler, so it never hashed or
    // inserted: the limit is enforced before the expensive work.
    assert.equal(database.state.inserts.length, 30);
    assert.equal(
      database.state.inserts.some((entry) => entry.email === "limit-refused@example.com"),
      false,
    );
  });

  it("ignores spoofed X-Forwarded-For when proxy trust is off", async () => {
    const { app: second, base: secondBase } = await startApp({ config: FAST_HASHING });
    try {
      for (let index = 0; index < 30; index += 1) {
        const response = await register(
          secondBase,
          { email: `spoof-${index}@example.com`, password: VALID_PASSWORD },
          { "x-forwarded-for": `203.0.113.${index}` },
        );
        assert.equal(response.status, 201);
      }

      const refused = await register(
        secondBase,
        { email: "spoof-refused@example.com", password: VALID_PASSWORD },
        { "x-forwarded-for": "198.51.100.99" },
      );
      assert.equal(refused.status, 429, "a new forged address must not mint a new bucket");
    } finally {
      await second.close();
    }
  });
});
