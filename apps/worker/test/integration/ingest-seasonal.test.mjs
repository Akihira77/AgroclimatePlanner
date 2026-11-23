/**
 * `ingest.climate` seasonal end to end against real PostgreSQL — Phase 5.6.
 *
 * The transport is a fixture (no provider is called) and the registry is a
 * fixture with two `validated` entries: the adapter-dev allowance of OPEN-18,
 * not production evidence. The shipped registry stays synthetic.
 *
 * Two products share the queue and the handler, and the assertions keep them
 * apart: EC46 → `subseasonal_forecast` on lead days 15–45, SEAS5 →
 * `seasonal_forecast` with `precipitation_mean` untouched.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import {
  createGridRegistry,
  defineGridSpec,
  ingestionJobIdentityOf,
  targetSelectorHashOf,
} from "@agroclimate/contracts";
import { createPrismaClient, upsertForecastRun } from "@agroclimate/database";

import { createClimatologyHandler } from "../../dist/ingest/climatology.js";
import { createSeasonalHandler, isSeasonalJobPayload } from "../../dist/ingest/seasonal.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });
const api = createPrismaClient({ connectionString: roleConnectionString("app_api") });

const token = randomUUID().slice(0, 8);
const key = (suffix) => `seasonal:${token}:${suffix}`;

const ADAPTER_VERSION = "test-seasonal-adapter@1.0.0";
const NORMALIZER_VERSION = "test-seasonal-normalizer@1.0.0";

const NOW = new Date("2026-11-24T00:00:00.000Z");

function gridSpec() {
  return defineGridSpec({
    gridId: `test-seasonal-${token}`,
    originLat: "-7",
    originLon: "106",
    stepLat: "1",
    stepLon: "1",
    latRange: ["-7", "-5"],
    lonDomain: "bounded",
    lonRange: ["106", "108"],
    orientation: "south-west",
    spatialResolutionKm: 36,
  });
}

const GRID = createGridRegistry([
  { provider: "open-meteo", model: "ecmwf_ec46", evidence: "validated", spec: gridSpec() },
  { provider: "open-meteo", model: "ecmwf_seas5", evidence: "validated", spec: gridSpec() },
]);

const EMPTY_GRID = createGridRegistry([]);
/** `resolveGridCell` renders a node at the step's precision (`1` → two decimals). */
const CELL_KEY = "-6.00,106.00";
const SELECTOR = [{ cellKey: CELL_KEY, variable: "precipitation" }];

/** 46 daily rows beginning on the pinned request day, as EC46 answers. */
const EC46_DATES = Array.from({ length: 46 }, (_, index) =>
  new Date(NOW.getTime() + index * 86_400_000).toISOString().slice(0, 10),
);

const SEAS5_MONTHS = [
  "2026-12-01",
  "2027-01-01",
  "2027-02-01",
  "2027-03-01",
  "2027-04-01",
  "2027-05-01",
  "2027-06-01",
];
const SEAS5_VALUES = [247.6, 336.4, 367.6, 335.7, 340.3, 332.8, 225.1];

/** Every member-day carries a distinct value, so a mean cannot pass as one. */
function memberValue(day, memberId) {
  return (day + memberId) / 10;
}

function ec46Body(latitude, longitude, { memberValues, truncate } = {}) {
  const dates = truncate === undefined ? EC46_DATES : EC46_DATES.slice(0, truncate);
  const daily = { time: dates, precipitation_sum: dates.map((_, index) => index / 2) };
  for (let memberId = 1; memberId <= 50; memberId += 1) {
    const name = `precipitation_sum_member${String(memberId).padStart(2, "0")}`;
    daily[name] =
      memberValues === undefined
        ? dates.map((_, index) => memberValue(index, memberId))
        : memberValues;
  }
  return {
    latitude,
    longitude,
    daily_units: { precipitation_sum: "mm" },
    daily,
  };
}

function seas5Body(latitude, longitude, { months, values } = {}) {
  return {
    latitude,
    longitude,
    monthly_units: { precipitation_mean: "mm" },
    monthly: { time: months ?? SEAS5_MONTHS, precipitation_mean: values ?? SEAS5_VALUES },
  };
}

/**
 * One transport for both products. `servedOffset` moves the answered
 * coordinate away from the grid node; `status` / `memberValues` / `truncate`
 * force the failure the calling test is about.
 */
