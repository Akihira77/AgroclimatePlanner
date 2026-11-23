/**
 * `ingest.forecast` end to end against real PostgreSQL.
 *
 * The transport is a fixture (no provider is called) and the registry is a
 * fixture with one `validated` entry, which is exactly the adapter-dev/test
 * allowance of OPEN-18 — the shipped registry stays synthetic.
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

import { createForecastHandler } from "../../dist/ingest/forecast.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const key = (suffix) => `test:forecast:${token}:${suffix}`;

const ADAPTER_VERSION = "test-forecast-adapter@1.0.0";
const NORMALIZER_VERSION = "test-forecast-normalizer@1.0.0";

const GRID = createGridRegistry([
  {
    provider: "open-meteo",
    model: "best_match",
    evidence: "validated",
    spec: defineGridSpec({
      gridId: `test-0.25deg-${token}`,
      originLat: "-7",
      originLon: "106",
      stepLat: "0.25",
      stepLon: "0.25",
      latRange: ["-7", "-5"],
      lonDomain: "bounded",
      lonRange: ["106", "108"],
      orientation: "south-west",
      spatialResolutionKm: 28,
    }),
  },
]);

const CELL_KEY = "-6.25,106.75";

const FORECAST_DAYS = 16;

function dayStrings() {
  const start = Date.UTC(2026, 10, 24);
  return Array.from({ length: FORECAST_DAYS }, (_, index) =>
    new Date(start + index * 86_400_000).toISOString().slice(0, 10),
  );
}

const DAYS = dayStrings();

const risingTransport = {
  async get({ url }) {
    const requested = new URL(url);
    const latitude = Number(requested.searchParams.get("latitude"));
    const longitude = Number(requested.searchParams.get("longitude"));
    return {
      ok: true,
      response: {
        status: 200,
        bodyText: JSON.stringify({
          latitude: latitude - 0.02,
          longitude: longitude - 0.02,
          daily_units: { precipitation_sum: "mm" },
          daily: {
            time: DAYS,
            precipitation_sum: DAYS.map((_, index) => index / 10),
          },
        }),
      },
    };
  },
};

function makeHandler() {
  return createForecastHandler({
    registry: GRID,
    attribution: "test fixture",
    transport: risingTransport,
    now: () => new Date("2026-11-24T00:00:00.000Z"),
  });
}

const queue = createPostgresQueue({ db: system, defaultMaxAttempts: 3 });
const runner = createRunner({
  db: system,
  queue,
  handlers: [makeHandler()],
  leaseMs: 60_000,
  heartbeatMs: 60_000,
  reaperIntervalMs: 600_000,
  pollIntervalMs: 60_000,
});

const SELECTOR = [{ cellKey: CELL_KEY, variable: "precipitation" }];

async function forecastRun({ initializedAt, model = "best_match" }) {
  return upsertForecastRun(system, {
    provider: "open-meteo",
    model,
    product: "forecast",
    initializedAt,
    horizonEnd: new Date(initializedAt.getTime() + 3_600_000),
    receivedAt: new Date(initializedAt.getTime() + 60_000),
  });
}

async function enqueueAndRun(run, normalizerVersion = NORMALIZER_VERSION) {
  const identity = ingestionJobIdentityOf({
    queue: "ingest.forecast",
    forecastRunId: run.id,
    adapterVersion: ADAPTER_VERSION,
    normalizerVersion,
    targetSelectorHash: targetSelectorHashOf({ cells: SELECTOR }),
  });

  await queue.enqueue({
    kind: "ingest.forecast",
    idempotencyKey: identity.idempotencyKey,
    payload: {
      forecastRunId: run.id,
      adapterVersion: ADAPTER_VERSION,
      normalizerVersion,
      targetSelectorHash: targetSelectorHashOf({ cells: SELECTOR }),
      targetSelector: { cells: SELECTOR },
    },
  });

  const outcome = await runner.runOnce();
  assert.equal(outcome, "handled");
}

async function jobRowsFor(run) {
  return owner.$queryRaw`
    SELECT j.status, j.attempt, j.last_error,
           r.status AS "runStatus", r.record_count AS "recordCount",
           r.coverage_percent AS "coveragePercent"
      FROM app.jobs j
      JOIN app.ingestion_runs r ON r.id = j.ingestion_run_id
     WHERE r.forecast_run_id = ${run.id}::uuid
     ORDER BY r.created_at
  `;
}

async function liveCount(run) {
  const rows = await owner.$queryRaw`
    SELECT count(*)::int AS n FROM app.weather_records
     WHERE forecast_run_id = ${run.id}::uuid AND superseded_at IS NULL
  `;
  return rows[0].n;
}

before(async () => {
  // The suite owns every `open-meteo`/`best_match` row and every
  // `ingest.forecast` job. A failed previous run must not be able to make this
  // one pass or fail for the wrong reason — `claim` is queue-wide, so a
  // leftover queued job would be claimed here.
  await owner.$queryRaw`DELETE FROM app.jobs WHERE kind = 'ingest.forecast'`;
  await owner.$queryRaw`
    DELETE FROM app.weather_records
     WHERE forecast_run_id IN (
       SELECT id FROM app.forecast_runs WHERE provider = 'open-meteo' AND model = 'best_match'
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.ingestion_runs
     WHERE forecast_run_id IN (
       SELECT id FROM app.forecast_runs WHERE provider = 'open-meteo' AND model = 'best_match'
     )
  `;
  await owner.$queryRaw`
    DELETE FROM app.forecast_runs WHERE provider = 'open-meteo' AND model = 'best_match'
  `;
  await owner.$queryRaw`
    DELETE FROM app.outlook_cells WHERE provider = 'open-meteo' AND model = 'best_match'
  `;
});

after(async () => {
  await system.$disconnect();
  await owner.$disconnect();
});

describe("ingest.forecast", () => {
  it("persists a deterministic run and settles the pair", async () => {
    const run = await forecastRun({ initializedAt: new Date("2026-11-24T00:00:00.000Z") });
    await enqueueAndRun(run);

    const jobs = await jobRowsFor(run);
    assert.equal(jobs.length, 1);
    assert.equal(jobs[0].status, "succeeded");
    assert.equal(jobs[0].runStatus, "succeeded");
    assert.equal(jobs[0].recordCount, FORECAST_DAYS);
    assert.equal(jobs[0].coveragePercent, 100);

    assert.equal(await liveCount(run), FORECAST_DAYS);

    const cell = await owner.$queryRaw`
      SELECT served_lat AS "servedLat", served_lon AS "servedLon"
        FROM app.outlook_cells
       WHERE provider = 'open-meteo' AND model = 'best_match' AND cell_key = ${CELL_KEY}
    `;
    assert.equal(cell.length, 1);
    assert.ok(Math.abs(cell[0].servedLat - -6.27) < 1e-9);

    const horizon = await owner.$queryRaw`
      SELECT horizon_end > initialized_at + interval '1 day' AS "extended"
        FROM app.forecast_runs WHERE id = ${run.id}::uuid
    `;
    assert.equal(horizon[0].extended, true);
  });

  it("supersedes its own predecessor on a re-normalisation, same forecast run", async () => {
    const run = await forecastRun({ initializedAt: new Date("2026-11-24T01:00:00.000Z") });
    await enqueueAndRun(run, "normalizer-a@1");
    await enqueueAndRun(run, "normalizer-b@1");

    const jobs = await jobRowsFor(run);
    assert.equal(jobs.length, 2, "a re-normalisation is a new IngestionRun");
    assert.deepEqual(
      jobs.map((row) => row.status),
      ["succeeded", "succeeded"],
    );

    // The unique live key includes `forecast_run_id`, so the same-run case can
    // only work if the old rows were superseded first and the deferred FK let
    // the replacement id be named before the row existed.
    assert.equal(await liveCount(run), FORECAST_DAYS);
    const rows = await owner.$queryRaw`
      SELECT count(*)::int AS total,
             count(*) FILTER (WHERE superseded_by_id IS NOT NULL)::int AS "linked"
        FROM app.weather_records WHERE forecast_run_id = ${run.id}::uuid
    `;
    assert.equal(rows[0].total, FORECAST_DAYS * 2);
    assert.equal(rows[0].linked, FORECAST_DAYS);
  });

  it("never lets an older run overwrite newer persisted data", async () => {
    const newer = await forecastRun({ initializedAt: new Date("2026-11-24T06:00:00.000Z") });
    await enqueueAndRun(newer);

    // Same model, earlier initialisation, ingested second: the rows are born
    // superseded instead of becoming live beside the newer run's.
    const older = await forecastRun({ initializedAt: new Date("2026-11-24T00:30:00.000Z") });
    await enqueueAndRun(older);

    assert.equal(await liveCount(older), 0);
    assert.equal(await liveCount(newer), FORECAST_DAYS);
  });

  it("serialises two concurrent ingestions of the same forecast run", async () => {
    const run = await forecastRun({ initializedAt: new Date("2026-11-24T12:00:00.000Z") });

    const other = createRunner({
      db: system,
      queue: createPostgresQueue({ db: system, defaultMaxAttempts: 3 }),
      handlers: [makeHandler()],
      leaseMs: 60_000,
      heartbeatMs: 60_000,
      reaperIntervalMs: 600_000,
      pollIntervalMs: 60_000,
    });

    const hash = targetSelectorHashOf({ cells: SELECTOR });
    for (const version of ["concurrent-a@1", "concurrent-b@1"]) {
      const identity = ingestionJobIdentityOf({
        queue: "ingest.forecast",
        forecastRunId: run.id,
        adapterVersion: ADAPTER_VERSION,
        normalizerVersion: version,
        targetSelectorHash: hash,
      });
      await queue.enqueue({
        kind: "ingest.forecast",
        idempotencyKey: identity.idempotencyKey,
        payload: {
          forecastRunId: run.id,
          adapterVersion: ADAPTER_VERSION,
          normalizerVersion: version,
          targetSelectorHash: hash,
          targetSelector: { cells: SELECTOR },
        },
      });
    }

    // Two workers, two claims, two transactions; the advisory lock is the only
    // thing ordering them.
    await Promise.all([runner.runOnce(), other.runOnce()]);

    assert.equal(await liveCount(run), FORECAST_DAYS);
    const jobs = await jobRowsFor(run);
    assert.equal(jobs.length, 2);
    assert.ok(jobs.every((row) => row.status === "succeeded"));
  });

  it("refuses a payload whose selector does not hash to the stored hash", async () => {
    const run = await forecastRun({ initializedAt: new Date("2026-11-24T18:00:00.000Z") });
    const hash = targetSelectorHashOf({ cells: SELECTOR });
    const identity = ingestionJobIdentityOf({
      queue: "ingest.forecast",
      forecastRunId: run.id,
      adapterVersion: ADAPTER_VERSION,
      normalizerVersion: "mismatch@1",
      targetSelectorHash: hash,
    });

    await queue.enqueue({
      kind: "ingest.forecast",
      idempotencyKey: key("mismatch"),
      payload: {
        forecastRunId: run.id,
        adapterVersion: ADAPTER_VERSION,
        normalizerVersion: "mismatch@1",
        targetSelectorHash: hash,
        targetSelector: { cells: [{ cellKey: CELL_KEY, variable: "temperature" }] },
      },
    });

    await runner.runOnce();

    const rows = await owner.$queryRaw`
      SELECT status, last_error->>'code' AS code
        FROM app.jobs WHERE idempotency_key = ${key("mismatch")}
    `;
    assert.equal(rows[0].status, "dead");
    assert.equal(rows[0].code, "selector_hash_mismatch");
    assert.equal(identity.ingestionVersion.length, 64);
  });

  it("dies with grid_not_validated when the registry holds no validated entry", async () => {
    const run = await forecastRun({ initializedAt: new Date("2026-11-25T00:00:00.000Z") });
    const strict = createRunner({
      db: system,
      queue: createPostgresQueue({ db: system, defaultMaxAttempts: 3 }),
      handlers: [
        createForecastHandler({
          registry: createGridRegistry([]),
          attribution: "test fixture",
          transport: risingTransport,
        }),
      ],
      leaseMs: 60_000,
      heartbeatMs: 60_000,
      reaperIntervalMs: 600_000,
      pollIntervalMs: 60_000,
    });

    const hash = targetSelectorHashOf({ cells: SELECTOR });
    await queue.enqueue({
      kind: "ingest.forecast",
      idempotencyKey: key("no-grid"),
      payload: {
        forecastRunId: run.id,
        adapterVersion: ADAPTER_VERSION,
        normalizerVersion: "no-grid@1",
        targetSelectorHash: hash,
        targetSelector: { cells: SELECTOR },
      },
    });

    await strict.runOnce();

    const rows = await owner.$queryRaw`
      SELECT status, last_error->>'code' AS code
        FROM app.jobs WHERE idempotency_key = ${key("no-grid")}
    `;
    assert.equal(rows[0].status, "dead");
    assert.equal(rows[0].code, "grid_not_validated");
    assert.equal(await liveCount(run), 0);
  });
});
