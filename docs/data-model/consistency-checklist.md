# Consistency Checklist

The cross-document review for Phase 2.3. Each item states what was compared, what
was found, and whether it was fixed.

Method: the implemented schema was read from the running database (`\d app.users`,
`\d app.farms`, `\d app.fields`) and from
`prisma/migrations/20261118020000_tenant_tables/migration.sql`, then diffed
against `tables-identity.md`; the contract enums were read from
`packages/contracts/src/enums.ts` and `canonical.ts`, then diffed against every
`CHECK` this specification declares; the architecture documents were read and
compared against the decisions taken here.

## §1 — Implemented schema vs this specification

| # | Check | Result |
|---|---|---|
| 1.1 | `users`, `farms`, `fields` column names and order | **match** |
| 1.2 | nullability | **one mismatch**: `farms.region` is nullable in the database; this spec said `NOT NULL`. **Fixed** in `tables-identity.md` §2 |
| 1.3 | defaults (`uuidv7()`, `now()`, `'id'`, `'Asia/Jakarta'`, `'owner'`) | **match** |
| 1.4 | constraint names and definitions | **match** (`users_email_key`, `users_email_shape_check`, `users_role_check`, `farms_id_user_id_key`, `fields_farm_owner_fkey`, the four `fields_geom_*` checks, `fields_name_not_blank_check`, `fields_elevation_range_check`, `fields_soil_ph_range_check`) |
| 1.5 | index names and definitions | **match** (`farms_user_id_idx`, `fields_user_id_idx`, `fields_farm_id_idx`, `fields_geom_gist_idx`) |
| 1.6 | policy names and predicates | **match** (`users_self_only`, `farms_tenant_isolation`, `fields_tenant_isolation`, plus the three `*_owner_full_access` policies) |
| 1.7 | `timestamptz` vs `timestamptz(6)` | **cosmetic difference only**: the DDL writes `timestamptz`, this spec writes `timestamptz(6)`. PostgreSQL's default precision is 6, so the types are identical. Recorded, not changed — the explicit form survives a future server default change, and `pg_dump` will emit `timestamp(6) with time zone` for a new column either way |
| 1.8 | `area_ha` generated expression | **match in the migration text**, including the `public.ST_Area(…::public.geography)` qualification. PostgreSQL stores the *parsed* expression unqualified (`st_area((geom)::geography) / 10000.0`), which is why the qualification is a migration requirement rather than a stored property — `tables-identity.md` §3 |
| 1.9 | grants on `farms`/`fields` (`app_api` RW) and absence on `users` | **match** |

No migration edit was made, and none should be: `prisma migrate deploy` does not
verify checksums, so an applied migration is effectively immutable to this
project's tooling and a silent edit would diverge from every database that
already ran it.

## §2 — ADR-002 vs the implementation

| # | Statement | Reality |
|---|---|---|
| 2.1 | D3: "every geometry column is `geometry(Point\|Polygon, 4326)`" | the implementation uses `geometry(Geometry, 4326)` plus `CHECK (GeometryType(geom) IN ('POINT','POLYGON','MULTIPOLYGON'))` |
| 2.2 | D3: "mixed-SRID rows are rejected by a check constraint" | confirmed: `fields_geom_srid_check` |
| 2.3 | D3: "`geom` is `Unsupported("geometry")` in Prisma" | confirmed in `schema.prisma` |

**Assessment:** the code is *stronger* than the ADR sentence — three allowed
types enumerated by a `CHECK` is a narrower contract than a
`geometry(Point|Polygon)` column, which cannot express `MULTIPOLYGON` at all.
The ADR sentence is narrower than the code and is now inaccurate in a way that
would mislead a reader implementing a new geometry column.

`ADR-002` was not edited: it is an accepted, published decision record, and
editing a decision to match the code is how the record stops being a record.
`spatial-model.md` §1 states the actual rule and this item is the pointer.
**Follow-up:** annotate ADR-002 D3 with a pointer, as part of Phase 3's docs
sweep — not silently.