function transportFor({ servedOffset = 0, status = 200, onRequest, ...bodyOptions } = {}) {
  return {
    async get({ url }) {
      await onRequest?.();
      const requested = new URL(url);
      const latitude = Number(requested.searchParams.get("latitude"));
      const longitude = Number(requested.searchParams.get("longitude"));
      const servedLat = Math.round((latitude + servedOffset) * 1e6) / 1e6;
      const servedLon = Math.round((longitude + servedOffset) * 1e6) / 1e6;
      const model = requested.searchParams.get("models");
      const body =
        model === "ecmwf_seas5"
          ? seas5Body(servedLat, servedLon)
          : ec46Body(servedLat, servedLon, bodyOptions);
      return {
        ok: true,
        response: { status, bodyText: status === 200 ? JSON.stringify(body) : "" },
      };
    },
  };
}

/** The same router `main.ts` builds: one queue, two job types. */
function climateHandler(transport, registry = GRID) {
  const climatology = createClimatologyHandler({ registry, attribution: "test fixture" });
  const seasonal = createSeasonalHandler({
    registry,
    attribution: "test fixture",
    transport,
    now: () => NOW,
  });
  return {
    kind: "ingest.climate",
    opensIngestionRun: isSeasonalJobPayload,
    handle: (job, context) =>
      isSeasonalJobPayload(job.payload)
        ? seasonal.handle(job, context)
        : climatology.handle(job, context),
  };
}

function runnerFor(transport, registry = GRID) {
  return createRunner({
    db: system,
    queue: createPostgresQueue({ db: system, defaultMaxAttempts: 3 }),
    handlers: [climateHandler(transport, registry)],
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
  });
}

async function seasonalRun({ model, initializedAt, product = "seasonal" }) {
  return upsertForecastRun(system, {
    provider: "open-meteo",
    model,
    product,
    initializedAt,
    horizonEnd: new Date(initializedAt.getTime() + 3_600_000),
    receivedAt: new Date(initializedAt.getTime() + 60_000),
  });
}

async function enqueueFor(run, { suffix, normalizerVersion = NORMALIZER_VERSION } = {}) {
  const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 3 });
  const identity = ingestionJobIdentityOf({
    queue: "ingest.climate",
    forecastRunId: run.id,
    adapterVersion: ADAPTER_VERSION,
    normalizerVersion,
    targetSelectorHash: targetSelectorHashOf({ cells: SELECTOR }),
  });
  return queue.enqueue({
    kind: "ingest.climate",
    idempotencyKey: key(suffix ?? identity.idempotencyKey),
    payload: {
      forecastRunId: run.id,
      adapterVersion: ADAPTER_VERSION,
      normalizerVersion,
      targetSelectorHash: targetSelectorHashOf({ cells: SELECTOR }),
      targetSelector: { cells: SELECTOR },
    },
  });
}

async function jobFor(idempotencyKey) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt, last_error, ingestion_run_id AS "ingestionRunId"
      FROM app.jobs WHERE idempotency_key = ${idempotencyKey}
  `;
  return rows[0];
}

async function rowsFor(run) {
  return owner.$queryRaw`
    SELECT data_class AS "dataClass", variable, unit, value,
           to_char(valid_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS') AS "validAt",
           temporal_resolution AS "temporalResolution",
           aggregation_level AS "aggregationLevel",
           ensemble_member AS "ensembleMember", ensemble_size AS "ensembleSize",
           requested_lat AS "requestedLat", served_lat AS "servedLat",
           bias_corrected AS "biasCorrected", superseded_at AS "supersededAt"
      FROM app.weather_records
     WHERE forecast_run_id = ${run.id}::uuid
     ORDER BY valid_at, ensemble_member
  `;
}

async function liveCount(run) {
  const rows = await owner.$queryRaw`
    SELECT count(*)::int AS n FROM app.weather_records
     WHERE forecast_run_id = ${run.id}::uuid AND superseded_at IS NULL
  `;
  return rows[0].n;
}

/** Every row this suite can leave behind, in foreign-key order. */
async function clearOwnState() {
  // A retry-scheduled job (429 test) or a lease-lost one would otherwise be
  // claimed by the *next* test file's runner, which has no seasonal handler.
  await owner.$queryRaw`
    DELETE FROM app.jobs WHERE kind = 'ingest.climate' AND idempotency_key LIKE 'seasonal:%'
  `;
  // `jobs.ingestion_run_id` is RESTRICT: a job row has to go before its run.
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE ingestion_run_id IN (
       SELECT i.id FROM app.ingestion_runs i
        JOIN app.forecast_runs r ON r.id = i.forecast_run_id
       WHERE r.provider = 'open-meteo'
         AND (r.model IN ('ecmwf_ec46', 'ecmwf_seas5') OR r.model = 'ecmwf_ifs025')
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'ingest.climate' AND idempotency_key LIKE ${`seasonal:${token}:%`}
  `;
  await owner.$queryRaw`
    DELETE FROM app.weather_records
     WHERE forecast_run_id IN (
       SELECT id FROM app.forecast_runs
        WHERE provider = 'open-meteo'
          AND (model IN ('ecmwf_ec46', 'ecmwf_seas5') OR model = 'ecmwf_ifs025')
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.ingestion_runs
     WHERE forecast_run_id IN (
       SELECT id FROM app.forecast_runs
        WHERE provider = 'open-meteo'
          AND (model IN ('ecmwf_ec46', 'ecmwf_seas5') OR model = 'ecmwf_ifs025')
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.forecast_runs
     WHERE provider = 'open-meteo'
       AND (model IN ('ecmwf_ec46', 'ecmwf_seas5') OR model = 'ecmwf_ifs025')
  `;
  await owner.$queryRaw`
    DELETE FROM app.outlook_cells
     WHERE provider = 'open-meteo' AND model IN ('ecmwf_ec46', 'ecmwf_seas5', 'ecmwf_ifs025')
  `;
}

