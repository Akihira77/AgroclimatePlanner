import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApplication } from "../dist/app.factory.js";
import { testConfig, testDatabase } from "./helpers.mjs";

describe("database provider lifecycle", () => {
  it("creates exactly one client and closes it on shutdown", async () => {
    const config = testConfig();
    const database = testDatabase();
    const seen = [];

    const app = await createApplication({
      config,
      createDatabaseClient: (connectionString) => {
        seen.push(connectionString);
        return database.factory();
      },
    });

    assert.equal(seen.length, 1, "factory must run once, not once per consumer");
    assert.equal(seen[0], config.databaseUrl);
    assert.equal(database.state.disconnected, 0);

    await app.close();
    assert.equal(database.state.disconnected, 1);
  });

  it("closes the client once even if shutdown runs twice", async () => {
    const database = testDatabase();
    const app = await createApplication({
      config: testConfig(),
      createDatabaseClient: database.factory,
    });

    await app.close();
    await app.close();
    assert.equal(database.state.disconnected, 1);
  });
});
