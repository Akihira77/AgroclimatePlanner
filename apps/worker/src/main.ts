import { CONTRACTS_VERSION } from "@agroclimate/contracts";
import { createPrismaClient } from "@agroclimate/database";
import {
  createFetchTransport,
  resolveOpenMeteoLicenseConfig,
  syntheticGridRegistry,
  validatedOpenMeteoGridRegistry,
} from "@agroclimate/weather-core";

import { createOutlookAggregationHandler } from "./aggregate/outlook.js";
import { createClimatologyHandler } from "./ingest/climatology.js";
import { createForecastHandler } from "./ingest/forecast.js";
import { createSeasonalHandler, isSeasonalJobPayload } from "./ingest/seasonal.js";
import { createThrottledTransport } from "./ingest/throttle.js";
import { createPostgresQueue } from "./queue/postgres.js";
import { createRunner, jsonLogger, RUNNER_DEFAULTS, type JobHandler } from "./runner.js";
import { DEFAULT_SCHEDULER_INTERVAL_MS, runSchedulerTick } from "./scheduler.js";

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

const license = resolveOpenMeteoLicenseConfig(process.env);
const registry = validatedOpenMeteoGridRegistry;
const throttledTransport = createThrottledTransport(createFetchTransport(), 250);

const db = createPrismaClient({ connectionString });
const queue = createPostgresQueue({ db, defaultMaxAttempts: 5 });
const climatology = createClimatologyHandler({
  registry,
  transport: throttledTransport,
  ...(license.archiveBaseUrl ? { baseUrl: license.archiveBaseUrl } : {}),
  ...(license.apiKey ? { apiKey: license.apiKey } : {}),
  attribution:
    process.env["ERA5_ATTRIBUTION"] ??
    "Contains modified Copernicus Climate Change Service information (2026)",
});

const seasonal = createSeasonalHandler({
  registry: syntheticGridRegistry,
  attribution: process.env["ECMWF_ATTRIBUTION"] ?? "Open-Meteo.com (CC BY 4.0); ECMWF (CC BY 4.0)",
});

const climate: JobHandler = {
  kind: "ingest.climate",
  opensIngestionRun: isSeasonalJobPayload,
  handle: (job, context) =>
    isSeasonalJobPayload(job.payload)
      ? seasonal.handle(job, context)
      : climatology.handle(job, context),
};

const outlook = createOutlookAggregationHandler();

const handlers = [
  outlook,
  createForecastHandler({
    registry,
    transport: throttledTransport,
    ...(license.forecastBaseUrl ? { baseUrl: license.forecastBaseUrl } : {}),
    ...(license.apiKey ? { apiKey: license.apiKey } : {}),
    attribution: license.attribution,
  }),
  climate,
];
const runner = createRunner({
  db,
  queue,
  handlers,
  ...RUNNER_DEFAULTS,
});

const schedulerEnabled = process.env["WORKER_SCHEDULER_ENABLED"] === "true";
let schedulerTimer: ReturnType<typeof setInterval> | undefined;
if (schedulerEnabled) {
  void runSchedulerTick({ db, queue, log: jsonLogger }).catch((err: unknown) => {
    jsonLogger("scheduler_tick_error", {
      message: err instanceof Error ? err.message : String(err),
    });
  });
  schedulerTimer = setInterval(() => {
    void runSchedulerTick({ db, queue, log: jsonLogger }).catch((err: unknown) => {
      jsonLogger("scheduler_tick_error", {
        message: err instanceof Error ? err.message : String(err),
      });
    });
  }, DEFAULT_SCHEDULER_INTERVAL_MS);
}

jsonLogger("worker_started", {
  contracts: CONTRACTS_VERSION,
  licenseMode: license.mode,
  schedulerEnabled,
  handlers: handlers.map((handler) => handler.kind),
  ...RUNNER_DEFAULTS,
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (schedulerTimer !== undefined) {
    clearInterval(schedulerTimer);
    schedulerTimer = undefined;
  }
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
