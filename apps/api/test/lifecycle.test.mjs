import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createApplication } from "../dist/app.factory.js";
import { testConfig, testDatabase } from "./helpers.mjs";

describe("database provider lifecycle", () => {
  it("creates one client per boundary and closes both on shutdown", async () => {
    const config = testConfig();
    const database = testDatabase();
    const seen = [];

    const app = await createApplication({
      config,
      createDatabaseClient: (connectionString) => {
        seen.push(connectionString);
        return database.factory(connectionString);
      },
    });

    // Two pools, never one: the tenant client and the auth client answer to
    // different roles. A third call would mean a consumer created its own.
    assert.equal(seen.length, 2, "each module must create exactly one client");
    assert.deepEqual([...seen].sort(), [config.databaseUrl, config.authDatabaseUrl].sort());
    assert.equal(database.state.disconnected, 0);

    await app.close();
    assert.equal(database.state.disconnected, 2);
  });

  it("closes each client once even if shutdown runs twice", async () => {
    const database = testDatabase();
    const app = await createApplication({
      config: testConfig(),
      createDatabaseClient: database.factory,
    });

    await app.close();
    await app.close();
    assert.equal(database.state.disconnected, 2);
  });
});
