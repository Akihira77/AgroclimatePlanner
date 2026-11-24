/**
 * `GET /v1/climate/outlook` through the real HTTP pipeline, over real PostgreSQL
 * and the real `app_api` / `app_auth` roles.
 *
 * The registry is the one substitution, for the same reason
 * `resolve-cell.test.mjs` makes it: production binds `syntheticGridRegistry`
 * (provider `synthetic`), which the database CHECK on `app.outlook_cells`
 * deliberately refuses. So the harness gets an isolated registry with one
 * database-allowed provider, a bounded one-degree lattice, and
 * `evidence: "synthetic"`. It is a test grid; nothing here claims a provider has
 * been validated or has served a cell.
 *
 * Nothing in this suite seeds `field_outlook_cells`: the read path has no
 * persisted field → cell mapping to read (5.2 defers it), so the cell is minted the
 * only legitimate way — `POST /v1/fields/:fieldId/resolve-cell` — and the
 * `monthly_outlooks` rows are written directly as `migration_owner` because there
 * is no write route for an outlook and no seasonal writer in this build.
 *
 * Every assertion that matters runs as `app_api` behind a real session.
 * `migration_owner` is used only to seed and to read physical state.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { createGridRegistry, defineGridSpec } from "@agroclimate/contracts";

import {
  SQUARE,
  UUID,
  apiFor,
  cleanupUsers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "climate-outlook-";
const MODEL = `test_sumatra_1deg_climate_${Date.now()}`;
const PROVIDER = "ecmwf";

const GRID = defineGridSpec({
  gridId: "test-sumatra-1deg",
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

/** Test-only. Never registered in `syntheticGridRegistry`, never `validated`. */
const TEST_REGISTRY = createGridRegistry([
  { provider: PROVIDER, model: MODEL, spec: GRID, evidence: "synthetic" },
]);

/** A second node of the same grid: ~0.2°N, 110.2°E resolves to cell `0.00,110.00`. */
const ELSEWHERE = {
  type: "Polygon",
  coordinates: [
    [
      [110.2, 0.2],
      [110.3, 0.2],
      [110.3, 0.3],
      [110.2, 0.3],
      [110.2, 0.2],
    ],
  ],
};

/** `SQUARE`'s centroid falls in row 3, column 6 → cell `-7.00,106.00`. */
const CELL_KEY = "-7.00,106.00";
const OTHER_CELL_KEY = "0.00,110.00";

const FIRST_MONTH = "2026-11-01";
/** Lead months 8–12 — the only band `MONTHLY_OUTLOOK_BANDS` lets climatology fill. */
const CLIMATOLOGY_MONTHS = [
  ["2027-06-01", 120.5],
  ["2027-07-01", 98.25],
  ["2027-08-01", 76],
  ["2027-09-01", 143.75],
  ["2027-10-01", 187.5],
];

const BASELINE_VERSION = "era5-1991-2020-v3";
const DERIVATION_VERSION = "climatology-outlook@1.0.0";
const HASH = "a".repeat(64);

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

/** Mints the cell through the resolution route — the only writer in this build. */
async function mintCell(user, fieldId) {
  const { response, body } = await call(user, "POST", `/v1/fields/${fieldId}/resolve-cell`, {
    body: { provider: PROVIDER, model: MODEL },
  });
  assert.equal(response.status, 200, JSON.stringify(body));
  return body.data.cellId;
}

const outlookPath = (params) =>
  `/v1/climate/outlook?${new URLSearchParams({
    provider: PROVIDER,
    model: MODEL,
    firstMonth: FIRST_MONTH,
    ...params,
  }).toString()}`;

const getOutlook = (user, params, { anonymous = false } = {}) =>
  call(user, "GET", outlookPath(params), { anonymous });

async function cellIdOf(cellKey = CELL_KEY) {
  const rows = await harness.owner.$queryRawUnsafe(
    "SELECT id::text AS id FROM app.outlook_cells WHERE model = $1 AND cell_key = $2",
    MODEL,
    cellKey,
  );
  return rows[0]?.id;
}

