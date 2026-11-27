/**
 * `GET /v1/climate/forecast` through the real HTTP pipeline, over real PostgreSQL.
 *
 * The 0–45 day read model reads live `app.weather_records` rows directly; there
 * is no outlook table and no writer. So the suite seeds the physical rows the
 * ingest would have written — run, ingestion, record — as `migration_owner`, and
 * exercises the route as `app_api` behind a real session.
 *
 * The registry substitution is the monthly suite's: production binds
 * `syntheticGridRegistry`, whose provider the `app.outlook_cells` CHECK refuses.
 */
import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";

import { createGridRegistry, defineGridSpec } from "@agroclimate/contracts";

import {
  SQUARE,
  apiFor,
  cleanupUsers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "climate-forecast-";
const MODEL = `test_sumatra_1deg_forecast_${Date.now()}`;
const PROVIDER = "ecmwf";
const DAILY_MODEL = "ecmwf_ifs025";
const SUBSESONAL_MODEL = "ecmwf_ec46";

const GRID = defineGridSpec({
  gridId: "test-sumatra-1deg-forecast",
  originLat: "-10",
  originLon: "100",
  stepLat: "1",
  stepLon: "1",
  latRange: ["-10", "10"],
  lonDomain: "bounded",
  lonRange: ["100", "120"],
  orientation: "south-west",
  spatialResolutionKm: 111,
});

const TEST_REGISTRY = createGridRegistry([
  { provider: PROVIDER, model: MODEL, spec: GRID, evidence: "synthetic" },
]);

/** `SQUARE`'s centroid falls in row 3, column 6 → cell `-7.00,106.00`. */
const CELL_KEY = "-7.00,106.00";
const FIRST_DATE = "2026-11-27";
/** 00:00 Asia/Jakarta on the first date is 17:00Z the day before. */
const DAY_ZERO = "2026-11-26T17:00:00.000Z";
const DAY_MS = 86_400_000;
const HASH = "b".repeat(64);

let harness;
let call;
let alice;
let bob;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

async function createFarm(user, name = "Farm") {
  const { response, body } = await call(user, "POST", "/v1/farms", { body: { name } });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function createField(user, farmId, geometry = SQUARE) {
  const { response, body } = await call(user, "POST", "/v1/fields", {
    body: { farmId, name: "Plot", geometry },
  });
  assert.equal(response.status, 201, JSON.stringify(body));
  return body.data;
}

async function mintCell(user, fieldId) {
  const { response, body } = await call(user, "POST", `/v1/fields/${fieldId}/resolve-cell`, {
    body: { provider: PROVIDER, model: MODEL },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.cellId;
}

const forecastPath = (params) =>
  `/v1/climate/forecast?${new URLSearchParams({
    provider: PROVIDER,
    model: MODEL,
    firstDate: FIRST_DATE,
    ...params,
  }).toString()}`;

const getForecast = (user, params, { anonymous = false } = {}) =>
  call(user, "GET", forecastPath(params), { anonymous });

/** Distinct initialisation instants: the run natural key includes the instant. */
let initCounter = 0;

/** A forecast run plus a completed ingestion, as the worker would leave them. */
async function seedRun(initializedAt = new Date(Date.now() + initCounter++)) {
  const runs = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.forecast_runs
       (provider, model, product, initialized_at, horizon_end, received_at)
     VALUES ($1, $2, 'forecast', $3::timestamptz, $4::timestamptz, $3::timestamptz)
     RETURNING id::text AS id`,
    PROVIDER,
    MODEL,
    initializedAt.toISOString(),
    new Date(initializedAt.getTime() + 46 * DAY_MS).toISOString(),
  );
  const runId = runs[0].id;

  const ingestions = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.ingestion_runs
       (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
        ingestion_version, status, finished_at, coverage_percent)
     VALUES ($1::uuid, 'test-adapter@1', 'daily-precipitation@1.0.0', $2, $3, 'succeeded', now(), 100)
     RETURNING id::text AS id`,
    runId,
    HASH,
    HASH,
  );
  return { runId, ingestionId: ingestions[0].id };
}

async function seedRecord({
  cellId,
  runId,
  ingestionId,
  leadDay,
  value,
  dataClass,
  rowModel,
  initializedAt = new Date(),
  ensembleMember = null,
  supersededBy = null,
}) {
  const validAt = new Date(Date.parse(DAY_ZERO) + leadDay * DAY_MS);
  const rows = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.weather_records
       (forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
        data_class, variable, value, unit, valid_at, initialized_at, requested_lat,
        requested_lon, served_value_is_interpolated, temporal_resolution,
        ensemble_member, ensemble_size, aggregation_level, normalizer_version,
        superseded_at, superseded_by_id)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, 'precipitation', $8, 'mm',
             $9::timestamptz, $10::timestamptz, -6.15, 106.85, false, 'daily',
             $11, $12, 'daily_sum', 'daily-precipitation@1.0.0',
             $13, $14::uuid)
     RETURNING id::text AS id`,
    runId,
    ingestionId,
    cellId,
    CELL_KEY,
    PROVIDER,
    rowModel,
    dataClass,
    value,
    validAt.toISOString(),
    initializedAt.toISOString(),
    ensembleMember,
    ensembleMember === null ? null : 50,
    supersededBy === null ? null : new Date().toISOString(),
    supersededBy,
  );
  return rows[0].id;
}

/** Rows between cases: each case seeds the values it asserts on. */
async function deleteRows() {
  await harness.owner.$executeRawUnsafe(
    `DELETE FROM app.weather_records
      WHERE outlook_cell_id IN (SELECT id FROM app.outlook_cells WHERE model = $1)`,
    MODEL,
  );
  await harness.owner.$executeRawUnsafe(
    `DELETE FROM app.ingestion_runs
      WHERE forecast_run_id IN (SELECT id FROM app.forecast_runs WHERE model = $1)`,
    MODEL,
  );
  await harness.owner.$executeRawUnsafe("DELETE FROM app.forecast_runs WHERE model = $1", MODEL);
}

async function deleteSuiteData() {
  await deleteRows();
  await harness.owner.$executeRawUnsafe("DELETE FROM app.outlook_cells WHERE model = $1", MODEL);
}

before(async () => {
  harness = await startHarness({ gridRegistry: TEST_REGISTRY });
  call = apiFor(harness.base).call;
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteSuiteData();
  alice = await seedUser("alice");
  bob = await seedUser("bob");
});

beforeEach(deleteRows);

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteSuiteData();
  await stopHarness(harness);
});

describe("climate forecast — request shape and visibility", () => {
  it("rejects a request with no session", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await getForecast(alice, { fieldId: field.id }, { anonymous: true });

    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
  });

  it("rejects a malformed firstDate and a client-supplied cell key", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);

    for (const params of [{ firstDate: "2026-11-27T00:00:00Z" }, { cellKey: CELL_KEY }]) {
      const { response, body } = await getForecast(alice, { fieldId: field.id, ...params });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });

  it("answers FIELD_NOT_FOUND for a foreign field, identically to a missing one", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    await mintCell(alice, field.id);

    const foreign = await getForecast(bob, { fieldId: field.id });
    const missing = await getForecast(bob, {
      fieldId: "00000000-0000-4000-8000-000000000000",
    });

    for (const attempt of [foreign, missing]) {
      assert.equal(attempt.response.status, 404);
      assert.equal(attempt.body.error.code, "FIELD_NOT_FOUND");
    }
    assert.equal(foreign.body.error.message, missing.body.error.message);
  });
});

describe("climate forecast — the 0–45 day leg", () => {
  it("serves two dense segments from live rows and nothing else", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const cellId = await mintCell(alice, field.id);
    const { runId, ingestionId } = await seedRun();

    await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 0,
      value: 4.25,
      dataClass: "weather_forecast",
      rowModel: DAILY_MODEL,
    });
    await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 20,
      value: 11,
      dataClass: "subseasonal_forecast",
      rowModel: SUBSESONAL_MODEL,
    });

    const { response, body } = await getForecast(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const forecast = body.data;
    assert.equal(forecast.firstDate, FIRST_DATE);
    assert.equal(forecast.unit, "mm");
    assert.deepEqual(
      forecast.segments.map((segment) => segment.band),
      ["daily", "subseasonal"],
    );
    assert.deepEqual(
      forecast.segments.map((segment) => segment.days.length),
      [15, 31],
    );

    const [daily, subseasonal] = forecast.segments;
    assert.deepEqual(daily.days[0], {
      date: FIRST_DATE,
      leadDay: 0,
      dataClass: "weather_forecast",
      model: DAILY_MODEL,
      valueMm: 4.25,
      missingReason: null,
      initializedAt: daily.days[0].initializedAt,
      availability: "fresh",
      staleAfterHours: 6,
      temporalResolution: "daily",
      aggregationLevel: "daily_sum",
    });
    assert.match(daily.days[0].initializedAt, /Z$/);

    const far = subseasonal.days[5];
    assert.equal(far.leadDay, 20);
    assert.equal(far.dataClass, "subseasonal_forecast");
    assert.equal(far.model, SUBSESONAL_MODEL);
    assert.equal(far.staleAfterHours, 48);

    // A day with no row is pending, not zero.
    assert.equal(daily.days[5].valueMm, null);
    assert.equal(daily.days[5].missingReason, "pending");
    assert.equal(daily.days[5].dataClass, null);
  });

  it("marks a day stale past its band's TTL and keeps the value", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const cellId = await mintCell(alice, field.id);
    const old = new Date(Date.now() - 7 * 60 * 60 * 1000);
    const { runId, ingestionId } = await seedRun(old);

    await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 0,
      value: 9,
      dataClass: "weather_forecast",
      rowModel: DAILY_MODEL,
      initializedAt: old,
    });

    const { response, body } = await getForecast(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const day = body.data.segments[0].days[0];
    assert.equal(day.valueMm, 9);
    assert.equal(day.availability, "stale");
  });

  it("ignores superseded and ensemble rows", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const cellId = await mintCell(alice, field.id);
    const { runId, ingestionId } = await seedRun();

    const liveId = await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 1,
      value: 3,
      dataClass: "weather_forecast",
      rowModel: DAILY_MODEL,
    });
    await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 1,
      value: 99,
      dataClass: "weather_forecast",
      rowModel: DAILY_MODEL,
      supersededBy: liveId,
    });
    // An ensemble row for a day with no deterministic row: still pending.
    await seedRecord({
      cellId,
      runId,
      ingestionId,
      leadDay: 2,
      value: 7,
      dataClass: "weather_forecast",
      rowModel: DAILY_MODEL,
      ensembleMember: 4,
    });

    const { response, body } = await getForecast(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const daily = body.data.segments[0];
    assert.equal(daily.days[1].valueMm, 3);
    assert.equal(daily.days[2].valueMm, null);
    assert.equal(daily.days[2].missingReason, "pending");
  });
});
