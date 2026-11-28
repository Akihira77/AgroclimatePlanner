/**
 * Phase 8 ai_briefings persistence, atomic supersession, cache lookup, and
 * RLS cross-tenant isolation against real PostgreSQL.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import { hashDerivationDescriptor, hashFieldSnapshot } from "@agroclimate/contracts";
import { Client } from "pg";

import {
  createFarm,
  createField,
  createPrismaClient,
  createTenantScope,
  findCachedAiBriefing,
  findLatestAiBriefing,
  loadFieldSnapshotSource,
  persistAiBriefing,
  persistSuitabilityRunWithWindows,
} from "../../dist/index.js";
import { roleConnectionString } from "../../scripts/lib/connections.mjs";

const owner = new Client({ connectionString: roleConnectionString("migration_owner") });
const api = createPrismaClient({
  connectionString: roleConnectionString("app_api"),
  poolMax: 1,
});
const scope = createTenantScope(api);

const SQUARE = {
  type: "Polygon",
  coordinates: [
    [
      [106.8, -6.2],
      [106.9, -6.2],
      [106.9, -6.1],
      [106.8, -6.1],
      [106.8, -6.2],
    ],
  ],
};

const cleanup = { users: [], farms: [], fields: [] };
let cropId;
let cultivarId;
let profileVersionId;
let ownCatalog = false;

async function createUser(label) {
  const { rows } = await owner.query(
    "INSERT INTO app.users (email, password_hash) VALUES ($1, 'x') RETURNING id::text AS id",
    [`briefings-${label}-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`],
  );
  cleanup.users.push(rows[0].id);
  return rows[0].id;
}

before(async () => {
  await owner.connect();
  const { rows } = await owner.query(
    `SELECT cpv.id::text AS profile_version_id,
            c.id::text AS cultivar_id,
            c.crop_id::text AS crop_id
       FROM app.crop_profile_versions cpv
       JOIN app.cultivars c ON c.id = cpv.cultivar_id
      WHERE cpv.status = 'published'
      ORDER BY cpv.created_at ASC
      LIMIT 1`,
  );

  if (rows.length > 0) {
    profileVersionId = rows[0].profile_version_id;
    cultivarId = rows[0].cultivar_id;
    cropId = rows[0].crop_id;
  } else {
    ownCatalog = true;
    const cropRows = await owner.query(
      `INSERT INTO app.crops (slug, name_id, name_en, category)
       VALUES ($1, 'Padi Briefing DB', 'Briefing DB Rice', 'pangan')
       RETURNING id::text AS id`,
      [`briefing-db-rice-${Date.now()}`],
    );
    cropId = cropRows[0].id;
    const cultRows = await owner.query(
      `INSERT INTO app.cultivars (crop_id, name, duration_days_min, duration_days_typical, duration_days_max, cycle_start)
       VALUES ($1::uuid, 'Ciherang Briefing', 110, 115, 120, 'transplant')
       RETURNING id::text AS id`,
      [cropId],
    );
    cultivarId = cultRows[0].id;
    const profRows = await owner.query(
      `INSERT INTO app.crop_profile_versions (cultivar_id, rule_version, status)
       VALUES ($1::uuid, 'briefing-db-v1', 'published')
       RETURNING id::text AS id`,
      [cultivarId],
    );
    profileVersionId = profRows[0].id;
  }
});

after(async () => {
  for (const fieldId of cleanup.fields) {
    await owner.query("DELETE FROM app.ai_briefings WHERE field_id = $1::uuid", [fieldId]);
    await owner.query("DELETE FROM app.planting_windows WHERE field_id = $1::uuid", [fieldId]);
    await owner.query("DELETE FROM app.suitability_runs WHERE field_id = $1::uuid", [fieldId]);
    await owner.query("DELETE FROM app.fields WHERE id = $1::uuid", [fieldId]);
  }
  for (const farmId of cleanup.farms) {
    await owner.query("DELETE FROM app.farms WHERE id = $1::uuid", [farmId]);
  }
  for (const userId of cleanup.users) {
    await owner.query("DELETE FROM app.users WHERE id = $1::uuid", [userId]);
  }
  if (ownCatalog) {
    await owner.query("DELETE FROM app.crop_profile_versions WHERE id = $1::uuid", [
      profileVersionId,
    ]);
    await owner.query("DELETE FROM app.cultivars WHERE id = $1::uuid", [cultivarId]);
    await owner.query("DELETE FROM app.crops WHERE id = $1::uuid", [cropId]);
  }
  await api.$disconnect();
  await owner.end();
});

describe("ai_briefings persistence and RLS isolation", () => {
  it("persists, caches, supersedes cleanly, and enforces cross-tenant RLS isolation", async () => {
    const alice = await createUser("alice");
    const bob = await createUser("bob");

    const { field, run } = await scope.withTenant(alice, async (tx) => {
      const farm = await createFarm(tx, { name: "Kebun Briefing", regionLabel: "Jabar" });
      cleanup.farms.push(farm.id);
      const createdField = await createField(tx, farm.id, {
        name: "Petak Briefing",
        geometry: SQUARE,
        irrigationAvailability: "rainfed",
      });
      cleanup.fields.push(createdField.id);
      const src = await loadFieldSnapshotSource(tx, createdField.id);
      const payload = {
        fieldId: src.fieldId,
        geometryHash: src.geometryHash,
        areaHa: src.areaHa,
        elevationM: src.elevationM,
        soilType: src.soilType,
        soilPh: src.soilPh,
        drainageClass: src.drainageClass,
        irrigationAvailability: src.irrigationAvailability ?? "unknown",
        irrigationSource: src.irrigationSource,
        extractionPolicy: "centroid",
        resolvedCells: [...src.resolvedCells],
        observationsUsed: [...src.observationsUsed],
      };
      const fieldSnapshotHash = hashFieldSnapshot(payload);
      const inputRefs = [
        {
          kind: "baseline",
          role: "climatology",
          purpose: "input",
          baselineVersion: "1991-2020-v1",
          baselineHash: "a".repeat(64),
          cellKeys: ["cell-1"],
        },
      ];
      const runInputHash = hashDerivationDescriptor({
        artifact: "suitability_run",
        inputRefs,
        fieldSnapshotHash,
        profileVersionId,
        engineVersion: "0.1.0",
        derivationVersion: "1",
      });
      const persistedRun = await persistSuitabilityRunWithWindows(tx, {
        fieldId: createdField.id,
        profileVersionId,
        engineVersion: "0.1.0",
        derivationVersion: "1",
        dimensionCoverage: [{ dimension: "water", state: "known" }],
        maxAchievableLevel: "A",
        inputRefs,
        fieldSnapshot: { ...payload, fieldSnapshotHash },
        fieldSnapshotHash,
        inputSnapshotHash: runInputHash,
        reproducible: false,
        unreproducibleReason: "raw_payload_not_retained",
        windows: [
          {
            cropId,
            cultivarId,
            profileVersionId,
            windowStart: "2026-12-01",
            windowEnd: "2027-03-01",
            evaluationBasis: "climatology",
            primaryBasis: "climatology",
            mixedEvidence: false,
            weakestEvidenceClass: "climatology",
            evidenceSegments: [
              {
                startDate: "2026-12-01",
                endDate: "2027-03-01",
                evaluationBasis: "climatology",
                evidenceClass: "climatology",
                coveragePercent: 100,
                provenance: { kind: "climatology", baselineVersion: "1991-2020-v1" },
              },
            ],
            missingRanges: [],
            suitability: "conditional",
            score: null,
            risks: [],
            explanations: [{ code: "climatology_only", detail: "Klimatologi" }],
            constraintsEvaluated: [],
            missingInputs: [],
            inputRefs,
            fieldSnapshotHash,
            inputSnapshotHash: runInputHash,
            reproducible: false,
            unreproducibleReason: "raw_payload_not_retained",
          },
        ],
      });
      return { field: createdField, run: persistedRun };
    });

    const inputHash = hashDerivationDescriptor({
      artifact: "ai_briefing",
      inputRefs: [...run.inputRefs],
      fieldSnapshotHash: run.fieldSnapshotHash,
      sourceArtifactHashes: [run.inputSnapshotHash],
      promptVersion: "briefing-v1",
      modelId: "deterministic-template/1",
      derivationVersion: "1",
    });

    const body1 = {
      summary: "Ringkasan pertama.",
      weatherInterpretation: "Klimatologi historis.",
      suitabilityExplanation: "Status bersyarat.",
      riskHighlights: [],
      missingDataCaveats: [],
      evidenceSegmentIds: ["2026-12-01:2026-12-01..2027-03-01:climatology"],
      questionAnswer: null,
      sourceMode: "deterministic_fallback",
    };

    const first = await scope.withTenant(alice, (tx) =>
      persistAiBriefing(tx, {
        fieldId: field.id,
        suitabilityRunId: run.id,
        body: body1,
        narrationStatus: "generated",
        modelId: "deterministic-template/1",
        promptVersion: "briefing-v1",
        derivationVersion: "1",
        inputRefs: run.inputRefs,
        fieldSnapshotHash: run.fieldSnapshotHash,
        sourceArtifactHashes: [run.inputSnapshotHash],
        inputSnapshotHash: inputHash,
        reproducible: false,
        unreproducibleReason: "fallback_template",
      }),
    );

    assert.equal(first.status, "active");
    assert.equal(first.supersededById, null);

    const cached = await scope.withTenant(alice, (tx) =>
      findCachedAiBriefing(tx, field.id, inputHash),
    );
    assert.equal(cached?.id, first.id);

    const second = await scope.withTenant(alice, (tx) =>
      persistAiBriefing(tx, {
        fieldId: field.id,
        suitabilityRunId: run.id,
        body: { ...body1, summary: "Ringkasan kedua." },
        narrationStatus: "generated",
        modelId: "deterministic-template/1",
        promptVersion: "briefing-v1",
        derivationVersion: "1",
        inputRefs: run.inputRefs,
        fieldSnapshotHash: run.fieldSnapshotHash,
        sourceArtifactHashes: [run.inputSnapshotHash],
        inputSnapshotHash: inputHash,
        reproducible: false,
        unreproducibleReason: "fallback_template",
      }),
    );

    assert.notEqual(second.id, first.id);
    assert.equal(second.status, "active");

    const latest = await scope.withTenant(alice, (tx) => findLatestAiBriefing(tx, field.id));
    assert.equal(latest?.id, second.id);

    const { rows: history } = await owner.query(
      "SELECT status, superseded_by_id::text AS superseded_by_id FROM app.ai_briefings WHERE id = $1::uuid",
      [first.id],
    );
    assert.equal(history[0].status, "superseded");
    assert.equal(history[0].superseded_by_id, second.id);

    const bobLatest = await scope.withTenant(bob, (tx) => findLatestAiBriefing(tx, field.id));
    assert.equal(bobLatest, null);

    await assert.rejects(() =>
      scope.withTenant(bob, (tx) =>
        persistAiBriefing(tx, {
          fieldId: field.id,
          suitabilityRunId: run.id,
          body: body1,
          narrationStatus: "generated",
          modelId: "deterministic-template/1",
          promptVersion: "briefing-v1",
          derivationVersion: "1",
          inputRefs: run.inputRefs,
          fieldSnapshotHash: run.fieldSnapshotHash,
          sourceArtifactHashes: [run.inputSnapshotHash],
          inputSnapshotHash: inputHash,
          reproducible: false,
          unreproducibleReason: "fallback_template",
        }),
      ),
    );
  });
});
