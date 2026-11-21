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
    /** Credential rows the auth client can find by email. Keyed by normalized email. */
    users: new Map(),
    /** Session rows the auth client can resolve by token hash. */
    sessions: new Map(),
    /** Token hashes whose sliding deadline was actually extended. */
    extensions: [],
    /** Every statement the auth client served, for "did it even ask?" assertions. */
    authStatements: [],
  };

  /**
   * Shaped like the failure Prisma 7 actually produced for a raw insert: `P2010`
   * with the driver error nested under `meta.driverAdapterError.cause`, where the
   * SQLSTATE and the constraint name live. The name is what the mapping matches —
   * `23505` alone is not enough on a table with a second unique constraint.
   */
  const uniqueViolation = (constraint = "users_email_key") =>
    Object.assign(new Error("Unique constraint failed on the fields: (`email`)"), {
      code: "P2010",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: {
            originalCode: "23505",
            originalMessage: `duplicate key value violates unique constraint "${constraint}"`,
            kind: "UniqueConstraintViolation",
            constraint: { index: constraint },
            table: "users",
          },
        },
      },
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
   * The auth client. It answers the five statement shapes the authentication
   * service issues, and never a transaction — a handler that reached for the
   * tenant pool fails here instead of silently passing.
   *
   * The shapes are recognised by their SQL, and the values arrive positionally,
   * exactly as Prisma's tagged template passes them.
   */
  const authClient = () => ({
    async $queryRaw(strings, ...values) {
      const sql = Array.isArray(strings) ? strings.join("?") : String(strings);
      state.authStatements.push(sql);

      if (/INSERT INTO app\.users/.test(sql)) {
        if (state.insertDelayMs > 0) {
          await new Promise((resolve) => setTimeout(resolve, state.insertDelayMs));
        }

        const [email, passwordHash] = values;
        if (state.duplicateEmails.has(email)) throw uniqueViolation();

        const user = {
          id: randomUUID(),
          email,
          passwordHash,
          role: "owner",
          locale: "id",
          timezone: "Asia/Jakarta",
        };
        state.users.set(email, user);
        state.inserts.push({ email, passwordHash });
        // The real query returns five columns and no hash.
        const { passwordHash: _ignored, ...safe } = user;
        return [safe];
      }

      if (/FROM app\.users/.test(sql) && /WHERE email/.test(sql)) {
        const user = state.users.get(values[0]);
        return user === undefined ? [] : [user];
      }

      if (/INSERT INTO app\.sessions/.test(sql)) {
        const [userId, tokenHash] = values;
        const now = Date.now();
        const session = {
          id: randomUUID(),
          userId,
          tokenHash,
          expiresAt: now + 30 * 24 * 60 * 60 * 1000,
          absoluteExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
          revokedAt: null,
          lastSeenAt: now,
        };
        state.sessions.set(tokenHash, session);
        return [
          {
            id: session.id,
            expires_at: new Date(session.expiresAt),
            absolute_expires_at: new Date(session.absoluteExpiresAt),
          },
        ];
      }

      if (/FROM app\.sessions s/.test(sql)) {
        const session = state.sessions.get(values[0]);
        if (session === undefined) return [];
        const now = Date.now();
        if (
          session.revokedAt !== null ||
          session.expiresAt <= now ||
          session.absoluteExpiresAt <= now
        ) {
          return [];
        }
        const user = [...state.users.values()].find((entry) => entry.id === session.userId);
        if (user === undefined) return [];
        return [
          {
            sessionId: session.id,
            userId: session.userId,
            expires_at: new Date(session.expiresAt),
            absolute_expires_at: new Date(session.absoluteExpiresAt),
            email: user.email,
            role: user.role,
            locale: user.locale,
            timezone: user.timezone,
          },
        ];
      }

      if (/UPDATE app\.sessions/.test(sql) && /revoked_at = now\(\)/.test(sql)) {
        const session = state.sessions.get(values[0]);
        if (session === undefined || session.revokedAt !== null) return [];
        session.revokedAt = Date.now();
        return [{ id: session.id }];
      }

      if (/UPDATE app\.sessions/.test(sql) && /last_seen_at = now\(\)/.test(sql)) {
        const session = state.sessions.get(values[0]);
        if (session === undefined) return [];
        const now = Date.now();
        const active =
          session.revokedAt === null && session.expiresAt > now && session.absoluteExpiresAt > now;
        const throttlePassed = now - session.lastSeenAt > 5 * 60 * 1000;
        if (!active || !throttlePassed) return [];

        session.lastSeenAt = now;
        session.expiresAt = Math.min(now + 30 * 24 * 60 * 60 * 1000, session.absoluteExpiresAt);
        state.extensions.push(session.tokenHash);
        return [
          {
            expires_at: new Date(session.expiresAt),
            absolute_expires_at: new Date(session.absoluteExpiresAt),
          },
        ];
      }

      throw new Error(`unexpected auth statement: ${sql}`);
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

/** Seeds a credential row, as if registration had created it. */
export function seedUser(database, { email, passwordHash, role = "owner" }) {
  const user = {
    id: randomUUID(),
    email,
    passwordHash,
    role,
    locale: "id",
    timezone: "Asia/Jakarta",
  };
  database.state.users.set(email, user);
  return user;
}

/** Seeds a session row, defaulting to an active window. */
export function seedSession(database, { userId, tokenHash, ...overrides }) {
  const now = Date.now();
  const session = {
    id: randomUUID(),
    userId,
    tokenHash,
    expiresAt: now + 30 * 24 * 60 * 60 * 1000,
    absoluteExpiresAt: now + 90 * 24 * 60 * 60 * 1000,
    revokedAt: null,
    lastSeenAt: now,
    ...overrides,
  };
  database.state.sessions.set(tokenHash, session);
  return session;
}