## §3 — Contract enums vs declared `CHECK` constraints

| # | Contract | `CHECK` here | Consistent |
|---|---|---|---|
| 3.1 | `weatherDataClassSchema` (9 values) | `weather_records.data_class` allows **4** (`weather_forecast`, `subseasonal_forecast`, `seasonal_forecast`, `annual_outlook`) | **yes, deliberately** — `D24`; the other five have different homes and a narrowing `CHECK` is not an enum change |
| 3.2 | `evaluationBasisSchema` (5 values, `mixed` legal) | `planting_windows.evaluation_basis` allows all five | yes |
| 3.3 | `singleValueEvaluationBasisSchema` (4 values) | `planting_windows.primary_basis` forbids `mixed` | yes — `mixed` is container-only |
| 3.4 | `dataAvailabilitySchema` (`available`/`stale`/`unavailable`) | **no column anywhere** | yes — computed at read time |
| 3.5 | `canonicalArrayRules` (10 field names) | `evidenceSegments` is last-written `sequence`; `missing_ranges` is `set` ordered by `(startDate, endDate)` | yes |
| 3.6 | `SegmentProvenance` (3 variants) | no `CHECK` — stored as a document | yes, per `physical-model.md` §7 |
| 3.7 | `MissingReason` | `monthly_outlooks.missing_reason` `CHECK IN (…)` must mirror the contract list exactly | mirrored; **any contract change requires a migration in the same commit** (`physical-model.md` §5) |
| 3.8 | `temporalClass` | must not appear anywhere (ADR-001 D9) | confirmed absent from this directory and from `packages/contracts` |

The enum rule this review enforces: **the `CHECK` list equals the contract list,
in the same order, with the contract symbol named in the table specification**
rather than the values re-listed. Re-listing is how the two drift.

## §4 — Architecture documents vs this model

| # | Source | Check | Result |
|---|---|---|---|
| 4.1 | `domain-model.md` §2 | `farms`/`fields` carry `deleted_at`; `user_id` denormalised onto `fields` with the composite FK | match |
| 4.2 | `domain-model.md` §3 | "a corrected profile never changes a stored recommendation" | match — `profile_version_id` is named by every artifact and publication is one-way (`D5`) |
| 4.3 | `domain-model.md` §5 invariant 1–2 | no numeric score on unknown inputs; a hard unknown constrains the verdict | match — `planting_windows_no_score_without_data_check` |
| 4.4 | `domain-model.md` §6 | `expectedHarvestAt` is "derived, not stored as truth" | match — no column, computed at read time |
| 4.5 | `domain-model.md` §8 | no station feed, no sensors, no per-day marker table, no org/team | match — none specified |
| 4.6 | `system-architecture.md` §8 | single-owner accounts; RLS predicate compares a column, not a join | match — `field_observations_entered_by_check` makes a second actor impossible in v1 |
| 4.7 | `system-architecture.md` §6 | derived data is never computed on GET | match — every derived artifact is materialised and superseded |
| 4.8 | `background-processing.md` §10 rule 2 | a new tenant table ships with no `app_system` grant | match — the matrix grants nothing on all ten |
| 4.9 | `provenance-contract.md` §3 | `ForecastRun` ≠ `IngestionRun`; `attempt` is a counter, not identity | match — separate tables, `attempt` excluded from the unique key |
| 4.10 | `provenance-contract.md` §4 rule 4 | `profileVersionId` mandatory on windows | match — `NOT NULL` + FK |
| 4.11 | `provenance-contract.md` §5 | freshness thresholds 6 h / 12 h / 48 h / 35 d / 13 months | match — `temporal-and-weather-semantics.md` §5 |
| 4.12 | `provenance-contract.md` §5 rule 1 | climatology contributes nothing to `oldestInputInitializedAt` | match — no stored freshness column at all |
| 4.13 | `provenance-contract.md` §4 | `geometryHash` preimage is "geometry in canonical EWKB" | **terminology differs, not semantics** — the contract's word "canonical" does not mean *normalized*. `spatial-model.md` §6 states the implemented rule (SHA-256 of the stored EWKB representation, no normalization), lists what is and is not equal, and records the source wording as item 6.5 rather than editing it |
| 4.14 | `data-flow.md` §1 | upsert key `(forecastRunId, cell, variable, validAt, member)` | match — `weather_records_live_key`, plus `NULLS NOT DISTINCT` (`D18`) which the prose does not mention |
| 4.15 | `data-flow.md` §8 | a null value past the horizon is not the same as an absent row | match — `temporal-and-weather-semantics.md` §6 |
| 4.16 | `api-conventions.md` §5 | briefing cached per `inputSnapshotHash` | match — `ai_briefings_cache_key` |
| 4.17 | `ADR-001` D3 | `modelAnomaly` primary; `baselineAnomaly` only grid-matched; `biasCorrected` stays false | match — `anomaly_kind` CHECK + `bias_corrected = false` CHECK |