/**
 * One stored climatology month, written as the aggregator would write it: the
 * month state table's `climatology` row — a value, a class, `beyond_horizon`, and
 * a baseline — plus a spread reason because there is no ensemble.
 */
async function seedClimatologyMonth(cellId, [month, valueMm], { status = "active" } = {}) {
  const rows = await harness.owner.$queryRawUnsafe(
    `INSERT INTO app.monthly_outlooks
       (outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
        missing_reason, baseline_version, derivation_version, input_refs,
        input_snapshot_hash, spread_unavailable_reason, status)
     VALUES ($1::uuid, 'precipitation', $2::date, 'climatology', 'climatology', $3,
             'beyond_horizon', $4, $5, '[]'::jsonb, $6,
             'climatology_has_no_ensemble', $7)
     RETURNING id::text AS id`,
    cellId,
    month,
    valueMm,
    BASELINE_VERSION,
    DERIVATION_VERSION,
    HASH,
    status,
  );
  return rows[0].id;
}

/** Seeds all five climatology-band months for a cell, in order. */
async function seedClimatologyBand(cellId) {
  const ids = [];
  for (const entry of CLIMATOLOGY_MONTHS) {
    ids.push(await seedClimatologyMonth(cellId, entry));
  }
  return ids;
}

async function deleteOutlooks() {
  await harness.owner.$executeRawUnsafe(
    `DELETE FROM app.monthly_outlooks
      WHERE outlook_cell_id IN (SELECT id FROM app.outlook_cells WHERE model = $1)`,
    MODEL,
  );
}

before(async () => {
  harness = await startHarness({ gridRegistry: TEST_REGISTRY });
  call = apiFor(harness.base).call;
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteOutlooks();
  await harness.owner.$executeRawUnsafe("DELETE FROM app.outlook_cells WHERE model = $1", MODEL);
  alice = await seedUser("alice");
  bob = await seedUser("bob");
});

after(async () => {
  await cleanupUsers(harness.owner, EMAIL_PREFIX);
  await deleteOutlooks();
  await harness.owner.$executeRawUnsafe("DELETE FROM app.outlook_cells WHERE model = $1", MODEL);
  await stopHarness(harness);
});

describe("climate outlook — authentication and request shape", () => {
  it("rejects a request with no session", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await getOutlook(alice, { fieldId: field.id }, { anonymous: true });

    assert.equal(response.status, 401);
    assert.equal(body.error.code, "UNAUTHENTICATED");
  });

  it("rejects a fieldId that is not a UUID before any lookup", async () => {
    const { response, body } = await getOutlook(alice, { fieldId: "not-a-uuid" });

    assert.equal(response.status, 400);
    assert.equal(body.error.code, "VALIDATION_FAILED");
  });

  it("rejects a firstMonth that is not the first day of a calendar month", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    for (const firstMonth of ["2026-11-15", "2026-11", "not-a-month"]) {
      const { response, body } = await getOutlook(alice, { fieldId: field.id, firstMonth });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });

  it("rejects a client-supplied coordinate, cell key, or baseline", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    for (const extra of [
      { lat: "-6.15", lon: "106.85" },
      { cellKey: CELL_KEY },
      { baselineVersion: BASELINE_VERSION },
      { dataClass: "climatology" },
    ]) {
      const { response, body } = await getOutlook(alice, { fieldId: field.id, ...extra });
      assert.equal(response.status, 400, JSON.stringify(body));
      assert.equal(body.error.code, "VALIDATION_FAILED");
    }
  });
});

