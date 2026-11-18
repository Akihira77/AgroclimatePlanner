# Open Decisions

Everything this specification **did not settle**, with what it blocks and what
information would settle it. An `OPEN` item is never implemented by guessing.

Severity describes **scope**, not urgency:

| Level | Means | Evidence required to assign it |
|---|---|---|
| **P0** | blocks Phase 3 as a whole — no part of the phase can be built | the blocking object is `app` itself: a migration that cannot apply, a role that cannot connect |
| **P1** | blocks one named subsystem, deliberately named; the rest of Phase 3 proceeds | a specific write path, job, or slice that cannot be written or cannot be correct |
| **P2** | can be settled during implementation of the item that needs it | the affected code is not on the Phase 3 path |

**No item in this list is currently P0.** Phase 3's deliverables are tables,
constraints, indexes, policies, and grants; all of them can be created today,
which is exactly why the severity of every blocker below is P1 with a named
subsystem rather than a phase-wide stop. A blocker is never widened to P0 to
signal that it matters — `OPEN-01` matters a great deal and still does not stop
a migration from applying.

Nothing in this list is a design preference. Each one is a question where a
plausible answer exists and choosing it silently would put an unapproved decision
into a normative schema.

## 1. The four subsystem blockers

### 1.1 Matrix (authoritative)

This table is the single source for "what is blocked and by what". Every other
document that mentions a blocker points here rather than restating it.

| ID | Severity | What is unresolved | Blocked | Can proceed independently |
|---|---|---|---|---|
| `OPEN-01` | **P1** | how a credential is read before a tenant context exists | the authentication slice — login, session issuance, and therefore every authenticated request | table creation, catalog, weather plane, all RLS policies and grants |
| `OPEN-17` | **P1** | what `areaHa` means for a `POINT`-shaped field | field snapshots for **point-shaped** fields, and every artifact derived from one | table creation; `POLYGON`/`MULTIPOLYGON` fields end to end |
| `OPEN-26` | **P1** | the six-check `EvidenceSegment` partition validator | the `planting_windows` **write** path only | table creation, the index, every read path, `suitability_runs`, `ai_briefings` |
| `OPEN-27` | **P1** | how the worker learns which fields a cell serves | `recompute.windows` — the job that delivers a new forecast to a dashboard | table creation, ingestion, aggregation, the catalog, per-tenant recompute triggered from the request path |

Reading the matrix:

- **`OPEN-01` does not block Phase 3**, because Phase 3 ships no authentication.
  It blocks the first authenticated request in Phase 3's *auth slice*, and it is
  the reason that slice cannot be started.
- **`OPEN-17` is narrower than it first appears.** Only a point-shaped field has
  `area_ha = 0`; a polygon field is unaffected. It escalates to **P0** if the
  product makes point-shaped fields a v1 requirement, because then field
  creation itself — the first thing every user does — is on the critical path.
- **`OPEN-26` is a write-path blocker, not a read or schema blocker.** The
  database cannot express the partition invariant, so it is enforced nowhere
  until the validator exists; the table, its columns, and its checks are
  unaffected.
- **`OPEN-27` is a worker blocker.** The table and its index are correct; the
  credential that would query them is not.

### 1.2 `OPEN-01` — the authentication lookup — **P1**

The read that happens before a tenant context exists. `app_api` has no grant on
`app.users`; the table has `FORCE` RLS; `app.user_id` is only set inside
`withTenant`, which requires knowing the user. "Authenticate, then open a scope"
is not buildable from the current schema.

Options and their costs are in `ownership-and-rls.md` §5 (dedicated `auth` role ·
`SECURITY DEFINER` function · column grant + second GUC). The first is
recommended, none is chosen.

**Blocks:** the authentication slice — login, session issuance, and therefore
every authenticated request. It does **not** block table creation, the catalog,
the weather plane, or any RLS policy.
**Would be settled by:** a decision
on whether to add a fourth role, which is a bootstrap-script change requiring
review of its own.

### 1.3 `OPEN-17` — `area_ha` for a `POINT` field — **P1**

`fields.area_ha` is a stored generated column
`ST_Area(geom::geography) / 10000.0`, which is **`0`** for a point.
`FieldSnapshotPayload.areaHa` is `z.number().positive()`. A point-shaped field
therefore cannot produce a valid field snapshot, and every artifact derived from
it is impossible to create. A polygon field is unaffected.

Three options: (a) disallow `POINT` — drop it from `fields_geom_type_check`;
(b) make `areaHa` nullable for point fields — a contract change, so an ADR;
(c) derive an assumed area from a declared radius — invents a number the user did
not supply. **None is chosen, and no estimated area is assumed for a point.**

**Blocks:** field snapshot creation for a point-shaped field, and therefore every
artifact derived from one. It does **not** block table creation, a polygon field,
or any subsystem that never handles a `POINT`.
**Severity note:** P1 while point fields are optional; **P0 if the product
requires them**, because then the first action a user takes is on the critical
path. Nothing in the current documents establishes that requirement.
**Would be settled by:** whether the product supports "I do not know my plot
boundary" as a first-class case.

