import { CONTRACTS_VERSION } from "@agroclimate/contracts";
import { createPrismaClient } from "@agroclimate/database";

import { createPostgresQueue } from "./queue/postgres.js";
import { createRunner, jsonLogger, RUNNER_DEFAULTS } from "./runner.js";

/**
 * The worker process — `climate-data-foundation.md` §8.3.
 *
 * It connects as `app_system`, claims from `app.jobs`, renews a lease while it
 * works, and recovers abandoned leases on a timer. It does **not** call a
 * provider and does **not** write weather data: the ingestion handlers are
 * Phase 5.4, and registering none is the honest way to say so. A placeholder
 * handler that reported success would be indistinguishable from a real ingest
 * in `ingestion_runs`, which is exactly the lie this phase must not ship.
 *
 * A zero-handler worker still does real work: it runs the reaper, so a crashed
 * worker's leases are recovered even when this process has nothing to claim.
 */

const connectionString = process.env["APP_SYSTEM_DATABASE_URL"];
if (connectionString === undefined || connectionString.length === 0) {
  jsonLogger("config_error", { message: "APP_SYSTEM_DATABASE_URL is required" });
  process.exit(1);
}

const db = createPrismaClient({ connectionString });
const queue = createPostgresQueue({ db, defaultMaxAttempts: 5 });
const runner = createRunner({
  db,
  queue,
  handlers: [],
  ...RUNNER_DEFAULTS,
});

jsonLogger("worker_started", {
  contracts: CONTRACTS_VERSION,
  handlers: 0,
  note: "no ingestion handler is registered; provider ingestion is Phase 5.4",
  ...RUNNER_DEFAULTS,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) {
    // A second signal is an operator saying "now": the lease will be recovered.
    process.exit(1);
  }
  shuttingDown = true;
  jsonLogger("shutdown_signal", { signal });
  await runner.stop();
  await db.$disconnect();
  process.exit(0);
}

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void shutdown(signal);
  });
}

runner.start();
