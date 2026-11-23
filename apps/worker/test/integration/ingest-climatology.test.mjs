/**
 * `ingest.climate` end to end against real PostgreSQL — Phase 5.5.
 *
 * The transport is a fixture (no provider is called) and the registry is a
 * fixture with one `validated` entry: the adapter-dev allowance of OPEN-18, not
 * production evidence. The shipped registry stays synthetic.
 *
 * Every job uses its own `algorithmVersion`, so each case owns a distinct
 * `baseline_version` (`ERA5:1991-2020:<token>`) and a conflict in one case can
 * never poison another.
 *
 * Run: pnpm --filter @agroclimate/worker test:integration
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, describe, it } from "node:test";

import { createGridRegistry, defineGridSpec, targetSelectorHashOf } from "@agroclimate/contracts";
import { createPrismaClient, LeaseLostError } from "@agroclimate/database";

import { createClimatologyHandler } from "../../dist/ingest/climatology.js";
import { createPostgresQueue } from "../../dist/queue/postgres.js";
import { createRunner } from "../../dist/runner.js";
import { roleConnectionString } from "../../../../packages/database/scripts/lib/connections.mjs";

const system = createPrismaClient({ connectionString: roleConnectionString("app_system") });
const owner = createPrismaClient({ connectionString: roleConnectionString("migration_owner") });

const token = randomUUID().slice(0, 8);
const CELL = "-6.25,106.75";
const CELL_B = "-6.50,107.00";

const GRID = createGridRegistry([
  {
    provider: "open-meteo",
    model: "era5",
    evidence: "validated",
    spec: defineGridSpec({
      gridId: `test-era5-${token}`,
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

const PERIOD_FROM = "1991-01-01";
const PERIOD_TO = "2020-12-31";
const DAY_MS = 86_400_000;

function dayStrings(startDate, endDate) {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  const days = [];
  for (let ms = start; ms <= end; ms += DAY_MS) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

const ALL_DAYS = dayStrings(PERIOD_FROM, PERIOD_TO);

function envelope(values, { latitude = -6.25, longitude = 106.75, days = ALL_DAYS } = {}) {
  return {
    latitude,
    longitude,
    timezone: "GMT",
    utc_offset_seconds: 0,
    daily_units: { time: "iso8601", precipitation_sum: "mm" },
    daily: { time: days, precipitation_sum: values },
  };
}

const steady = () => envelope(ALL_DAYS.map(() => 0.5));

/** A transport answering the pinned archive request with a caller-built body. */
function transportWith(build = () => steady()) {
  return {
    async get({ url }) {
      const requested = new URL(url);
      assert.equal(requested.searchParams.get("models"), "era5");
      assert.equal(requested.searchParams.get("timezone"), "UTC");
      return {
        ok: true,
        response: {
          status: 200,
          bodyText: JSON.stringify(
            build({
              latitude: Number(requested.searchParams.get("latitude")),
              longitude: Number(requested.searchParams.get("longitude")),
            }),
          ),
        },
      };
    },
  };
}

function selectorFor(...cellKeys) {
  return { cells: cellKeys.map((cellKey) => ({ cellKey, variable: "precipitation" })) };
}

function payloadFor({ cells = [CELL], algorithmVersion = `t${token}`, selector } = {}) {
  const targetSelector = selector ?? selectorFor(...cells);
  return {
    provider: "open-meteo",
    model: "era5",
    baselineDataset: "era5",
    algorithmVersion,
    targetSelectorHash: targetSelectorHashOf(targetSelector),
    targetSelector,
  };
}

function makeRunner({ transport = transportWith(), maxAttempts = 3, registry = GRID } = {}) {
  const queue = createPostgresQueue({ db: system, defaultMaxAttempts: maxAttempts });
  const handler = createClimatologyHandler({
    registry,
    attribution: "test fixture",
    transport,
    now: () => new Date("2026-11-23T00:00:00.000Z"),
  });
  const runner = createRunner({
    db: system,
    queue,
    handlers: [handler],
    leaseMs: 60_000,
    heartbeatMs: 60_000,
    reaperIntervalMs: 600_000,
    pollIntervalMs: 60_000,
  });
  return { queue, handler, runner };
}

async function enqueueJob(queue, payload, key = `climate:${token}:${randomUUID()}`) {
  return queue.enqueue({ kind: "ingest.climate", idempotencyKey: key, payload });
}

let jobCounter = 0;
function nextKey() {
  jobCounter += 1;
  return `climate:${token}:${jobCounter}`;
}

