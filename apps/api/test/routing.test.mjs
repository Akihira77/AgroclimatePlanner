import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema } from "@agroclimate/contracts";

import { startApp } from "./helpers.mjs";

const READINESS_TIMEOUT_MS = 2000;

describe("routing, prefix, and readiness", () => {
  let app;
  let base;
  let database;

  before(async () => {
    ({ app, base, database } = await startApp());
  });

  after(async () => {
    await app.close();
  });

  it("keeps health outside the version prefix", async () => {
    const response = await fetch(`${base}/health`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.equal(body.status, "ok");
    assert.equal(typeof body.contractsVersion, "string");
    assert.equal(typeof body.dataClassCount, "number");
  });

  it("prefixes the rest of the surface with /v1", async () => {
    // The health route is excluded, so the prefixed path must 404. If the prefix
    // were never applied, this would return the health payload.
    const response = await fetch(`${base}/v1/health`);
    assert.equal(response.status, 404);
  });

  it("reports readiness through the database client", async () => {
    const response = await fetch(`${base}/health/ready`);
    assert.equal(response.status, 200);

    const body = await response.json();
    assert.deepEqual(body, { status: "ok", checks: { database: "ok" } });
  });

  it("bounds the database operation itself, not just the response", async () => {
    database.state.statements.length = 0;
    database.state.transactionOptions.length = 0;

    await fetch(`${base}/health/ready`);

    // The statement timeout is what makes PostgreSQL cancel the query; a
    // `Promise.race` would have bounded only the HTTP response. This asserts the
    // mechanism is wired, not that PostgreSQL honoured it — that was checked
    // against the development server separately.
    assert.deepEqual(database.state.statements, [
      `SET LOCAL statement_timeout = ${READINESS_TIMEOUT_MS}`,
    ]);
    assert.deepEqual(database.state.transactionOptions, [
      { timeout: READINESS_TIMEOUT_MS, maxWait: READINESS_TIMEOUT_MS },
    ]);
  });

  it("returns a contract-valid envelope for an unknown route", async () => {
    const response = await fetch(`${base}/v1/definitely-not-a-route`);
    assert.equal(response.status, 404);

    const body = await response.json();
    const parsed = errorResponseSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  });

  it("fails readiness closed when the statement times out, without leaking why", async () => {
    database.state.failQuery = true;
    try {
      const response = await fetch(`${base}/health/ready`);
      assert.equal(response.status, 503);

      const body = await response.json();
      assert.equal(errorResponseSchema.safeParse(body).success, true);
      assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");

      const serialised = JSON.stringify(body);
      assert.equal(serialised.includes("statement timeout"), false);
      assert.equal(serialised.includes("57014"), false);
    } finally {
      database.state.failQuery = false;
    }
  });

  it("fails readiness closed when a connection cannot be obtained", async () => {
    database.state.failTransaction = true;
    try {
      const response = await fetch(`${base}/health/ready`);
      assert.equal(response.status, 503);

      const body = await response.json();
      assert.equal(errorResponseSchema.safeParse(body).success, true);
      assert.equal(body.error.code, "DEPENDENCY_UNAVAILABLE");

      const serialised = JSON.stringify(body);
      assert.equal(serialised.includes("ECONNREFUSED"), false);
      assert.equal(serialised.includes("hunter2"), false);
      assert.equal(serialised.includes("5442"), false);
    } finally {
      database.state.failTransaction = false;
    }
  });

  it("keeps liveness independent of the database", async () => {
    database.state.failTransaction = true;
    try {
      const live = await fetch(`${base}/health`);
      assert.equal(live.status, 200);

      const ready = await fetch(`${base}/health/ready`);
      assert.equal(ready.status, 503);
    } finally {
      database.state.failTransaction = false;
    }
  });
});