### 1.4 `OPEN-27` — the recompute fan-out cannot query tenant rows — **P1**

Q18 ("which fields does this cell serve?") reads `field_outlook_cells`, which is
tenant-owned and RLS-protected, while the job that needs the answer runs as
`app_system`, which has no grant on it — and if it were granted one, its
`BYPASSRLS` would expose every tenant's resolutions.

Options: narrow `SELECT` to `app_system` (widest exposure) · a `SECURITY DEFINER`
function returning only field ids (narrow output, one privileged entry point) · a
global "cell → interested field" projection table (duplicates state, can drift).

**Blocks:** `recompute.windows`, i.e. the one job that makes a new forecast reach
a user's dashboard. **Would be settled by:** a decision on the narrowest
acceptable shape, in a follow-up ADR that does not yet exist (an earlier draft of
this document pointed at `ADR-004`; no such file exists and none is written).

### 1.5 `OPEN-26` — no `evidence_segments` partition validator — **P1**

Six interval checks (no overlap, no gap, full span, internal contiguity, reason
presence, coverage reconciliation) have no implementation. The database cannot
enforce them (`provenance-storage.md` §4), and `provenance-contract.md` §4 states
the validator does not exist. `jsonb_typeof(evidence_segments) = 'array'` is the
only check the schema performs, and it says nothing about interval algebra.

**Blocks:** the `planting_windows` write path. A window with a broken partition
is currently storable, and once the write path exists it must be impossible for
an invalid partition to be persisted as a valid recommendation.
**Would be settled by:** writing the validator, which belongs with the engine that
produces segments, not with the schema. Not implemented in this phase.

## 2. Other subsystem-scoped open items

### `OPEN-21` — field vocabularies and the `irrigationAvailable` mapping — **P1**

`fields.soil_type`, `drainage_class`, `irrigation_availability` are text with no
vocabulary; `FieldSnapshotPayload.irrigationAvailable` is a **boolean**. No
document defines the conversion, so the mapping is unowned — and a wrong one
silently changes every window's `fieldSnapshotHash` and every water-dependent
verdict. Options: a lookup table, a `CHECK` list, or a boolean column.

**Blocks:** field → snapshot construction. This is the most consequential open
item in the identity group.

### `OPEN-09` — `plantings.status` vocabulary — **P1**

No enum is written anywhere. `plantings_active_idx` assumes a value spelled
`active`. Options: `active` · `harvested` · `failed` · `abandoned`.
**Blocks:** the partial index and the "what is growing here" query.

### `OPEN-18` — `cell_key` rounding rule per model — **P1**

`outlook_cells.cell_key` is `text` because the rounding rule is per model, and
`ADR-001` D6 says "a fixed, documented rounding rule per model" — but **no model's
rule is written down**. Phase 3's write path needs it to insert a cell identity
before any ingest exists.

**Blocks:** field→cell resolution for any model whose rule is undefined.
**Would be settled by:** the rounding rule for each of the five grids, derived
from their published resolutions.

### `OPEN-02` — BMKG written permission — **P1**

Not obtained. `BMKG_SHORT_RANGE_ENABLED` defaults off. Nothing in this schema
depends on BMKG; the 0–3 d band falls back to Open-Meteo, correctly labelled.

### `OPEN-03` — Open-Meteo plan — **P1**

The free tier is non-commercial only. Whether production is commercial decides
whether the plan must be paid or self-hosted, and self-hosting's bucket terms are
undocumented. Affects `raw_payload_ref` retention and deployment legality, not
the schema.

### `OPEN-05` — raw payload retention — **P1**

Per-provider licensing (`lifecycle-and-retention.md` §2). Determines whether
`reproducible` can be `true` for artifacts built on a given provider.

### `OPEN-11` — the briefing body contract — **P1**

`ai_briefings.body` is validated against the `ClimateBriefing` contract, whose
shape is not defined anywhere. The table can be created; the row cannot be
validated. **Blocks:** the AI slice only.

### `OPEN-13` — session storage — **P1**

Redis vs a table. A table would be a 23rd entity in this model with its own
retention; Redis would not appear here at all. **Blocks:** auth (with `OPEN-01`).

### `OPEN-04` — account deletion — **P1**

Three options in `lifecycle-and-retention.md` §1. Only anonymisation preserves
provenance. **Blocks:** a GDPR-shaped request path and the `users` unique index
design.

### `OPEN-28` — signed tenant context — **P1**

`ADR-003` A2: HMAC over `user_id`, verified in the policy. The only mitigation
against a leaked `app_api` DSN that reads every tenant. Deferred; becomes required
if that threat is in scope before production.

## 3. Settle during implementation