/** Leave exactly one runnable climate job, so `claim` cannot pick a leftover. */
async function drainOtherQueued(keepId) {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'ingest.climate'
       AND status = 'queued'
       AND id <> ${keepId}::uuid
       AND idempotency_key LIKE ${`climate:${token}:%`}
  `;
}

async function runOnly(runner, id) {
  await drainOtherQueued(id);
  return runner.runOnce();
}

async function jobRow(id) {
  const rows = await owner.$queryRaw`
    SELECT status, attempt, last_error, payload, ingestion_run_id AS "ingestionRunId"
      FROM app.jobs WHERE id = ${id}::uuid
  `;
  return rows[0];
}

async function normalsFor(version) {
  return owner.$queryRaw`
    SELECT c.cell_key AS "cellKey",
           to_char(n.month, 'YYYY-MM-DD') AS month,
           n.value_mm AS "valueMm",
           n.sample_years AS "sampleYears",
           n.baseline_dataset AS "baselineDataset"
      FROM app.climatology_normals n
      JOIN app.outlook_cells c ON c.id = n.outlook_cell_id
     WHERE n.baseline_version = ${version}
     ORDER BY c.cell_key, n.month
  `;
}

before(async () => {
  // This suite owns every job whose key carries its token; a failed previous
  // run must not leave one behind for this run's claim to pick up.
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'ingest.climate' AND idempotency_key LIKE ${`climate:${token}:%`}
  `;
});

after(async () => {
  await owner.$queryRaw`
    DELETE FROM app.jobs
     WHERE kind = 'ingest.climate' AND idempotency_key LIKE ${`climate:${token}:%`}
  `;
  await owner.$queryRaw`DELETE FROM app.climatology_normals WHERE baseline_version LIKE ${`ERA5:1991-2020:t${token}%`}`;
  await system.$disconnect();
  await owner.$disconnect();
});

describe("ingest.climate — the happy path", () => {
  it("stores 12 normals and settles a job that opens no ingestion run", async () => {
    const { queue, runner } = makeRunner();
    const algorithmVersion = `t${token}-ok`;
    const payload = payloadFor({ algorithmVersion });
    const { id } = await enqueueJob(queue, payload);

    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "succeeded");
    assert.equal(job.attempt, 1);
    assert.equal(job.ingestionRunId, null, "a baseline invents no IngestionRun");

    const rows = await normalsFor(`ERA5:1991-2020:${algorithmVersion}`);
    assert.equal(rows.length, 12);
    assert.equal(rows[0].cellKey, CELL);
    assert.equal(rows[0].month, "1991-01-01");
    assert.equal(rows[11].month, "1991-12-01");
    assert.equal(rows[0].valueMm, 15.5, "31 days × 0.5 mm");
    assert.equal(rows[0].sampleYears, 30);
    assert.equal(rows[0].baselineDataset, "era5");
    assert.equal(
      rows[1].valueMm,
      (22 * 28 * 0.5 + 8 * 29 * 0.5) / 30,
      "leap Februaries are separate totals",
    );
  });

  it("treats a duplicate enqueue as the same job, not a second baseline", async () => {
    const { queue, runner } = makeRunner();
    const algorithmVersion = `t${token}-dup`;
    const payload = payloadFor({ algorithmVersion });
    const key = nextKey();

    const first = await enqueueJob(queue, payload, key);
    const second = await enqueueJob(queue, payload, key);
    assert.equal(first.enqueued, true);
    assert.equal(second.enqueued, false);
    assert.equal(second.id, first.id);

    assert.equal(await runOnly(runner, first.id), "handled");
    assert.equal(await runner.runOnce(), "idle");
    assert.equal((await normalsFor(`ERA5:1991-2020:${algorithmVersion}`)).length, 12);
  });
});

describe("ingest.climate — gates before the provider", () => {
  it("dies grid_not_validated when the registry has no validated era5 entry", async () => {
    const { queue, runner } = makeRunner({
      registry: createGridRegistry([]),
      transport: {
        async get() {
          throw new Error("transport must not be called");
        },
      },
    });
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion: `t${token}-gate` }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "grid_not_validated");
    assert.equal((await normalsFor(`ERA5:1991-2020:t${token}-gate`)).length, 0);
  });

  it("refuses a selector cell that is not a node of the validated grid", async () => {
    const { queue, runner } = makeRunner();
    const payload = payloadFor({
      algorithmVersion: `t${token}-sel`,
      cells: ["-6.1,106.75"],
    });
    const { id } = await enqueueJob(queue, payload);
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "selector_invalid");
  });

  it("refuses a selector whose hash does not match the payload", async () => {
    const { queue, runner } = makeRunner();
    const payload = {
      ...payloadFor({ algorithmVersion: `t${token}-hash` }),
      targetSelectorHash: "0".repeat(64),
    };
    const { id } = await enqueueJob(queue, payload);
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "selector_hash_mismatch");
  });
});

