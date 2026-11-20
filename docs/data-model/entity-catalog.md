# Entity Catalog

Every entity the architecture names, with its physical table, ownership class,
and where it is specified. An entity that is named in the architecture but has no
specification here is listed in §3 with the reason — that list is the honest
boundary of this phase.

**Ownership classes**

| Class | Meaning |
|---|---|
| `identity` | the tenant itself; one row per account |
| `tenant` | owned by exactly one tenant, isolated by RLS |
| `tenant-derived` | tenant-owned output of a computation; replayable, superseded rather than deleted |
| `reference` | global catalog content, edited by administrators only, read by everyone |
| `global` | provider data with no tenant dimension at all |

## 1. Specified tables

22 tables from Phase 3, all implemented, plus one added afterwards: `sessions`, in
`20261118050000_sessions` (S5), for 23 tables in total. Three of the 22 arrived with
Phase 2.2.3 (`users`, `farms`, `fields`); the other nineteen with Phase 3, in migration
`20261118030000_domain_tables`. The `State` column records when each arrived, not whether
it exists.

| # | Table | Logical entity | Class | Ownership key | RLS | State | Specified in |
|---|---|---|---|---|---|---|---|
| 1 | `app.users` | `User` | `identity` | `id` | yes | Phase 2.2.3 | `tables-identity.md` §1 |
| 2 | `app.farms` | `Farm` | `tenant` | `user_id` | yes | Phase 2.2.3 | `tables-identity.md` §2 |
| 3 | `app.fields` | `Field` | `tenant` | `user_id` | yes | Phase 2.2.3 | `tables-identity.md` §3 |
| 4 | `app.field_outlook_cells` | field → cell resolution | `tenant` | `user_id` | yes | Phase 3 | `tables-identity.md` §4 |
| 5 | `app.field_observations` | `FieldObservation` | `tenant` | `user_id` | yes | Phase 3 | `tables-identity.md` §5 |
| 6 | `app.plantings` | `Planting` | `tenant` | `user_id` | yes | Phase 3 | `tables-identity.md` §6 |
| 7 | `app.harvests` | `Harvest` | `tenant` | `user_id` | yes | Phase 3 | `tables-identity.md` §7 |
| 8 | `app.crops` | `Crop` | `reference` | — | no | Phase 3 | `tables-catalog.md` §1 |
| 9 | `app.cultivars` | `Cultivar` | `reference` | — | no | Phase 3 | `tables-catalog.md` §2 |
| 10 | `app.crop_profile_versions` | `CropProfileVersion` | `reference` | — | no | Phase 3 | `tables-catalog.md` §3 |
| 11 | `app.growth_stages` | `GrowthStage` | `reference` | — | no | Phase 3 | `tables-catalog.md` §4 |
| 12 | `app.constraints` | `Constraint` | `reference` | — | no | Phase 3 | `tables-catalog.md` §5 |
| 13 | `app.source_refs` | `SourceRef` | `reference` | — | no | Phase 3 | `tables-catalog.md` §6 |
| 14 | `app.outlook_cells` | `OutlookCell` | `global` | — | no | Phase 3 | `tables-climate.md` §1 |
| 15 | `app.forecast_runs` | `ForecastRun` | `global` | — | no | Phase 3 | `tables-climate.md` §2 |
| 16 | `app.ingestion_runs` | `IngestionRun` | `global` | — | no | Phase 3 | `tables-climate.md` §3 |
| 17 | `app.weather_records` | `WeatherRecord` | `global` | — | no | Phase 3 | `tables-climate.md` §4 |
| 18 | `app.monthly_outlooks` | `MonthlyOutlook` | `global` | — | no | Phase 3 | `tables-climate.md` §5 |
| 19 | `app.climatology_normals` | climatology baseline | `global` | — | no | Phase 3 | `tables-climate.md` §6 |
| 20 | `app.suitability_runs` | `SuitabilityRun` | `tenant-derived` | `user_id` | yes | Phase 3 | `tables-derived.md` §1 |
| 21 | `app.planting_windows` | `PlantingWindow` | `tenant-derived` | `user_id` | yes | Phase 3 | `tables-derived.md` §2 |
| 22 | `app.ai_briefings` | `AiBriefing` | `tenant-derived` | `user_id` | yes | Phase 3 | `tables-derived.md` §3 |
| 23 | `app.sessions` | `Session` | `identity` | `user_id` → `users` | yes | S5, 2026-11-20 | `ADR-005`, `phase-3.2.3` §7 |