## §5 — Cross-references inside this directory

| # | Check | Result |
|---|---|---|
| 5.1 | every entity in `entity-catalog.md` has a table in one of the four `tables-*.md` | 22/22 |
| 5.2 | every FK in `relationships.md` appears in its table's constraint list | yes |
| 5.3 | every index in `indexes-and-query-patterns.md` appears in its table's index list | yes |
| 5.4 | every `OPEN-nn` referenced anywhere is defined in `open-decisions.md` | **29 defined, 0 dangling**. The 29 are not all cross-referenced and this document does not claim they are; citation counts are quoted in §9 with the caveat that naming an id in order to count it creates the citation |
| 5.5 | every `D-nn` referenced anywhere is defined in `open-decisions.md` §4 | **25 defined, 0 dangling**; 12 are cited by another document, 13 are defined and cited only in the decision table (`03`, `04`, `08`–`11`, `15`–`17`, `19`–`22`). That is expected: a convention does not need a citation at every use site |
| 5.6 | `README.md` §1 document list matches the files on disk | yes — 16 files (13 numbered + 2 supporting + the README) |
| 5.7 | no document states a threshold value | confirmed — every agronomic number is a *column*, and the values live in `docs/research/agronomic-reference-matrix.md` |
| 5.8 | no document presents a 12-month outlook as a daily forecast | confirmed — `temporal-and-weather-semantics.md` §3 makes months 8–12 climatology |
| 5.9 | every `OPEN-nn` carries one canonical severity, and no document states a different one | one mismatch existed: `OPEN-17` was phase-wide in `open-decisions.md` and subsystem-scoped in `spatial-model.md`. Reconciled to **P1 with explicit scope** — see §8 — and 0 mismatches remain |
| 5.10 | no document claims the database enforces an application-level invariant | checked: the partition invariant, freshness, and `inputRefs` referential integrity are all stated as *not* database-enforced (`provenance-storage.md` §2, §4, §5) |
| 5.11 | no document references a nonexistent file as a valid destination | one existed: `open-decisions.md` pointed at `ADR-004`, which does not exist. **Fixed** — it now says the ADR does not exist and is not written |
| 5.12 | no ADR status changed silently | `ADR-003` is **Proposed**, matching `ADR-001`/`ADR-002`. It has been Proposed since it was written; nothing was promoted or demoted |
| 5.13 | no document claims implemented code where only a specification exists | checked: every spec table is marked `spec` in `entity-catalog.md`, and only `users`/`farms`/`fields` are marked `impl` |

## §6 — Defects found in *other* documents (not fixed here)

