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
which is exactly why the severity of every item that blocks anything is P1 with a
named subsystem rather than a phase-wide stop. A blocker is never widened to P0 to
signal that it matters — `OPEN-01` matters a great deal and still does not stop
a migration from applying.

**The register is 29 items: 14 P1 and 15 P2.** The 14 are classified by what they
stop in §1.1 — one changes the Phase 3 DDL, twelve block a slice built on top of
it, and one blocks nothing because a labelled fallback already ships. The 15 P2
items are in §3 and block nothing in Phase 3 by definition.

Nothing in this list is a design preference. Each one is a question where a
plausible answer exists and choosing it silently would put an unapproved decision
into a normative schema.

## 1. The P1 register

### 1.1 Matrix (authoritative) — every P1 item, with what it stops

**Scope of this matrix, stated because the alternative is that a reader assumes it
means something else:** it lists **all 14 P1 items**, not a selection. It is the
complete P1 register, and it is the single source for "what is blocked and by
what". Every other document points here instead of restating it.

The `Applies` column separates the two things "P1" can mean here:

| Value | Means |
|---|---|
| **Phase 3 DDL** | the decision changes what the Phase 3 migration must literally contain, so that migration cannot be written correctly without it |
| **after Phase 3** | the decision blocks a slice built on top of Phase 3 — auth, snapshot, ingest, window write, worker, AI, lifecycle. Phase 3's 19 tables, constraints, indexes, policies, and grants are written without it |
| **not blocking** | a degraded or labelled path already exists; the decision improves a path, it does not stop one |

"Phase 3" here means the deliverables the phase tracker records: the 19 specified
tables, their constraints and indexes, the RLS policies, and the grants, as
hand-written SQL applied with `prisma migrate deploy`. No runtime write path is
part of it, which is why almost nothing below is `Phase 3 DDL`.

| ID | Sev | Category | Applies | What is unresolved | Blocked | Continues independently |
|---|---|---|---|---|---|---|
| `OPEN-09` | P1 | catalog vocabulary | **Phase 3 DDL** | whether the planting status vocabulary spells `active` | the `plantings.status` `DEFAULT` and `plantings_active_idx`, whose predicate names that literal — either would encode an unmade decision | the `plantings` table without a default, `harvests`, every other table and index |
| `OPEN-01` | P1 | authentication | after Phase 3 | how a credential is read before a tenant context exists | login, session issuance, and therefore every authenticated request | the DDL, the catalog, the weather plane, all RLS policies and grants |
| `OPEN-13` | P1 | authentication | after Phase 3 | where a session lives — Redis vs a table | session issuance and session read, together with `OPEN-01`; a table would add a 23rd entity | the DDL — this model contains no session table and does not need one |
| `OPEN-17` | P1 | field snapshot | after Phase 3 | what `areaHa` means for a `POINT`-shaped field | field snapshot creation for point-shaped fields, and every artifact derived from one | the DDL (a `POINT` row is still storable); `POLYGON`/`MULTIPOLYGON` fields end to end |
| `OPEN-21` | P1 | field snapshot | after Phase 3 | the `irrigationAvailable` boolean mapping and three field vocabularies | field → snapshot construction | the DDL — the columns stay unconstrained `text`; every non-snapshot path |
| `OPEN-18` | P1 | cell resolution | after Phase 3 | the `cell_key` rounding rule, per model | writing a cell identity, and field → cell resolution for any model whose rule is undefined | the DDL (`cell_key` is `text` for exactly this reason), the catalog, every query that reads an already-keyed cell |
| `OPEN-26` | P1 | window write | after Phase 3 | the six-check `EvidenceSegment` partition validator | persisting a `planting_windows` row | the table, its index, every read path, `suitability_runs`, `ai_briefings` |
| `OPEN-27` | P1 | worker | after Phase 3 | how the worker learns which fields a cell serves | `recompute.windows` — the job that delivers a new forecast to a dashboard | the DDL **and** the grants, which ship the documented default: no `app_system` grant on a tenant-owned table |
| `OPEN-11` | P1 | AI slice | after Phase 3 | the `ClimateBriefing` body shape | writing or validating an `ai_briefings` row | the `ai_briefings` DDL; the table is createable exactly as specified, it simply cannot yet hold a valid document |
| `OPEN-04` | P1 | identity lifecycle | after Phase 3 | the account-deletion policy | the deletion path and whether `users` gains a partial unique email index | the `users` DDL as implemented; registration; every read |
| `OPEN-03` | P1 | deployment / licensing | after Phase 3 | Open-Meteo paid plan vs self-host | production deployment legality and `raw_payload_ref` retention | the DDL; non-production use |
| `OPEN-05` | P1 | retention | after Phase 3 | per-provider raw payload retention | a `reproducible: true` claim for an artifact built on that provider | the DDL; artifacts stored with `reproducible: false` and a reason |
| `OPEN-02` | P1 | provider | **not blocking** | BMKG written permission | the 0–3 d BMKG band only, which already has a labelled Open-Meteo fallback | everything — no column, constraint, or query in this model references BMKG |
| `OPEN-28` | P1 | security hardening | after Phase 3 | whether signed tenant context (ADR-003 A2) is required | nothing, until a leaked `app_api` DSN is in scope | everything |

Reading the matrix:

- **Exactly one P1 item is a Phase 3 DDL blocker: `OPEN-09`.** `plantings.status`
  has a `DEFAULT 'active'` and `plantings_active_idx` filters on
  `status = 'active'`; both spell a value whose vocabulary is undecided
  (`tables-identity.md` §6, `indexes-and-query-patterns.md` §2). The migration can
  omit the default and the index, or it can decide the vocabulary. It cannot do
  neither and claim neither was chosen.