Tenant-owned (RLS): 10 tables — rows 1–7 and 20–22.
Global/reference (no RLS, no `user_id`): 12 tables — rows 8–19.
Identity (RLS forced, not tenant-scoped): 1 table — row 23. `sessions` carries no
`app.user_id` predicate on purpose: it is read during authentication, before a tenant
context exists (`ADR-005`).

### Logical entities that are not tables

The domain model's ERD names a few boxes whose columns are specified as contract
types, not as columns. They are stored inside their parent, not shredded:

| Contract type | Stored inside | Documented in |
|---|---|---|
| `DataInputRef` | `input_refs jsonb` on every derived artifact and `monthly_outlooks` | `provenance-storage.md` §2 |
| `FieldSnapshot` | `field_snapshot jsonb` on `suitability_runs`, `planting_windows`, `ai_briefings` | `provenance-storage.md` §3 |
| `EvidenceSegment` | `evidence_segments jsonb` on `planting_windows` | `provenance-storage.md` §4 |
| `MissingRange` | `missing_ranges jsonb` on `planting_windows`, `monthly_outlooks` | `provenance-storage.md` §4 |
| `DerivedFreshness` | **nowhere** — computed at read time | `temporal-and-weather-semantics.md` §5 |
| `SourceFreshness` | **nowhere** — computed at read time | `temporal-and-weather-semantics.md` §5 |

Storing a computed freshness value would create a second source of truth that a
job could leave stale; `provenance-contract.md` §5 forbids it and this model does
not add a column for it.

## 2. Ownership is not the same as write access

The three tables that matter for the boundary:

| Question | Answer |
|---|---|
| Who owns `app.fields`? | `migration_owner` (the schema owner). Never a runtime role. |
| Who may read another tenant's field? | Nobody holding `app_api` — RLS denies row-level access. |
| May `app_system` read a field? | No. It holds `BYPASSRLS` and **zero** grants on tenant tables. |
| May `app_api` read provider weather? | Yes — `SELECT` only, on the 12 global tables, because the read model needs it. |
| May `app_api` write provider weather? | No. Ingest runs as `app_system`. |
| May `app_api` write the catalog? | No. Catalog rows are seeded by `migration_owner` (D13). |

Full matrix: `ownership-and-rls.md` §2.

## 3. Entities deliberately not specified

| Entity / area | Why not | Tracked as |
|---|---|---|
| `forecast_scores` (verification truth, skill metrics) | `provenance-contract.md` §4 rule 3 says scoring lives in "the scoring tables", but no column list exists anywhere | `OPEN-12` |
| `raw_payloads` | retention is a licensing question per provider, and the object store is optional | `D12`, `OPEN-05` |
| `subscriptions` / billing | not in the domain model at all | not tracked — out of product scope |
| `notifications` | not in the domain model | not tracked — out of product scope |
| `weather_stations` | `domain-model.md` §8 explicitly excludes it ("no station feed") | excluded by architecture |
| `sensors` / `devices` | `domain-model.md` §8 explicitly excludes hardware | excluded by architecture |
| per-day crop marker table | `domain-model.md` §8: markers are derived at read time | excluded by architecture |
| organisation / team / membership | `system-architecture.md` §8: single-owner accounts in v1 | excluded by architecture |

`annual_outlook` data (ECMWF Set VII, months 8–13) is a `dataClass` value and a
`forecast_runs.product` value; it needs no table of its own, because a Set VII run
is a `forecast_runs` row and its values are `weather_records` rows. Whether it can
be obtained at all is `OPEN` in `forecast-horizon-capabilities.md` (licence
enquiry + GRIB proof of concept still pending) — the physical model stores it if
it arrives, and claims nothing about its availability.