| # | Location | Defect | Action |
|---|---|---|---|
| 6.1 | `migrations/20261118020000_tenant_tables/migration.sql` (closing comment) | references `docs/architecture/auth-deferred.md`, which **does not exist** | the migration is immutable; `ownership-and-rls.md` §5 is the current home of that analysis, and Phase 3 should add the pointer file or amend the reference where it can still be amended |
| 6.2 | `database-foundation.md` §"2.2.3 notes" | the same `auth-deferred` reference; the notes also justify materialising only three tables because "`docs/data-model/` does not exist" | that justification is now **satisfied** — this directory is the missing artefact. It should be annotated, not rewritten, so the Phase 2.2.3 record stays true of its own moment |
| 6.3 | `ADR-002` D3 | geometry type narrower than the implementation | §2 above |
| 6.4 | `docs/IMPLEMENTATION_STATUS.md` | stopped at Phase 2.2.3, and its 2.3 section reported "25 decisions taken, 25 questions left open" | updated in 2.3 (documentation row) and corrected in 2.3.x to the measured counts (25 `D-nn`, 29 `OPEN-nn`) |
| 6.5 | `provenance-contract.md` §4 (line ~283) | `geometryHash` preimage is written "sha256 of geometry in canonical EWKB" — the word "canonical" reads as *normalized*, which the design does not do | **not edited** (a normative architecture document is out of scope for a data-model pass). `spatial-model.md` §6 states the implemented rule, enumerates what is and is not equal, and this row is the pointer. If the wording is to change, it changes with a provenance-contract revision, not here |
| 6.6 | `ADR-002` D3 | see §2 — the ADR's geometry type is narrower than the implementation | annotate, do not rewrite: an accepted decision record is not corrected by editing it to match the code |

## §7 — Operational constraint: concurrent index on a live table

`prisma migrate deploy` runs each migration inside a transaction in the current
setup, and PostgreSQL does not permit `CREATE INDEX CONCURRENTLY` inside a
transaction block. This is a property of the current setup, not a guarantee of the
tool.

Phase 3's tables are empty at creation, so a plain `CREATE INDEX` takes no lock
that matters **then**. The constraint bites later, on `weather_records` — the one
table that grows without bound (`OPEN-16`) — where a first index addition after
the table holds data would block writes for the duration of the build.

What that requires, stated plainly: **a separately planned operational procedure,
not a normal migration.** The candidate shapes are a migration runner that does
not wrap this statement in a transaction (if the bundled Prisma version supports
that escape), a DBA-executed script recorded out-of-band as an applied migration,
or an accepted lock during a maintenance window. Each has a different failure mode
and none is chosen here.

Two things this phase deliberately does **not** do: change how migrations are
executed, and introduce a second migration mechanism. The note exists so that the
decision is made deliberately at that moment rather than discovered mid-deploy.

Not a defect now. Recorded because it will surface at the worst possible moment —
during a production index addition on the largest table in the model.

## §8 — Blocker matrix and verdict

**Phase 2.3 specification: complete.** Every table, relationship, index, policy,
and contract-storage decision that could be derived from the existing normative
documents has been derived and written down.

**Phase 2.3 approval: withheld.** The register is **29 open items: 14 P1, 15 P2**,
and **no item is P0**, because Phase 3's deliverables — 19 tables, their
constraints and indexes, the policies, the grants — can all be created today, with
exactly one exception: `OPEN-09` decides whether `plantings` ships a status default
and the partial index that names it. Widening a subsystem blocker to a phase-wide
stop would overstate it; narrowing this one to nothing would be dishonest.

The authoritative matrix is `open-decisions.md` §1.1: all 14 P1 items, each with
what it blocks, what continues, and whether it applies to the Phase 3 DDL or to a
later slice. It is **not** reproduced here, because two copies of a matrix drift;
what follows is the one thing this checklist needs to say about it.

| Category | Count | Items | Meaning for Phase 3 |
|---|---|---|---|
| `Phase 3 DDL` | **1** | `OPEN-09` | the migration's `plantings.status` default and `plantings_active_idx` predicate would encode an undecided vocabulary; omit them, or decide it |
| `after Phase 3` | **12** | `OPEN-01`, `-13` (auth) · `OPEN-17`, `-21` (snapshot) · `OPEN-18` (ingest/resolution) · `OPEN-26` (window write) · `OPEN-27` (worker) · `OPEN-11` (AI) · `OPEN-04` (lifecycle) · `OPEN-03`, `-05` (deployment/retention) · `OPEN-28` (hardening) | none changes the Phase 3 DDL; each stops the first slice that consumes it |
| `not blocking` | **1** | `OPEN-02` | the 0–3 d BMKG band has a labelled Open-Meteo fallback that already ships |

