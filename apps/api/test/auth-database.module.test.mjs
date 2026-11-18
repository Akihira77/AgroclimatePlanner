import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { NestFactory } from "@nestjs/core";

import { AuthDatabaseModule } from "../dist/database/auth-database.module.js";
import { DatabaseModule } from "../dist/database/database.module.js";
import { AUTH_DATABASE_CLIENT, DATABASE_CLIENT } from "../dist/tokens.js";
import { testConfig } from "./helpers.mjs";

/**
 * The pool is never opened: every client here is a double. The module boundary
 * is the subject, not Prisma — an assertion that needed PostgreSQL would be a
 * `db:verify` assertion, and it could not then run in the normal test suite.
 */
function clientDouble() {
  const urls = [];
  const clients = [];

  const factory = (url) => {
    urls.push(url);
    const client = {
      url,
      disconnects: 0,
      async $disconnect() {
        client.disconnects += 1;
      },
    };
    clients.push(client);
    return client;
  };

  return { factory, urls, clients };
}

/** A host module that is not one of the modules under test. */
class HostModule {}

async function context(imports) {
  return NestFactory.createApplicationContext({ module: HostModule, imports }, { logger: false });
}

describe("AuthDatabaseModule", () => {
  it("provides the auth token and dials exactly the auth url", async () => {
    const config = testConfig();
    const database = clientDouble();
    const app = await context([AuthDatabaseModule.register(config, database.factory)]);

    try {
      const client = app.get(AUTH_DATABASE_CLIENT);
      assert.deepEqual(database.urls, [config.authDatabaseUrl]);
      assert.equal(client.url, config.authDatabaseUrl);
      assert.equal(
        database.urls.includes(config.databaseUrl),
        false,
        "auth module dialled the tenant url",
      );
    } finally {
      await app.close();
    }
  });

  it("is not part of a DatabaseModule-only graph", async () => {
    const config = testConfig();
    const database = clientDouble();
    const app = await context([DatabaseModule.register(config, database.factory)]);

    try {
      assert.ok(app.get(DATABASE_CLIENT));
      assert.throws(() => app.get(AUTH_DATABASE_CLIENT));
    } finally {
      await app.close();
    }
  });

  it("keeps the tenant and auth clients distinct", async () => {
    const config = testConfig();
    const database = clientDouble();
    const app = await context([
      DatabaseModule.register(config, database.factory),
      AuthDatabaseModule.register(config, database.factory),
    ]);

    try {
      const api = app.get(DATABASE_CLIENT);
      const auth = app.get(AUTH_DATABASE_CLIENT);

      assert.notEqual(api, auth, "the two tokens must not resolve to one client");
      assert.equal(api.url, config.databaseUrl);
      assert.equal(auth.url, config.authDatabaseUrl);
    } finally {
      await app.close();
    }
  });

  it("creates one client per module, even when it is resolved twice", async () => {
    const config = testConfig();
    const database = clientDouble();
    const app = await context([AuthDatabaseModule.register(config, database.factory)]);

    try {
      const first = app.get(AUTH_DATABASE_CLIENT);
      const second = app.get(AUTH_DATABASE_CLIENT);

      assert.equal(first, second);
      assert.equal(database.urls.length, 1);
    } finally {
      await app.close();
    }
  });

  it("disconnects each client once during shutdown", async () => {
    const config = testConfig();
    const database = clientDouble();
    const app = await context([
      DatabaseModule.register(config, database.factory),
      AuthDatabaseModule.register(config, database.factory),
    ]);

    assert.equal(database.clients.length, 2);
    assert.deepEqual(
      database.clients.map((client) => client.disconnects),
      [0, 0],
    );

    await app.close();
    await app.close();

    assert.deepEqual(
      database.clients.map((client) => client.disconnects),
      [1, 1],
      "each pool is closed by its own module, and only once",
    );
  });
});
