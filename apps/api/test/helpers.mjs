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
    corsOrigins: ["http://localhost:5173"],
    trustProxy: false,
    trustRequestIdHeader: false,
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
    /** Every `$transaction` options object, in call order. */
    transactionOptions: [],
    /** Every statement issued through `$executeRawUnsafe`. */
    statements: [],
  };

  const factory = () => {
    state.created += 1;
    return {
      async $transaction(work, options) {
        state.transactionOptions.push(options);
        if (state.failTransaction) {
          throw new Error("connect ECONNREFUSED 127.0.0.1:5442 password=hunter2");
        }

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
    };
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
