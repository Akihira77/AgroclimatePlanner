import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { errorResponseSchema } from "@agroclimate/contracts";

import { startApp } from "./helpers.mjs";

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

  it("returns a contract-valid envelope for an unknown route", async () => {
    const response = await fetch(`${base}/v1/definitely-not-a-route`);
    assert.equal(response.status, 404);

    const body = await response.json();
    const parsed = errorResponseSchema.safeParse(body);
    assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
    assert.equal(body.error.code, "RESOURCE_NOT_FOUND");
    assert.equal(body.error.requestId, response.headers.get("x-request-id"));
  });

  it("fails readiness closed when the database is unreachable, without leaking why", async () => {
    database.state.failQuery = true;
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
      database.state.failQuery = false;
    }
  });
});