before(clearOwnState);

after(async () => {
  // This suite leaves a deliberately retry-scheduled job and a lease-lost one;
  // neither may survive into the next test file.
  await clearOwnState();
  await system.$disconnect();
  await owner.$disconnect();
  await api.$disconnect();
});

describe("ingest.climate — EC46 subseasonal", () => {
  it("persists lead days 15-45 as member rows in the subseasonal class", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T00:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    const enqueued = await enqueueFor(run, { suffix: "ec46-happy" });
    assert.equal(enqueued.enqueued, true);

    assert.equal(await runner.runOnce(), "handled");

    const job = await jobFor(key("ec46-happy"));
    assert.equal(job.status, "succeeded");
    assert.notEqual(job.ingestionRunId, null);

    const rows = await rowsFor(run);
    // Lead day 15 … 45 inclusive, 50 members.
    assert.equal(rows.length, 31 * 50);
    assert.ok(rows.every((row) => row.dataClass === "subseasonal_forecast"));
    assert.ok(rows.every((row) => row.variable === "precipitation"));
    assert.ok(rows.every((row) => row.unit === "mm"));
    assert.ok(rows.every((row) => row.temporalResolution === "daily"));
    assert.ok(rows.every((row) => row.aggregationLevel === "daily_sum"));
    assert.ok(rows.every((row) => row.ensembleSize === 50));
    assert.ok(rows.every((row) => row.ensembleMember >= 0 && row.ensembleMember < 50));
    // The mean is never stored as a deterministic value.
    assert.ok(rows.every((row) => row.ensembleMember !== null));
    assert.ok(rows.every((row) => row.biasCorrected === false));
    assert.ok(rows.every((row) => row.supersededAt === null));

    const first = rows[0];
    assert.equal(first.validAt, "2026-12-09T00:00:00", "lead day 15, not day 0");
    assert.equal(rows.at(-1).validAt, "2027-01-08T00:00:00", "lead day 45");
    assert.equal(first.requestedLat, -6);
    assert.equal(first.servedLat, -6);

    // 50 distinct members per day, all valued.
    const dayMembers = new Set(rows.slice(0, 50).map((row) => row.ensembleMember));
    assert.equal(dayMembers.size, 50);

    const ingestion = await owner.$queryRaw`
      SELECT i.status, i.record_count AS "recordCount", i.coverage_percent AS "coveragePercent",
             r.initialized_at AS "initializedAt"
        FROM app.ingestion_runs i
        JOIN app.forecast_runs r ON r.id = i.forecast_run_id
       WHERE i.forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(ingestion.length, 1);
    assert.equal(ingestion[0].status, "succeeded");
    assert.equal(ingestion[0].recordCount, 31 * 50);
    assert.equal(ingestion[0].coveragePercent, 100);
    assert.equal(ingestion[0].initializedAt.toISOString(), "2026-11-24T00:00:00.000Z");
  });

  it("keeps a provider null as a stored null and does not extend the horizon with it", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T02:00:00.000Z"),
    });
    const runner = runnerFor(transportFor({ memberValues: EC46_DATES.map(() => null) }));
    await enqueueFor(run, { suffix: "ec46-null" });

    await runner.runOnce();

    const job = await jobFor(key("ec46-null"));
    // Every value null is a terminal failure, not a `succeeded` run at 0 %.
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "no_values");
    assert.equal(await liveCount(run), 0);
  });

  it("refuses an answered coordinate that is not the grid node", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T03:00:00.000Z"),
    });
    const runner = runnerFor(transportFor({ servedOffset: 0.01 }));
    await enqueueFor(run, { suffix: "ec46-coords" });

    await runner.runOnce();

    const job = await jobFor(key("ec46-coords"));
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "provider_coordinate_mismatch");
    assert.equal(await liveCount(run), 0);
  });

  it("refuses a truncated axis", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T04:00:00.000Z"),
    });
    const runner = runnerFor(transportFor({ truncate: 44 }));
    await enqueueFor(run, { suffix: "ec46-truncated" });

    await runner.runOnce();

    const job = await jobFor(key("ec46-truncated"));
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "ecmwf_ec46_incomplete");
    assert.equal(await liveCount(run), 0);
  });

  it("returns a 429 job to the queue and writes nothing", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T05:00:00.000Z"),
    });
    const runner = runnerFor(transportFor({ status: 429 }));
    await enqueueFor(run, { suffix: "ec46-429" });

    await runner.runOnce();

    const job = await jobFor(key("ec46-429"));
    assert.equal(job.status, "queued");
    assert.equal(job.attempt, 1);
    assert.equal(await liveCount(run), 0);
  });
});

describe("ingest.climate — SEAS5 seasonal", () => {
  it("persists the seven provider months without renaming the quantity", async () => {
    const run = await seasonalRun({
      model: "ecmwf_seas5",
      initializedAt: new Date("2026-12-05T00:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    await enqueueFor(run, { suffix: "seas5-happy" });

    assert.equal(await runner.runOnce(), "handled");

    const job = await jobFor(key("seas5-happy"));
    assert.equal(job.status, "succeeded");

    const rows = await rowsFor(run);
    assert.equal(rows.length, 7);
    assert.ok(rows.every((row) => row.dataClass === "seasonal_forecast"));
    assert.ok(rows.every((row) => row.variable === "precipitation_mean"));
    assert.ok(rows.every((row) => row.unit === "mm"));
    assert.ok(rows.every((row) => row.temporalResolution === "monthly"));
    assert.ok(rows.every((row) => row.aggregationLevel === "monthly_mean"));
    assert.ok(rows.every((row) => row.ensembleMember === null));
    assert.ok(rows.every((row) => row.ensembleSize === null));
    assert.equal(rows[0].validAt, "2026-12-01T00:00:00");
    assert.equal(rows[0].value, 247.6);
    assert.equal(rows.at(-1).validAt, "2027-06-01T00:00:00");
    assert.equal(rows.at(-1).value, 225.1);
  });

  it("keeps a null month null rather than zero", async () => {
    const run = await seasonalRun({
      model: "ecmwf_seas5",
      initializedAt: new Date("2026-12-05T01:00:00.000Z"),
    });
    const transport = transportFor();
    const runner = runnerFor({
      async get(input) {
        const result = await transport.get(input);
        const body = JSON.parse(result.response.bodyText);
        body.monthly.precipitation_mean[2] = null;
        return { ...result, response: { ...result.response, bodyText: JSON.stringify(body) } };
      },
    });
    await enqueueFor(run, { suffix: "seas5-null" });

    await runner.runOnce();

    const rows = await rowsFor(run);
    assert.equal(rows.length, 7);
    assert.equal(rows[2].value, null);
    const job = await jobFor(key("seas5-null"));
    assert.equal(job.status, "succeeded");
    const ingestion = await owner.$queryRaw`
      SELECT status, coverage_percent AS "coveragePercent"
        FROM app.ingestion_runs WHERE forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(ingestion[0].status, "partial");
    assert.equal(ingestion[0].coveragePercent, 85.71);
  });
});