describe("ingest.climate — provider and data failures", () => {
  it("classifies a 5xx as retryable and requeues the job", async () => {
    const { queue, runner } = makeRunner({
      transport: {
        async get() {
          return { ok: true, response: { status: 503, bodyText: "" } };
        },
      },
    });
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion: `t${token}-503` }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "queued", "a retryable failure is queued again");
    assert.equal(job.attempt, 1);
    assert.equal(job.last_error.code, "transport");
    assert.equal((await normalsFor(`ERA5:1991-2020:t${token}-503`)).length, 0);
  });

  it("dies with archive_incomplete when the provider returns a short axis", async () => {
    const { queue, runner } = makeRunner({
      transport: transportWith(() =>
        envelope(
          ALL_DAYS.slice(0, 400).map(() => 0.5),
          { days: ALL_DAYS.slice(0, 400) },
        ),
      ),
    });
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion: `t${token}-short` }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "archive_incomplete");
    assert.equal((await normalsFor(`ERA5:1991-2020:t${token}-short`)).length, 0);
  });

  it("dies with insufficient_history when a month has no complete year", async () => {
    const { queue, runner } = makeRunner({
      transport: transportWith(() =>
        envelope(ALL_DAYS.map((day) => (day.startsWith("1991-01") ? 1 : null))),
      ),
    });
    const { id } = await enqueueJob(
      queue,
      payloadFor({ algorithmVersion: `t${token}-insufficient` }),
    );
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "insufficient_history");
    assert.equal((await normalsFor(`ERA5:1991-2020:t${token}-insufficient`)).length, 0);
  });

  it("writes nothing for any cell when one cell has insufficient history", async () => {
    const { queue, runner } = makeRunner({
      transport: transportWith(({ latitude }) =>
        latitude === -6.5
          ? envelope(
              ALL_DAYS.map(() => null),
              { latitude, longitude: 107 },
            )
          : steady(),
      ),
    });
    const algorithmVersion = `t${token}-rollback`;
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion, cells: [CELL, CELL_B] }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "insufficient_history");
    assert.equal((await normalsFor(`ERA5:1991-2020:${algorithmVersion}`)).length, 0);
  });

  it("dies with baseline_conflict and keeps the stored normal", async () => {
    const algorithmVersion = `t${token}-conflict`;
    const version = `ERA5:1991-2020:${algorithmVersion}`;

    await owner.$queryRaw`
      INSERT INTO app.outlook_cells (provider, model, cell_key)
      VALUES ('open-meteo', 'era5', ${CELL})
      ON CONFLICT (provider, model, cell_key) DO NOTHING
    `;
    await owner.$queryRaw`
      INSERT INTO app.climatology_normals (
        baseline_version, baseline_dataset, period_from, period_to,
        outlook_cell_id, month, value_mm, sample_years
      )
      SELECT ${version}, 'era5', DATE '1991-01-01', DATE '2020-12-31',
             id, DATE '1991-01-01', 999, 30
        FROM app.outlook_cells
       WHERE provider = 'open-meteo' AND model = 'era5' AND cell_key = ${CELL}
    `;

    const { queue, runner } = makeRunner();
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.last_error.code, "baseline_conflict");

    const rows = await normalsFor(version);
    assert.equal(rows.length, 1, "the other 11 months rolled back with the conflict");
    assert.equal(rows[0].valueMm, 999);
  });

  it("dies with retry_exhausted after the attempt budget is spent", async () => {
    const { queue, runner } = makeRunner({
      maxAttempts: 1,
      transport: {
        async get() {
          return { ok: true, response: { status: 500, bodyText: "" } };
        },
      },
    });
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion: `t${token}-exhaust` }));
    assert.equal(await runOnly(runner, id), "handled");

    const job = await jobRow(id);
    assert.equal(job.status, "dead");
    assert.equal(job.attempt, 1);
    assert.equal(job.last_error.code, "transport");
  });
});

describe("ingest.climate — leases", () => {
  it("refuses to write when the lease token no longer matches the row", async () => {
    const { queue, handler } = makeRunner();
    const payload = payloadFor({ algorithmVersion: `t${token}-lease` });
    const { id } = await enqueueJob(queue, payload);
    await drainOtherQueued(id);

    const claimed = await queue.claim({ kinds: ["ingest.climate"], leaseMs: 60_000 });
    assert.ok(claimed !== null);
    assert.equal(claimed.id, id);

    // Another worker takes the row between claim and commit.
    await owner.$queryRaw`
      UPDATE app.jobs
         SET lease_token = gen_random_uuid(),
             lease_expires_at = now() + interval '5 minutes'
       WHERE id = ${id}::uuid
    `;

    await assert.rejects(
      () =>
        handler.handle(claimed, {
          db: system,
          signal: new AbortController().signal,
          log: () => {},
          execution: null,
        }),
      (error) => error instanceof LeaseLostError,
    );
    assert.equal((await normalsFor(`ERA5:1991-2020:t${token}-lease`)).length, 0);
  });

  it("recovers an expired lease with the reaper and then succeeds", async () => {
    const { queue, runner } = makeRunner();
    const algorithmVersion = `t${token}-reap`;
    const { id } = await enqueueJob(queue, payloadFor({ algorithmVersion }));

    await drainOtherQueued(id);
    const claimed = await queue.claim({ kinds: ["ingest.climate"], leaseMs: 1 });
    assert.ok(claimed !== null);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const reaped = await queue.reapExpired();
    assert.ok(reaped.some((row) => row.id === id));
    const afterReap = await jobRow(id);
    assert.equal(afterReap.status, "queued");

    await drainOtherQueued(id);
    assert.equal(await runOnly(runner, id), "handled");
    assert.equal((await jobRow(id)).status, "succeeded");
    assert.equal((await normalsFor(`ERA5:1991-2020:${algorithmVersion}`)).length, 12);
  });
});
