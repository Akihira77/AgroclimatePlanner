import { randomUUID } from "node:crypto";

import { createApplication } from "../dist/app.factory.js";

/** Only the fields the application actually reads. */
export function testConfig(overrides = {}) {
  return {
    nodeEnv: "test",
    port: 0,
    // Never dialled: every test passes a double. Port 1 is unreachable on
    // purpose, so a test that accidentally used the real factory would fail
    // instead of hanging.
    databaseUrl: "postgresql://app_api:test@127.0.0.1:1/agroclimate?schema=app",
    // A different role and a different port, so a test that mixed the two
    // clients up would fail on the value rather than silently pass.
    authDatabaseUrl: "postgresql://app_auth:test@127.0.0.1:1/agroclimate?schema=app",
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    trustRequestIdHeader: false,
    passwordHashing: { memoryCostKib: 19456, timeCost: 2, parallelism: 1 },
    ...overrides,
  };
}

export function testDatabase() {
  const state = {
    created: 0,
    disconnected: 0,
    /** Rejects the transaction itself: unreachable host, unusable credential. */
    failTransaction: false,
    /** Rejects the statement inside the transaction: a timeout or a cancelled query. */
    failQuery: false,
    /** Milliseconds spent "acquiring" a connection before the transaction body runs. */
    delayMs: 0,
    /** Every `$transaction` options object, in call order. */
    transactionOptions: [],
    /** Every statement issued through `$executeRawUnsafe`. */
    statements: [],
    /** Every registration insert the auth client served: `{ email, passwordHash }`. */
    inserts: [],
    /** Addresses whose insert must fail with the PostgreSQL unique violation. */
    duplicateEmails: new Set(),
    /** Milliseconds the auth insert spends before answering, for timing assertions. */
    insertDelayMs: 0,
  };

  /** Shaped like the wrapped raw-query failure: `P2010` carrying SQLSTATE 23505. */
  const uniqueViolation = () =>
    Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
      code: "P2010",
      meta: { code: "23505", message: "duplicate key value violates unique constraint" },
    });

  const tenantClient = () => ({
    async $transaction(work, options) {
      state.transactionOptions.push(options);
      if (state.failTransaction) {
        throw new Error("connect ECONNREFUSED 127.0.0.1:5442 password=hunter2");
      }
      if (state.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, state.delayMs));

      const tx = {
        async $executeRawUnsafe(sql) {
          state.statements.push(sql);
          return 0;
        },
        async $queryRaw() {
          if (state.failQuery) {
            throw new Error("canceling statement due to statement timeout (57014)");
          }
          return [{ "?column?": 1 }];
        },
      };

      return work(tx);
    },
    async $disconnect() {
      state.disconnected += 1;
    },
  });

  /**
   * The auth client. It answers exactly one statement shape — the registration
   * insert — and never a transaction, so a handler that reached for the tenant
   * pool would fail here instead of silently passing.
   */
  const authClient = () => ({
    async $queryRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      if (!/INSERT INTO app\.users/.test(sql)) {
        throw new Error(`unexpected auth statement: ${sql}`);
      }

      if (state.insertDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, state.insertDelayMs));
      }

      const [email, passwordHash] = values;
      if (state.duplicateEmails.has(email)) throw uniqueViolation();

      const user = {
        id: randomUUID(),
        email,
        role: "owner",
        locale: "id",
        timezone: "Asia/Jakarta",
      };
      state.inserts.push({ email, passwordHash });
      return [user];
    },
    async $disconnect() {
      state.disconnected += 1;
    },
  });

  const factory = (connectionString) => {
    state.created += 1;
    return connectionString.includes("app_auth") ? authClient() : tenantClient();
  };

  return { state, factory };
}

/**
 * Boots the real application — same middleware, same filter, same pipe — on an
 * ephemeral port. Two probe routes are added here, after `createApplication` and
 * before `listen()`, which is early enough in the stack to observe what
 * middleware did to the request without adding an endpoint to the application.
 */
export async function startApp(options = {}) {
  const config = testConfig(options.config);
  const database = testDatabase();
  const app = await createApplication({
    config,
    createDatabaseClient: database.factory,
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/__probe/")) return next();
    if (req.path === "/__probe/cookies") return res.json({ cookies: req.cookies });
    if (req.path === "/__probe/ip") return res.json({ ip: req.ip });
    return res.status(404).json({ unexpected: req.path });
  });

  await app.listen(0, "127.0.0.1");
  const url = await app.getUrl();

  return { app, config, database, base: url.replace("[::1]", "127.0.0.1") };
}