The four items an earlier version of this section listed as *the* blockers —
`OPEN-01`, `OPEN-17`, `OPEN-26`, `OPEN-27` — are four of those twelve. They remain
the first four slices to be blocked, and they remain P1. What changed is that the
section no longer implies they are the whole register: of the ten items it had
omitted, `OPEN-09` stops a Phase 3 deliverable, eight stop a named slice, and
`OPEN-02` stops nothing.

What can proceed now, unaffected by every one of the 14: the 19 specified tables,
their constraints, indexes, policies and grants, the catalog seed, and every read
path over data that exists. **What cannot** — stated because the earlier version of
this paragraph claimed it could: ingestion and aggregation, since writing a cell
identity needs the `cell_key` rule (`OPEN-18`), and no model's rule is written
down.

No answer to these was invented and none is marked accepted. This document is the
record of exactly where the boundary is.

## §9 — How the counts above were measured

A throwaway Node script read every `.md` under `docs/data-model/`, plus
`docs/adr/ADR-003-trusted-tenant-context.md` and `docs/IMPLEMENTATION_STATUS.md`,
and reported:

| Measure | Result |
|---|---|
| `OPEN-nn` definitions | 29, each with exactly one detail entry (14 section headings + 15 rows in the §3 table). All 14 P1 items also appear in the §1.1 matrix, which is a summary and not a second definition — its severities agree with the detail entries |
| `OPEN-nn` by severity | **14 P1** (`§1.1`: 1 `Phase 3 DDL`, 12 `after Phase 3`, 1 `not blocking`) and **15 P2** (§3 table) — 29 |
| `OPEN-nn` IDs referenced anywhere | 29 |
| `OPEN-nn` cited outside `open-decisions.md` | **28 of 29** as measured; the remaining one is cited only within the same file. Before 2.3.x.1 the figure was 25 — it rose because §8 now names the ten ids it classifies. This row's own wording can move it, which is why it is a measurement note and not a finding |
| `OPEN-nn` in the §1.1 matrix | 14 of 14 — no P1 item missing, no non-P1 item present, verified in both directions |
| `OPEN-nn` referenced but undefined | 0 |
| `D-nn` definitions | 25, no id defined twice |
| `D-nn` referenced outside `open-decisions.md` | 12 |
| `D-nn` referenced but undefined | 0 |
| canonical severities in `open-decisions.md` | 4 in the §1.1 matrix, 14 stated in headings/rows, all agreeing |
| severity mismatches between a document and `open-decisions.md` | 1 before correction (`OPEN-17`), **0 after** |
| occurrences of the exact phrase "sha256 of geometry in canonical EWKB" | **3**: once in `provenance-contract.md` (the source, out of scope), once in §6.5 as a quotation being corrected, and once in this row while naming the phrase. None is an assertion |
| occurrences of "canonical EWKB" used as an assertion in `docs/data-model/` | **0**. The two in `spatial-model.md` and the four in this document all either quote the source or state what the phrase must not be read to mean |

Two limitations, stated because the alternative is a false assurance:

1. **A grep finds the phrasings someone thought of.** The first pass scanned line
   by line and missed the `spatial-model.md` occurrence because the phrase was
   broken across two lines; the second pass scans the joined text. A third
   phrasing nobody imagined would still survive.
2. **The audit can count itself.** An enumeration of the uncited ids is itself a
   citation of those ids, so the script's "referenced outside" figure rises if the
   audit lists ids in the `OPEN-nn` form. The counts above therefore omit the
   bare-id enumerations in §5.4, §5.5 and this table — the figures are of the
   specification, not of the report about it.

Neither check verifies SQL, schema, or runtime behaviour. They verify that a set
of Markdown files agree with each other about identifiers, severities, and
phrasing.