describe("ingest.climate — gates and identity", () => {
  it("dies grid_not_validated when the registry holds no seasonal entry", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T06:00:00.000Z"),
    });
    const runner = runnerFor(transportFor(), EMPTY_GRID);
    await enqueueFor(run, { suffix: "no-grid" });

    await runner.runOnce();

    const job = await jobFor(key("no-grid"));
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "grid_not_validated");
    assert.equal(await liveCount(run), 0);
  });

  it("refuses a run whose product is not seasonal", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      product: "forecast",
      initializedAt: new Date("2026-11-24T07:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    await enqueueFor(run, { suffix: "wrong-product" });

    await runner.runOnce();

    const job = await jobFor(key("wrong-product"));
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "unsupported_product");
    assert.equal(await liveCount(run), 0);
  });

  it("refuses a model with no seasonal adapter", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ifs025",
      initializedAt: new Date("2026-11-24T08:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    await enqueueFor(run, { suffix: "wrong-model" });

    await runner.runOnce();

    const job = await jobFor(key("wrong-model"));
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "unsupported_product");
  });

  it("is idempotent over the same logical ingestion", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T09:00:00.000Z"),
    });
    const first = await enqueueFor(run, { suffix: "idempotent" });
    const second = await enqueueFor(run, { suffix: "idempotent" });
    assert.equal(first.enqueued, true);
    assert.equal(second.enqueued, false);
    assert.equal(first.id, second.id);

    const runner = runnerFor(transportFor());
    await runner.runOnce();

    const jobs = await owner.$queryRaw`
      SELECT count(*)::int AS n FROM app.jobs WHERE idempotency_key = ${key("idempotent")}
    `;
    assert.equal(jobs[0].n, 1);
    assert.equal(await liveCount(run), 31 * 50);
  });

  it("supersedes its own predecessor under the same forecast run", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T10:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    await enqueueFor(run, { suffix: "renorm-a", normalizerVersion: "normalizer-a@1" });
    await runner.runOnce();
    await enqueueFor(run, { suffix: "renorm-b", normalizerVersion: "normalizer-b@1" });
    await runner.runOnce();

    assert.equal(await liveCount(run), 31 * 50);
    const total = await owner.$queryRaw`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE superseded_by_id IS NOT NULL)::int AS linked
        FROM app.weather_records WHERE forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(total[0].total, 31 * 50 * 2);
    assert.equal(total[0].linked, 31 * 50);
  });

  it("rolls back the whole ingestion when the lease is lost during the fetch", async () => {
    const run = await seasonalRun({
      model: "ecmwf_ec46",
      initializedAt: new Date("2026-11-24T11:00:00.000Z"),
    });
    const runner = runnerFor(
      transportFor({
        onRequest: async () => {
          await owner.$queryRaw`
            UPDATE app.jobs SET lease_token = gen_random_uuid()
             WHERE kind = 'ingest.climate' AND status = 'running'
          `;
        },
      }),
    );
    await enqueueFor(run, { suffix: "lease-lost" });

    await runner.runOnce();

    const job = await jobFor(key("lease-lost"));
    assert.equal(job.status, "running", "a lost lease is not settled by the loser");
    assert.equal(await liveCount(run), 0);
    const ingestion = await owner.$queryRaw`
      SELECT status FROM app.ingestion_runs WHERE forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(ingestion[0].status, "running");
  });

  it("writes nothing a tenant owns and stays readable by app_api", async () => {
    const columns = await owner.$queryRaw`
      SELECT column_name AS "name" FROM information_schema.columns
       WHERE table_schema = 'app' AND table_name = 'weather_records'
         AND column_name IN ('user_id', 'tenant_id', 'field_id', 'planting_id')
    `;
    assert.deepEqual(columns, []);

    const run = await seasonalRun({
      model: "ecmwf_seas5",
      initializedAt: new Date("2026-12-05T02:00:00.000Z"),
    });
    const runner = runnerFor(transportFor());
    await enqueueFor(run, { suffix: "api-read" });
    await runner.runOnce();

    const readable = await api.$queryRaw`
      SELECT count(*)::int AS n FROM app.weather_records
       WHERE forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(readable[0].n, 7);

    await assert.rejects(
      api.$queryRaw`
        INSERT INTO app.weather_records (forecast_run_id, ingestion_run_id, outlook_cell_id,
          cell_key, provider, model, data_class, variable, unit, valid_at, initialized_at,
          requested_lat, requested_lon, served_value_is_interpolated, normalizer_version)
        VALUES (gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
          'x', 'p', 'm', 'seasonal_forecast', 'precipitation_mean', 'mm', now(), now(),
          0, 0, false, 'n')
      `,
      /permission denied/i,
    );
  });
});