- **The four items previously listed alone here — `OPEN-01`, `OPEN-17`,
  `OPEN-26`, `OPEN-27` — are not Phase 3 DDL blockers either.** They were the
  four that block the *first slice that consumes a Phase 3 table*: auth, snapshot,
  window write, worker. That is a real and narrower claim, and it is the claim
  §1.2–§1.5 make, one entry each. Naming only them, without saying what the other
  ten block, is what made the earlier matrix look exhaustive when it was not.
- **`OPEN-17` is narrower than it first appears.** Only a point-shaped field has
  `area_ha = 0`; a polygon field is unaffected. It escalates to **P0** if the
  product makes point-shaped fields a v1 requirement, because then field
  creation itself — the first thing every user does — is on the critical path.
- **`OPEN-26` is a write-path blocker, not a read or schema blocker.** The
  database cannot express the partition invariant, so it is enforced nowhere
  until the validator exists; the table, its columns, and its checks are
  unaffected.
- **`OPEN-27` is a worker blocker.** The table and its index are correct; the
  credential that would query them is not. Because the documented default is "no
  `app_system` grant on a tenant table" (`ownership-and-rls.md` §2), Phase 3 ships
  that default and the decision later either keeps it or adds one narrow grant.
- **`OPEN-02` is P1 by severity and blocking by nothing.** It is in the register
  because the permission is genuinely absent; it is not a blocker because the
  fallback is specified and labelled. A register that quietly dropped it would be
  the same defect in the other direction.

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

## 2. Detail — the other ten P1 items

Each of these is a row in §1.1. Eight are `after Phase 3`; `OPEN-09` is the single
`Phase 3 DDL` item, and `OPEN-02` blocks nothing because its fallback exists.

### `OPEN-21` — field vocabularies and the `irrigationAvailable` mapping — **P1**

`fields.soil_type`, `drainage_class`, `irrigation_availability` are text with no
vocabulary; `FieldSnapshotPayload.irrigationAvailable` is a **boolean**. No
document defines the conversion, so the mapping is unowned — and a wrong one
silently changes every window's `fieldSnapshotHash` and every water-dependent
verdict. Options: a lookup table, a `CHECK` list, or a boolean column.

**Blocks:** field → snapshot construction. This is the most consequential open
item in the identity group. **Does not block:** the DDL — the three columns stay
unconstrained `text`, and a `CHECK` vocabulary is one of the options, so it would
arrive as a later migration rather than as Phase 3 DDL.

### `OPEN-09` — `plantings.status` vocabulary — **P1**

No enum is written anywhere. `plantings_active_idx` assumes a value spelled
`active`, and the column carries `DEFAULT 'active'`. Options: `active` ·
`harvested` · `failed` · `abandoned`.

**Blocks:** the `plantings.status` `DEFAULT` and `plantings_active_idx` — both are
Phase 3 DDL and both would encode the spelling before anyone chose it — and the
"what is growing here" query that reads through the index
(`tables-identity.md` §6, `indexes-and-query-patterns.md` §2).
**Does not block:** the rest of `plantings` (the column can be `NOT NULL`-less
`text` with no default), or any other table. This is the **only** P1 item that
changes what the Phase 3 migration must contain.

### `OPEN-18` — `cell_key` rounding rule per model — **P1**

`outlook_cells.cell_key` is `text` because the rounding rule is per model, and
`ADR-001` D6 says "a fixed, documented rounding rule per model" — but **no model's
rule is written down**. The DDL does not need it (a `text` column accepts any
key); the first ingest does, because it must compute a key from coordinates.

**Blocks:** writing a cell identity, and field → cell resolution, for any model
whose rule is undefined. **Does not block:** the `outlook_cells` and
`field_outlook_cells` DDL, the catalog, or any query that reads a cell that is
already keyed.
**Corrected in 2.3.x.1:** this entry previously said "Phase 3's write path needs
it". Phase 3 as recorded in the phase tracker is DDL only, so it does not.
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
shape is not defined anywhere. Three distinct states, which should not be
conflated: the **table** can be created exactly as specified; a **row** cannot be
validated, because there is nothing to validate against; the **AI subsystem**
cannot be implemented. **Blocks:** the AI slice, and the write path into
`ai_briefings`. **Does not block:** the `ai_briefings` DDL, its constraints, its
indexes, or any read of a row written under a later contract.

### `OPEN-13` — session storage — **P1**

Redis vs a table. A table would be a 23rd entity in this model with its own
retention; Redis would not appear here at all. **Blocks:** auth (with `OPEN-01`).

### `OPEN-04` — account deletion — **P1**

Three options in `lifecycle-and-retention.md` §1. Only anonymisation preserves
provenance. **Blocks:** a GDPR-shaped request path and the `users` unique index
design. **Does not block:** the `users` DDL as it exists — the table is already
implemented without `deleted_at` and without a partial email index, and neither is
a Phase 3 deliverable; whichever option wins will amend an applied table through a
later migration.

### `OPEN-28` — signed tenant context — **P1**

`ADR-003` A2: HMAC over `user_id`, verified in the policy. The only mitigation
against a leaked `app_api` DSN that reads every tenant. Deferred; becomes required
if that threat is in scope before production.

## 3. Settle during implementation

The remaining **15 items, all P2**: none blocks a Phase 3 deliverable, because each
affects code that is not on the path yet. `OPEN-12` is the farthest out — it blocks
Phase 9's verification tables, not Phase 3. Each is listed with its effect so the
question is not lost.

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
