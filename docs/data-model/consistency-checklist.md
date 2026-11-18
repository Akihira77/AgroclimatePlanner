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
| 1.8 | `area_ha` generated expression | **match**, including the `public.ST_Area(…::public.geography)` qualification |
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
| 4.13 | `provenance-contract.md` §4 | `geometryHash` = `sha256` of canonical EWKB | match — `spatial-model.md` §6 gives the SQL |
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
| 5.4 | every `OPEN-nn` referenced anywhere is defined in `open-decisions.md` | 25 referenced, 25 defined, no gaps in the numbering |
| 5.5 | every `D-nn` referenced anywhere is defined in `open-decisions.md` §4 | 25 defined, contiguous |
| 5.6 | `README.md` §1 document list matches the files on disk | yes, after this checklist was added |
| 5.7 | no document states a threshold value | confirmed — every agronomic number is a *column*, and the values live in `docs/research/agronomic-reference-matrix.md` |
| 5.8 | no document presents a 12-month outlook as a daily forecast | confirmed — `temporal-and-weather-semantics.md` §3 makes months 8–12 climatology |

## §6 — Defects found in *other* documents (not fixed here)

| # | Location | Defect | Action |
|---|---|---|---|
| 6.1 | `migrations/20261118020000_tenant_tables/migration.sql` (closing comment) | references `docs/architecture/auth-deferred.md`, which **does not exist** | the migration is immutable; `ownership-and-rls.md` §5 is the current home of that analysis, and Phase 3 should add the pointer file or amend the reference where it can still be amended |
| 6.2 | `database-foundation.md` §"2.2.3 notes" | the same `auth-deferred` reference; the notes also justify materialising only three tables because "`docs/data-model/` does not exist" | that justification is now **satisfied** — this directory is the missing artefact. It should be annotated, not rewritten, so the Phase 2.2.3 record stays true of its own moment |
| 6.3 | `ADR-002` D3 | geometry type narrower than the implementation | §2 above |
| 6.4 | `docs/IMPLEMENTATION_STATUS.md` | stops at Phase 2.2.3 | updated in this phase (documentation row only) |

## §7 — Operational constraint discovered during design

`prisma migrate deploy` runs each migration inside a transaction, and
`CREATE INDEX CONCURRENTLY` cannot run inside one. Phase 3's tables are empty at
creation, so a plain `CREATE INDEX` takes no lock that matters — but the **first
index added to `weather_records` after it holds data** cannot use the normal
migration path. Options at that time: a migration with a documented
`-- prisma:disable-transactions`-style escape (if the bundled Prisma version
supports it), a separate DBA-run script recorded as an applied migration, or
accepting the lock.

Not a defect now. Recorded because it will be a surprise at exactly the wrong
moment — during a production index addition on the largest table in the model.

## §8 — Verdict

**Phase 2.3 specification: complete.** Every table, relationship, index, policy,
and contract-storage decision that could be derived from the existing normative
documents has been derived and written down.

**Phase 2.3 approval: withheld**, on two P0 items and one effective-P0:

| Item | Blocks |
|---|---|
| `OPEN-01` — the authentication lookup | the auth slice, and therefore every request path |
| `OPEN-17` — `area_ha` for a `POINT` field | field creation for a point-shaped field, and every artifact derived from one |
| `OPEN-27` — the recompute fan-out cannot read tenant rows | `recompute.windows`, the job that delivers a new forecast to a dashboard |

No answer to these was invented. Phase 3 can begin on the parts that do not
depend on them — the global weather plane, the catalog, and the tenant tables
that have no snapshot — and this document is the record of exactly where the
boundary is.
