import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema } from "@agroclimate/contracts";

import { startApp } from "./helpers.mjs";

const READINESS_BUDGET_MS = 2000;
const ACQUISITION_BUDGET_MS = 1000;
const EXECUTION_BUDGET_MS = 1000;

/** The single `SET LOCAL` value the probe issued. */
function issuedStatementTimeout(statements) {
  assert.equal(statements.length, 1);
  const match = /^SET LOCAL statement_timeout = (\d+)$/.exec(statements[0]);
  assert.ok(match, `unexpected statement: ${statements[0]}`);
  return Number(match[1]);
}

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
    const statementTimeout = issuedStatementTimeout(database.state.statements);
    assert.ok(statementTimeout > 0 && statementTimeout <= EXECUTION_BUDGET_MS);

    // The two client-side shares are disjoint, so their sum is the overall bound.
    assert.deepEqual(database.state.transactionOptions, [
      { timeout: EXECUTION_BUDGET_MS, maxWait: ACQUISITION_BUDGET_MS },
    ]);
    assert.ok(EXECUTION_BUDGET_MS + ACQUISITION_BUDGET_MS <= READINESS_BUDGET_MS);
  });

  it("spends only what the budget has left once a connection is in hand", async () => {
    // Acquisition is not free. A probe that took ~1 s to get a connection must not
    // then grant the statement a further fixed 1 s, or the two shares add up to
    // more than the budget the caller was promised.
    database.state.delayMs = ACQUISITION_BUDGET_MS + 50;
    database.state.statements.length = 0;

    try {
      const response = await fetch(`${base}/health/ready`);
      assert.equal(response.status, 200);

      const statementTimeout = issuedStatementTimeout(database.state.statements);
      assert.ok(
        statementTimeout < EXECUTION_BUDGET_MS,
        `expected the remaining budget, got ${statementTimeout}`,
      );
      assert.ok(statementTimeout > 0);
    } finally {
      database.state.delayMs = 0;
    }
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