describe("climate outlook — field visibility and grid selection", () => {
  it("answers FIELD_NOT_FOUND for another tenant's field, identically to a missing one", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    await mintCell(alice, field.id);

    const foreign = await getOutlook(bob, { fieldId: field.id });
    const missing = await getOutlook(bob, {
      fieldId: "00000000-0000-4000-8000-000000000000",
    });

    for (const attempt of [foreign, missing]) {
      assert.equal(attempt.response.status, 404);
      assert.equal(attempt.body.error.code, "FIELD_NOT_FOUND");
    }
    assert.equal(foreign.body.error.message, missing.body.error.message);
  });

  it("answers FIELD_NOT_FOUND once the field is soft-deleted", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    await mintCell(alice, field.id);
    assert.equal((await call(alice, "DELETE", `/v1/fields/${field.id}`)).response.status, 204);

    const { response, body } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 404);
    assert.equal(body.error.code, "FIELD_NOT_FOUND");
  });

  it("answers GRID_NOT_FOUND for a pair the registry does not hold", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const { response, body } = await call(
      alice,
      "GET",
      `/v1/climate/outlook?${new URLSearchParams({
        fieldId: field.id,
        provider: PROVIDER,
        model: `${MODEL}_nope`,
      })}`,
    );

    assert.equal(response.status, 404);
    assert.equal(body.error.code, "GRID_NOT_FOUND");
  });
});