| ID | Question | Effect |
|---|---|---|
| `OPEN-06` | `cultivars.photoperiod_sensitivity` representation | a real agronomic property with no type; unused until settled |
| `OPEN-07` | what a `window` comparator compares | `constraints` **rejects** `comparator = 'window'` until it exists |
| `OPEN-08` | `growth_stages.requirement_profile` type | currently unconstrained text |
| `OPEN-10` | `crops.category` vocabulary | unconstrained text; no code may branch on it |
| `OPEN-12` | verification/scoring tables (skill metrics, `forecast_scores`) | no table specified; blocks Phase 9, not Phase 3 |
| `OPEN-14` | `temporal_resolution` / `aggregation_level` vocabulary | enum values named but not frozen |
| `OPEN-15` | the `area_weighted` weight set | the resolution row cannot describe multi-cell weighting; `centroid` is the v1 policy |
| `OPEN-16` | `weather_records` growth/retention policy | ~56 000 rows per ensemble run; first real at Phase 4 |
| `OPEN-19` | `updated_at` trigger | application-maintained today; raw SQL bypasses it |
| `OPEN-20` | v1 catalog seed scope | which graded thresholds ship in the first published profiles |
| `OPEN-22` | `fields_geom_gist_idx` justification | no query uses it; drop or keep at Phase 6 |
| `OPEN-23` | `cultivars.cycle_start` vs `plantings.cycle_start_used` disagreement | application invariant, not a database one |
| `OPEN-24` | `constraints.growth_stage_id` may name a stage of another profile | one composite FK + one unique key |
| `OPEN-25` | supersession cycles | not prevented; a looping chain is a writer bug |
| `OPEN-29` | `observationsUsed` embeds ids, not values | an edited observation does not change `fieldSnapshotHash` |

## 4. Decisions made here

Binding for Phase 3, revisable through review, never silently. Each is recorded
in the document that makes it.

| ID | Decision | Where |
|---|---|---|
| `D1` | `field_outlook_cells` holds the field-specific half; provider-grid facts live in `outlook_cells` | `tables-identity.md` §4 |
| `D2` | `monthly_outlooks` is global per cell, not tenant-owned | `tables-climate.md` §5 |
| `D3` | every instant is `timestamptz(6)`; no naive timestamp | `physical-model.md` §3 |
| `D4` | month keys are `date` constrained to the first of the month | `physical-model.md` §3 |
| `D5` | `crop_profile_versions` is immutable after publication: no `UPDATE` grant + a specified trigger | `tables-catalog.md` §3 |
| `D6` | constraints use `threshold_lower`/`threshold_upper`/`threshold_count`, not a single `value` | `tables-catalog.md` §5 |
| `D7` | `field_observations.entered_by` must equal `user_id` in v1 | `tables-identity.md` §5 |
| `D8` | enums are `text` + named `CHECK`, never PostgreSQL `enum` types | `physical-model.md` §5 |
| `D9` | hashes are `text` lowercase hex with a shape `CHECK`, never `bytea` | `physical-model.md` §6 |
| `D10` | JSONB only for documents that are a hash preimage | `physical-model.md` §7 |
| `D11` | `created_at` everywhere; `updated_at` on mutable tables; `deleted_at` on `farms`/`fields` only | `physical-model.md` §8 |
| `D12` | `raw_payload_ref` is an object-store key, populated only where the licence permits | `lifecycle-and-retention.md` §2 |
| `D13` | the catalog is seeded by `migration_owner`; runtime roles hold no write grant | `ownership-and-rls.md` §2 |
| `D14` | `app_api` may insert an `outlook_cells` identity triple and nothing else (column grant) | `ownership-and-rls.md` §2 |
| `D15` | every tenant→tenant edge is a composite `(id, user_id)` FK | `relationships.md` §2 |
| `D16` | no `ON DELETE CASCADE` anywhere | `relationships.md` §2 |
| `D17` | "one live row" invariants are partial unique indexes | `indexes-and-query-patterns.md` §3 |
| `D18` | `weather_records_live_key` uses `NULLS NOT DISTINCT` | `indexes-and-query-patterns.md` §3 |
| `D19` | status and `superseded_by_id` must agree, per table | `relationships.md` §5 |
| `D20` | `field_snapshot` is stored whole on `suitability_runs` only; other tables carry the hash | `provenance-storage.md` §3 |
| `D21` | `evidenceSegments` is a canonical `sequence`; `missing_ranges` is a `set` | `provenance-storage.md` §4 |
| `D22` | `geometryHash` is `sha256` of the stored EWKB, with no normalisation | `spatial-model.md` §6 |
| `D23` | harvest is per picking event — many per planting; yield is aggregated at read time | `tables-identity.md` §7 |
| `D24` | `weather_records` stores only the four forecast classes; observations, climatology, and verification truth have other homes | `tables-climate.md` §4 |
| `D25` | the suitability vocabulary is `suitable`/`conditional`/`unsuitable`/`insufficient_data`; `poor` is gone | `tables-derived.md` §2 |
