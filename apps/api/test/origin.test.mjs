import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema } from "@agroclimate/contracts";

import { startApp } from "./helpers.mjs";

const ALLOWED = "http://localhost:5173";
const VALID_BODY = { email: "origin@example.com", password: "correct horse battery staple" };

function post(base, path, body, headers = {}) {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

/**
 * `Origin` validation is the ADR-006 control that has to work before parsing.
 *
 * The ordering assertions are the point of this file: a malformed or oversized
 * body must be refused for its `Origin` first, which is only true if the middleware
 * runs ahead of the body parser.
 */
describe("exact Origin validation", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp({
      config: { passwordHashing: { memoryCostKib: 8, timeCost: 1, parallelism: 1 } },
    }));
  });

  after(async () => {
    await app.close();
  });

  it("accepts the configured origin and creates the account", async () => {
    const response = await post(base, "/v1/auth/register", VALID_BODY, { origin: ALLOWED });
    assert.equal(response.status, 201);
    assert.equal(database.state.inserts.length, 1);
  });

  it("refuses an unlisted origin with the established envelope", async () => {
    const response = await post(base, "/v1/auth/register", VALID_BODY, {
      origin: "http://evil.example",
    });

    assert.equal(response.status, 403);
    const body = await response.json();
    assert.equal(errorResponseSchema.safeParse(body).success, true);
    assert.equal(body.error.code, "FORBIDDEN");
    assert.equal(typeof body.error.requestId, "string");
    assert.equal(response.headers.get("x-request-id"), body.error.requestId);
  });

  it("refuses a missing Origin", async () => {
    const response = await post(base, "/v1/auth/register", VALID_BODY);
    assert.equal(response.status, 403);
    assert.equal((await response.json()).error.code, "FORBIDDEN");
  });

  it("refuses Origin: null", async () => {
    const response = await post(base, "/v1/auth/register", VALID_BODY, { origin: "null" });
    assert.equal(response.status, 403);
  });

  it("compares scheme, host, port, and case exactly", async () => {
    const nearMisses = [
      `${ALLOWED}/`,
      "https://localhost:5173",
      "http://localhost:5174",
      "http://LOCALHOST:5173",
      "http://localhost:5173.evil.example",
      "http://localhost:51730",
      `${ALLOWED}?x=1`,
    ];

    for (const origin of nearMisses) {
      const response = await post(base, "/v1/auth/register", VALID_BODY, { origin });
      assert.equal(response.status, 403, `${origin} must not be trusted`);
    }
  });

  it("refuses a malformed body for its Origin first", async () => {
    const before = database.state.authStatements.length;

    const response = await post(base, "/v1/auth/register", "{ not json", {
      origin: "http://evil.example",
    });

    assert.equal(response.status, 403, "origin refusal must precede parsing");
    assert.equal((await response.json()).error.code, "FORBIDDEN");
    assert.equal(database.state.authStatements.length, before);
  });

  it("refuses an oversized body for its Origin first", async () => {
    const response = await post(
      base,
      "/v1/auth/register",
      { email: "big@example.com", password: "a".repeat(17 * 1024) },
      { origin: "http://evil.example" },
    );

    assert.equal(response.status, 403, "origin refusal must precede the body limit");
    assert.equal((await response.json()).error.code, "FORBIDDEN");
  });

  it("performs no hashing and no query for a refused request", async () => {
    const statements = database.state.authStatements.length;
    const inserts = database.state.inserts.length;

    const response = await post(
      base,
      "/v1/auth/login",
      { email: "user@example.com", password: "correct horse battery staple" },
      { origin: "http://evil.example" },
    );

    assert.equal(response.status, 403);
    assert.equal(database.state.authStatements.length, statements);
    assert.equal(database.state.inserts.length, inserts);
    assert.equal(database.state.sessions.size, 0);
  });

  it("applies to logout as well", async () => {
    const response = await post(base, "/v1/auth/logout", {}, { origin: "http://evil.example" });
    assert.equal(response.status, 403);
  });

  it("keeps OPTIONS preflight working without an Origin check", async () => {
    const response = await fetch(`${base}/v1/auth/login`, {
      method: "OPTIONS",
      headers: {
        origin: "http://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
      },
    });

    assert.equal(response.status, 204);
  });

  it("leaves GET requests alone", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);
  });
});
