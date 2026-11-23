import { CONTRACTS_VERSION } from "@agroclimate/contracts";
import { createPrismaClient } from "@agroclimate/database";
import { syntheticGridRegistry } from "@agroclimate/weather-core";

import { createClimatologyHandler } from "./ingest/climatology.js";
import { createForecastHandler } from "./ingest/forecast.js";
import { createPostgresQueue } from "./queue/postgres.js";
import { createRunner, jsonLogger, RUNNER_DEFAULTS } from "./runner.js";

/**
 * The worker process — `climate-data-foundation.md` §8.3.
 *
 * It connects as `app_system`, claims from `app.jobs`, renews a lease while it
 * works, and recovers abandoned leases on a timer.
 *
 * `ingest.forecast` is registered, and registering it opens no gate. The
 * registry it is given is `syntheticGridRegistry`, whose only entry is
 * `synthetic`, and `requireValidated` refuses that: every real job dies with
 * `grid_not_validated` before a provider is called (OPEN-18). A validated
 * registry is what turns the queue into a working ingest, and that is a
 * deliberate, separate act.
 *
 * `OPEN-03` still applies: no commercial production ingestion until the
 * Open-Meteo licensing condition is satisfied. The attribution string here is
 * provenance, not a licence decision.
 */

const connectionString = process.env["APP_SYSTEM_DATABASE_URL"];
if (connectionString === undefined || connectionString.length === 0) {
  jsonLogger("config_error", { message: "APP_SYSTEM_DATABASE_URL is required" });
  process.exit(1);
}

const db = createPrismaClient({ connectionString });
const queue = createPostgresQueue({ db, defaultMaxAttempts: 5 });
const handlers = [
  createForecastHandler({
    registry: syntheticGridRegistry,
    attribution: process.env["OPEN_METEO_ATTRIBUTION"] ?? "Open-Meteo.com (CC BY 4.0)",
  }),
  createClimatologyHandler({
    registry: syntheticGridRegistry,
    // Copernicus Licence wording; the build must never invent an attribution.
    attribution:
      process.env["ERA5_ATTRIBUTION"] ??
      "Contains modified Copernicus Climate Change Service information (2026)",
  }),
];
const runner = createRunner({
  db,
  queue,
  handlers,
  ...RUNNER_DEFAULTS,
});

jsonLogger("worker_started", {
  contracts: CONTRACTS_VERSION,
  handlers: handlers.map((handler) => handler.kind),
  note: "ingest.forecast is registered but every grid is synthetic; requireValidated refuses it",
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