describe("climate outlook — serving stored months", () => {
  it("serves twelve months in order, with climatology at leads 8–12", async () => {
    const field = await createField(alice, (await createFarm(alice)).id);
    const cellId = await mintCell(alice, field.id);
    await seedClimatologyBand(cellId);

    const { response, body } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const outlook = body.data;
    assert.equal(outlook.fieldId, field.id);
    assert.equal(outlook.provider, PROVIDER);
    assert.equal(outlook.model, MODEL);
    assert.equal(outlook.firstMonth, FIRST_MONTH);
    assert.equal(outlook.unit, "mm");
    assert.equal(outlook.months.length, 12);

    assert.deepEqual(
      outlook.months.map((month) => month.leadMonth),
      [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    );
    assert.deepEqual(
      outlook.months.map((month) => month.month),
      [
        "2026-11-01",
        "2026-12-01",
        "2027-01-01",
        "2027-02-01",
        "2027-03-01",
        "2027-04-01",
        "2027-05-01",
        "2027-06-01",
        "2027-07-01",
        "2027-08-01",
        "2027-09-01",
        "2027-10-01",
      ],
    );

    for (const month of outlook.months.slice(0, 7)) {
      assert.equal(month.valueMm, null, `lead ${month.leadMonth} has no source in this build`);
      assert.equal(month.dataClass, null);
      assert.equal(month.estimator, null);
      assert.equal(month.derivationVersion, null);
      assert.equal(month.missingReason, "not_requested");
      assert.equal(month.unit, "mm");
    }

    for (const [index, [month, valueMm]] of CLIMATOLOGY_MONTHS.entries()) {
      const served = outlook.months[7 + index];
      assert.equal(served.leadMonth, 8 + index);
      assert.equal(served.month, month);
      assert.equal(served.valueMm, valueMm);
      assert.equal(served.dataClass, "climatology");
      assert.equal(served.evaluationBasis, "climatology");
      assert.equal(served.missingReason, "beyond_horizon");
      assert.equal(served.baselineVersion, BASELINE_VERSION);
      assert.equal(served.derivationVersion, DERIVATION_VERSION);
      // The Q-P5-7 estimator, named rather than inferred from the class.
      assert.equal(served.estimator, "climatological_mean");
      assert.equal(served.unit, "mm");
      assert.equal(served.ensembleSpreadMm, null);
      assert.equal(served.spreadUnavailableReason, "climatology_has_no_ensemble");
    }
  });

  it("never serves zero for a month with no stored normal", async () => {
    const field = await createField(alice, (await createFarm(alice)).id, ELSEWHERE);
    const cellId = await mintCell(alice, field.id);
    assert.equal(await cellIdOf(OTHER_CELL_KEY), cellId);
    // Leads 9 and 11 are seeded; 8, 10, and 12 are not.
    await seedClimatologyMonth(cellId, CLIMATOLOGY_MONTHS[1]);
    await seedClimatologyMonth(cellId, CLIMATOLOGY_MONTHS[3]);

    const { response, body } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const band = body.data.months.slice(7);
    assert.deepEqual(
      band.map((month) => month.valueMm),
      [null, CLIMATOLOGY_MONTHS[1][1], null, CLIMATOLOGY_MONTHS[3][1], null],
    );
    // A gap in the baseline is absence, not a failure and not a zero.
    for (const month of [band[0], band[2], band[4]]) {
      assert.equal(month.dataClass, null);
      assert.equal(month.missingReason, "pending");
      assert.notEqual(month.valueMm, 0);
    }
  });

  it("serves the active row and never a superseded one", async () => {
    const field = await createField(alice, (await createFarm(alice)).id, ELSEWHERE);
    const cellId = await mintCell(alice, field.id);

    const activeId = await seedClimatologyMonth(cellId, ["2027-06-01", 111.5]);
    const superseded = await harness.owner.$queryRawUnsafe(
      `INSERT INTO app.monthly_outlooks
         (outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
          missing_reason, baseline_version, derivation_version, input_refs,
          input_snapshot_hash, spread_unavailable_reason, status, superseded_by_id)
       VALUES ($1::uuid, 'precipitation', '2027-06-01'::date, 'climatology', 'climatology',
               999.5, 'beyond_horizon', $2, $3, '[]'::jsonb, $4,
               'climatology_has_no_ensemble', 'superseded', $5::uuid)
       RETURNING id::text AS id`,
      cellId,
      BASELINE_VERSION,
      DERIVATION_VERSION,
      HASH,
      activeId,
    );
    assert.match(superseded[0].id, UUID);

    const { response, body } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));

    const june = body.data.months[7];
    assert.equal(june.valueMm, 111.5);
    assert.equal(
      body.data.months.some((month) => month.valueMm === 999.5),
      false,
      "the superseded value is not served",
    );
  });

  it("returns the outlook without writing a cell, an outlook row, or a mapping", async () => {
    const field = await createField(alice, (await createFarm(alice)).id, ELSEWHERE);
    await mintCell(alice, field.id);

    const before = await harness.owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM app.outlook_cells WHERE model = $1) AS cells,
              (SELECT count(*)::int FROM app.monthly_outlooks WHERE outlook_cell_id IN
                 (SELECT id FROM app.outlook_cells WHERE model = $1)) AS outlooks,
              (SELECT count(*)::int FROM app.field_outlook_cells WHERE user_id = $2::uuid) AS mappings`,
      MODEL,
      alice.id,
    );

    const { response } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 200);

    const after = await harness.owner.$queryRawUnsafe(
      `SELECT (SELECT count(*)::int FROM app.outlook_cells WHERE model = $1) AS cells,
              (SELECT count(*)::int FROM app.monthly_outlooks WHERE outlook_cell_id IN
                 (SELECT id FROM app.outlook_cells WHERE model = $1)) AS outlooks,
              (SELECT count(*)::int FROM app.field_outlook_cells WHERE user_id = $2::uuid) AS mappings`,
      MODEL,
      alice.id,
    );
    assert.deepEqual(after[0], before[0], "the read path writes nothing");
  });

  it("serves no value at all for a field whose cell has never been materialised", async () => {
    // A third node, minted but never aggregated.
    const field = await createField(alice, (await createFarm(alice)).id, {
      type: "Polygon",
      coordinates: [
        [
          [115.2, -1.2],
          [115.3, -1.2],
          [115.3, -1.1],
          [115.2, -1.1],
          [115.2, -1.2],
        ],
      ],
    });
    await mintCell(alice, field.id);

    const { response, body } = await getOutlook(alice, { fieldId: field.id });
    assert.equal(response.status, 200, JSON.stringify(body));
    assert.equal(body.data.months.length, 12);
    assert.equal(
      body.data.months.every((month) => month.valueMm === null),
      true,
    );
    assert.equal(
      body.data.months.every((month) => month.estimator === null),
      true,
    );
  });
});
