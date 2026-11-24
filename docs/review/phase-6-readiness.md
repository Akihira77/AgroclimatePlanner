# Phase 6 readiness — Agronomic Suitability & Planting Window Engine

**Status:** planning and readiness assessment only. No Phase 6 runtime, contract, migration,
seed, or route is implemented by this document. It records what the repository already has,
what is missing, which work can start safely, and which work must wait for an owner decision.
Baseline: `master` @ `7d96256`, clean working tree.

Phase 5 is **not complete** (§5.7's seasonal half and §5.8 remain), so this is a readiness
map, not a kickoff.

---

## 1. Official definition

`docs/PROJECT.md` §3 names Phase 6 as the **agronomic engine**: stage-aligned suitability,
planting windows, and explanations. Its scope is bounded by the same document:

- four crops — padi, jagung, kedelai, cabai — with kedelai and cabai carrying
  `water = insufficient_data`;
- 0–14 d daily, 15–45 d subseasonal, months 2–7 seasonal, remaining months climatology.
  **Note:** the seasonal band is stated three ways in the repository — "months 2–7" here,
  `MONTHLY_OUTLOOK_BANDS` at leads 1–7, and "lead months 3–7" in
  `climate-data-foundation.md` §8.9. The engine must not pick one silently; see §8.7C
  decision 3 of that document;
- planting windows with per-dimension explanation;
- no yield prediction, price data, or 12-month daily forecast.

`docs/research/agronomic-reference-matrix.md` §6 is the structural specification: constraint
types differ per crop, `insufficient_data` is per dimension, and the engine is four
computations rather than one precision switch.

---

## 2. What already exists (verified)

| Piece | Evidence | State |
|---|---|---|
| Crop/profile/suitability/window DDL | `packages/database/prisma/migrations/20261118030000_domain_tables/migration.sql:52,70,107,154,184,871,909,1007,1075`; Prisma models `schema.prisma:178,198,227,256,280,646,674,697,741` | **Exists.** `crops`, `cultivars`, `crop_profile_versions`, `growth_stages`, `constraints`, `plantings`, `harvests`, `suitability_runs`, `planting_windows` |
| Versioned-profile and live-run invariants | `crop_profile_versions_one_published_key`, `growth_stages_one_critical_key`, `suitability_runs_live_key`, `planting_windows_live_idx` (SQL-only partial indexes) | **Exists** |
| Provenance shapes | `packages/contracts/src/provenance.ts`: `fieldSnapshotPayloadSchema`, `evidenceSegmentSchema`, `missingRangeSchema`, `DataInputRef`, derivation descriptors for `suitability_run` / `planting_window`; `hashFieldSnapshot`, `hashDerivationDescriptor` (`hash.ts`) | **Exists** |
| Run provenance columns | `suitability_runs`: `engine_version`, `derivation_version`, `field_snapshot` (jsonb), `field_snapshot_hash`, `input_snapshot_hash`, `input_refs`, `dimension_coverage`, `max_achievable_level`, supersession chain (`schema.prisma:704-714`) | **Exists** |
| Evaluation bases | `evaluationBasisSchema` = `daily \| weekly \| monthly \| climatology \| mixed`; single-value variant excludes `mixed` (`packages/contracts/src/enums.ts:28,31-37`) | **Exists as vocabulary**, no cross-cutting day→basis mapping |
| Climate input | `GET /v1/climate/outlook` returns 12 labelled months, climatology-only today (`apps/api/src/climate/`, 5.7B) | **Exists, partial** |
| Field anchor | `selectFieldAnchor` returns the six-decimal centroid inside `withTenant` (`packages/database/src/fields.ts`) | **Exists** |
| Agronomic evidence | `docs/research/agronomic-reference-matrix.md`, evidence date 2026-11-18 | **Documented, citations unresolved** |

## 3. What does not exist (verified)

| Gap | Evidence |
|---|---|
| Crop catalog rows | **0 rows.** No `INSERT INTO app.crops` in any migration; no Prisma seed file; no `seed` script (`packages/database/prisma/`, root `package.json`) |
| Contracts for catalog/suitability/window payloads | No zod schema for Crop, Cultivar, CropProfileVersion, GrowthStage, Constraint, SuitabilityRun, PlantingWindow, Planting, or Harvest; `grep crop\|cultivar\|profile` in `farm.ts`/`field.ts`/`contracts/index.ts` returns nothing |
| Agronomy package | No `packages/agronomy`; workspace packages are `contracts`, `weather-core`, `climate-core`, `database` |
| Pure evaluation code | No constraint evaluation, scoring, stage alignment, or window generation anywhere in `apps/` or `packages/` |
| Suitability/planting routes | API modules are `auth`, `farm`, `field`, `climate`, `health` only |
| EvidenceSegment partition validator (`OPEN-26`) | Not implemented; only `jsonb_typeof(input_refs)='array'` in SQL. Blocks the `planting_windows` write path |
| Worker field→cell query (`OPEN-27`) | No `app_system` grant on `field_outlook_cells`; only `app_api` holds DML. Blocks `recompute.windows` |
| Production climate inputs | `OPEN-18`: no validated provider grid; `OPEN-03`: no commercial ingestion; `OPEN-05`: no raw payload retention |

---

## 4. Evidence rules the engine must obey

From `agronomic-reference-matrix.md` §5–§6:

| Grade | What it is | Permitted use |
|---|---|---|
| **A** | official institution (Kementan/BRMP/Balitsa/BBSDLP/SOP, IRRI, FAO-56, CIMMYT, NSW DPI) | hard constraint eligible |
| **B** | peer-reviewed journal | soft score |
| **C** | thesis / university repository / extension page quoting a primary source | soft factor with a recorded caveat; **never** a hard gate |
| **D** | secondary, popular, unverifiable | excluded |

Consequences already established, not to be re-litigated by an implementation:

1. **All four crops' monthly-rainfall thresholds are grade C**, so v1 has no hard rainfall
   gate. Hard constraints are limited to soil pH, flooding/drainage, paddy standing water,
   and the temperature stress windows sourced to IRRI/FAO/NSW DPI.
2. **Kedelai and cabai water = `insufficient_data`.** Their suitability caps at
   `conditional`; no proxy may be substituted.
3. **Paddy water needs the field's irrigation and drainage fields.** Missing them yields
   `insufficient_data`, never "poor".
4. **An unknown dimension caps the result.** No normalised score over only the known
   dimensions; an unknown hard-gated dimension makes the whole window `insufficient_data`.
5. **All four profiles need an agronomist review** before real planting recommendations.
   Experimental profiles must not be presented as authoritative.

---

## 5. Proposed sub-phase sequence

Validate each against the repository before starting it; this is a sequence proposal, not an
approval.

### 6.1 — Domain contracts and profile versioning

- Zod contracts for Crop, Cultivar, CropProfileVersion, GrowthStage, Constraint,
  SuitabilityRun row, PlantingWindow row, Planting, Harvest.
- Crop-cycle and growth-stage definitions with `durationDays: {min, max, typical}` and
  `criticalStages[]` day offsets; sowing vs transplant made explicit.
- Evidence metadata per threshold (grade, source, accessed date) and per-dimension
  coverage vocabulary.
- Entry condition: none beyond 5.x contracts. **Safe to begin with fixtures.**

### 6.2 — Deterministic constraint evaluation

- Pure functions: threshold comparison per constraint type (floor, band, ceiling,
  stage-indexed), hard vs soft, explicit `insufficient_data`.
- No I/O, no clock; byte-identical output for identical input.
- Entry condition: 6.1. **Safe to begin with fixtures.**

### 6.3 — Crop growth-stage alignment

- Map calendar dates to growth stages for both cycle-length extremes.
- Critical-stage windows (`criticalStages[]`) aligned to the evaluation calendar.
- Entry condition: 6.1. **Safe to begin with fixtures.**

### 6.4 — Climate evaluation across four bases

- 0–14 d daily, 15–45 d weekly/subseasonal, months 2–7 monthly/seasonal, months 8–12
  climatology — four computations, not one precision switch.
- Entry condition: 6.2–6.3, and a climate input whose class is honest. Reading
  climatology-only months is possible today; seasonal months are not materialised (`climate-data-foundation.md` §8.7C).

### 6.5 — Suitability scoring

- Dimension coverage (climate, water, soil, timing, risk), hard constraints, soft factors,
  missing evidence, `insufficient_data`.
- Never normalise across known dimensions only; never invent a missing value.
- Entry condition: 6.4.

### 6.6 — Planting-window generation

- Candidate windows, start/end dates, cycle constraints, confidence/evidence, reproducible
  ordering.
- Entry condition: 6.5 and the `OPEN-26` validator (a window must not be storable with a
  broken `evidenceSegments` partition).

### 6.7 — Persistence and provenance

- `SuitabilityRun` and `PlantingWindow` writers: engine version, derivation version, input
  refs, field snapshot, input snapshot hash, supersession.
- Entry condition: 6.6, `OPEN-26`, and the `field_outlook_cells` mapping
  (`OPEN-18`/`OPEN-27`) wherever a field→cell join is required.

### 6.8 — Integration and agronomic validation

- Unit, integration, evidence-backed fixtures; API and UI; agronomist review of the four
  profiles.
- Entry condition: 6.7 and reviewed profiles.

---

## 6. Safe versus blocked

**Can start without an owner decision** (fixtures only, explicitly synthetic):

- 6.1 contracts and versioned evidence metadata;
- 6.2 pure constraint evaluation;
- 6.3 stage alignment;
- provenance/hash shapes and their tests.

**Must wait:**

- Any production grid or field→cell resolution — `OPEN-18`.
- Any `planting_windows` write — `OPEN-26`.
- Any worker fan-out that needs to know which fields a cell serves — `OPEN-27`.
- Seasonal-month evaluation inputs — `climate-data-foundation.md` §8.7C.
- Catalog seeding — `OPEN-20` (v1 seed scope) and unresolved citations.
- Any real recommendation — agronomist review and `OPEN-21` field vocabularies.

**Blockers to record, not solve here:** `OPEN-18`, `OPEN-26`, `OPEN-27`, `OPEN-03`,
`OPEN-21`, `OPEN-17` (point-shaped fields), `OPEN-09` (planting-status vocabulary),
`OPEN-20` (catalog seed scope).

---

## 7. Recommended first milestone

**6.1 — domain contracts and profile versioning**, with synthetic fixtures only:

- no database write, no seed, no route;
- every fixture labelled synthetic and excluded from any production claim;
- acceptance is a contract test suite plus a documented mapping from each evidence grade to
  its permitted constraint severity.

It is the only Phase 6 milestone whose correctness does not depend on a provider grid, a
catalog seed, an owner threshold, or a seasonal outlook.

---

## 8. Non-goals of this assessment

- No full Phase 6 runtime.
- No crop catalog seed.
- No agronomic threshold invented or promoted.
- No change to Phase 5 numbering or status.
- No claim that any `suitability_runs` or `planting_windows` row can be written today.
