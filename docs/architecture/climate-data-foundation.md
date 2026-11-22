# Climate Data Foundation

Status: **Phase 5 design. No runtime code.** Nothing in this document is implemented
except where a table or contract is explicitly marked as existing and verified
against the applied database on 2026-11-21.

This is the implementation plan for the climate plane. It does not replace any
existing authority: `ADR-001` decides *which* sources and *how* they are labelled,
`provenance-contract.md` defines evidence and run identity,
`temporal-and-weather-semantics.md` fixes every date column's meaning,
`tables-climate.md` owns the physical tables, `background-processing.md` owns queues
and scheduling, and `data-flow.md` owns the pipeline shape. This document says what
must be *built*, in what order, and where each piece lives in this repository.

If this document and an authority disagree, the authority wins and this document is
wrong — except in §3.5 and §9, which record places where the applied database and
the authorities have measurably diverged.

---

## 1. Scope

In scope, as design only:

- Provider adapter and normalizer boundary.
- Spatial cell identity and field → cell resolution.
- `ForecastRun` / `IngestionRun` ingestion lifecycle on existing tables.
- Short-range, subseasonal, seasonal, and climatology ingestion.
- Aggregation into `monthly_outlooks`.
- The read path for a 12-month outlook.
- Failure handling, observability, licensing constraints, verification.
- A dependency-ordered roadmap (§8).

Out of scope, deliberately: provider adapters, workers, API routes, migrations,
Prisma changes, contracts, dependencies, agronomic calculation, planting windows,
AI briefing, frontend, deployment.

Awaiting this phase: `field_observations` ingestion, verification/scoring
(`OPEN-12`), and anything agronomic. Phase 5 ends at "a labelled monthly outlook for
a field can be served from stored data".

---

## 2. Reconciliation matrix

The row "Implementation status" is measured, not inferred: it reflects the applied
database (catalogue query as `migration_owner`, 2026-11-21) and the source tree as it
stands at `d7eeff4`.

| Concern | Existing authority | Current decision | Implementation status | Remaining gap |
|---|---|---|---|---|
| Provider strategy | `ADR-001` D1–D5 | Open-Meteo is transport, ECMWF is authority; BMKG gated off; no bias correction in v1 | **designed only.** No adapter, no HTTP client, no provider credential, no feature flag exists in `apps/` or `packages/` | Every adapter; the `BMKG_SHORT_RANGE_ENABLED` flag; the Open-Meteo plan decision (`OPEN-03`) |
| Data classes | `provenance-contract.md` §1; `ADR-001` D9 | Nine `WeatherDataClass` values, `temporalClass` deprecated | **contract typed.** `enums.ts` + `weather.ts` define the enum and four value variants; `weather_records_data_class_check` restricts stored rows to the four forecast classes — verified in the catalogue | No persistence contract for a `WeatherRecord` row (only the value variant); no mapping table from adapter output to `dataClass` |
| `ForecastRun` identity | `provenance-contract.md` §3; `background-processing.md` §3 | UUIDv7 id, natural key `(provider, model, product, initialized_at)`, upserted | **table exists and is granted** (`forecast_runs`, 9 columns, `app_api` SELECT, `app_system` RW, `forecast_runs_natural_key` + `forecast_runs_recent_idx`) | No TypeScript schema or repository for the row; no upsert helper; no `horizon_end` derivation rule per product |
| `IngestionRun` identity | `provenance-contract.md` §3; `tables-climate.md` §3 | Unique on `(forecast_run_id, ingestion_version)`; `attempt` is a counter, not identity | **table exists and is granted** (15 columns, `ingestion_runs_identity_key`, `ingestion_runs_running_idx`) | No `ingestion_version` computation, no `target_selector_hash` definition, no status transition helper; `attempt` update path undefined |
| Cell resolution | `tables-climate.md` §1; `physical-model.md`; `OPEN-18` | `cell_key` is `text`; identity is `(provider, model, cell_key)`; the key is produced by a resolver keyed on `(provider, model)` whose origin, spacing, orientation, and revision are explicit inputs (owner-approved 2026-11-21, §5.2.9) | **resolver, registry and result contract implemented** in `packages/contracts/src/grid.ts`: eighteen synthetic vectors, four literal `gridSpecHash` fixtures, registry keyed by `(provider, model)` with declared `GridEvidence`, and `SpatialResolution` at `grid-resolve/1`. No provider grid constant exists | The registry instance (§8.2 step 5.2.4); the five provider grid configurations, all pending external evidence (§5.2.6); field → cell writes |
| Field → cell mapping | `data-flow.md` §2; `tables-identity.md` §4 | Centroid in v1 (`OPEN-15`); resolution stored, never recomputed on read; a geometry edit supersedes rows | **tables exist and are tenant-scoped with `FORCE` RLS**; no code resolves a field into a cell | The resolution service; the geometry-edit supersession trigger; `field_outlook_cells` writes are not in the Field API |
| Normalized records | `tables-climate.md` §4 | One row per `(run, cell, variable, valid_at, ensemble_member)`; `value` nullable; never deleted, only superseded | **table exists** (32 columns, 5 indexes, `weather_records_live_key` uses `NULLS NOT DISTINCT`) | The normalizer itself; unit conversion table; the supersession writer; `OPEN-14` vocabulary for `temporal_resolution`/`aggregation_level` |
| Climatology | `ADR-001` D2; `tables-climate.md` §6 | 1991–2020, CHIRPS preferred, ERA5 as implemented fallback; a rebuild is a new `baseline_version` | **table exists** (`climatology_normals`, 11 columns, unique `(baseline_version, outlook_cell_id, month)`) | The baseline builder; the route to a reachable CHIRPS v3.0 (host timed out 2026-11-18); `baselineHash` computation over a consumed subset |
| Temporal aggregation | `temporal-and-weather-semantics.md` §1–§6 | Every instant `timestamptz(6)` UTC; every calendar decision Asia/Jakarta; one conversion at aggregation | **designed only.** `temporal.ts` exists in contracts; no aggregation code | The daily → weekly → monthly aggregation; the UTC → Jakarta day boundary at the one permitted conversion point; `monthly_outlooks` assembly order |
| Provenance | `provenance-contract.md`; `provenance-storage.md`; `canonical.ts` | Hash preimages stored as documents; freshness computed at read time, never stored | **implemented in contracts only**, with 239 passing contract tests including golden vectors; the derived tables that store those documents exist | No producer writes any `input_refs`; `DerivedFreshness` has no producer; the provenance audit that resolves dangling refs does not exist |
| Raw payload retention | `OPEN-05`; `OPEN-03` | Retention is **deferred** by the owner (2026-11-21); the normalized row is the system of record, and every artifact built on a non-retained payload records `reproducible: false` with a reason | **nothing exists**: no object store, no `raw_payload_ref` writer, no retention table — and none is planned for the initial release | Reopening awaits a lawful, paid or self-hosted plan and a verification run that must re-derive a score (§5.4) |
| Tenant access | `ADR-003`; `tenant.ts`; `system-architecture.md` | `withTenant(userId, fn)` is the only entry point; one `createTenantScope` per request; `app_system` owns global writes and holds no tenant-row grant | **implemented and tested**: `withTenant` ships, `test:rls` passes 90 assertions as real roles, `db:verify` passes | The recompute fan-out has no permitted read of `field_outlook_cells` (`OPEN-27`); climate read path is `app_api` only, which is already granted |
| Background processing | `background-processing.md`; `Q-P5-1` | Six queues, run identity by `forecastRunId`, retry classes, budget guards, explicit failure semantics; **queue backing is PostgreSQL-first** (owner decision 2026-11-21), behind an abstraction | **nothing exists.** `apps/worker/src/main.ts` is a stub; no queue library, no Redis client, no scheduler, no HTTP client is installed anywhere in the workspace; no `jobs` table exists | The worker runtime, the six queues, the Postgres job table, the budget buckets, the maintenance sweep (§8.3) |

---

## 3. What exists today, verified

### 3.1 Database (measured 2026-11-21 as `migration_owner`)

| Table | Scope | Columns | RLS | `app_api` | `app_system` |
|---|---|---|---|---|---|
| `app.outlook_cells` | global | 10 | — | `SELECT` + column `INSERT` (`provider`, `model`, `cell_key`) | RW |
| `app.forecast_runs` | global | 9 | — | `SELECT` | RW |
| `app.ingestion_runs` | global | 15 | — | `SELECT` | RW |
| `app.weather_records` | global | 32 | — | `SELECT` | RW |
| `app.monthly_outlooks` | global (keyed by cell) | 23 | — | `SELECT` | RW |
| `app.climatology_normals` | global | 11 | — | `SELECT` | RW |
| `app.field_outlook_cells` | tenant | 11 | `FORCE` | RW | **no grant** |
| `app.field_observations` | tenant | 11 | `FORCE` | RW | **no grant** |

Every documented index is present under its documented name, including the three
load-bearing ones: `weather_records_live_key` (`NULLS NOT DISTINCT`, partial on
`superseded_at IS NULL`), `monthly_outlooks_active_key`, and
`field_outlook_cells_live_key`.

Constraint checks confirmed from `pg_constraint`, not from the migration text:

- `weather_records_data_class_check` — four forecast classes only.
- `weather_records_bias_check` — `bias_corrected = false`.
- `monthly_outlooks_variable_check` — `variable = 'precipitation'`.

### 3.2 Contracts

`packages/contracts/src/weather.ts` (150 lines) defines `WeatherValue` as a
four-variant discriminated union (forecast / baseline / dataset / observation) plus
`SourceFreshness`. `provenance.ts` defines `DataInputRef`, `EvidenceSegment`,
`DerivedProvenance`, `FieldSnapshot`. `canonical.ts` implements the canonicaliser
with golden vectors enforced by `hash.golden.test.ts`.

### 3.3 Application

`apps/api/src` contains `auth`, `farm`, `field`, `health`, `http`, `database`,
`config`. There is no climate module and no `/v1/climate` route.
`packages/database/src` contains `auth-*`, `farms`, `fields`, `tenant`. There is no
climate repository. `apps/worker/src/main.ts` is a stub with no dependencies beyond
`@agroclimate/contracts`.

### 3.4 Therefore

Phase 5 is a **greenfield implementation on a finished schema**. The schema is not
the risk; the risk is writing adapters and normalizers against unverified provider
behaviour, and the licensing decisions that gate three of them.

### 3.5 Documented-but-absent, and one divergence

Found by comparing the authorities against the catalogue and the source tree. These
are recorded here rather than silently patched, because each one changes what a
sub-phase must build.

| Claim | Where | Reality |
|---|---|---|
| `sync_attempts` table, dead-letter table, sweep watermark | `background-processing.md` §10 | **No such tables exist.** `ingestion_runs` carries `error` and `status`, but per-attempt latency/bytes and dead-letter entries have no home. `Q-P5-2` is deferred: structured logs plus `ingestion_runs` first, a migration only when a question cannot be answered (§5.4) |
| "`app_api` may `INSERT` identity rows into `outlook_cells`" | `tables-climate.md` §1 | True, and narrower than a table grant: only `provider`, `model`, `cell_key` are insertable. Verified. The consequence is that a resolution must be two-phase — `app_api` creates the identity, `app_system` fills `served_lat`/`served_lon`/`elevation_m` — and no code implements the second phase yet |
| A single value may not carry `evaluationBasis: "mixed"` | `temporal-and-weather-semantics.md` §4; `enums.ts` defines `singleValueEvaluationBasisSchema` for exactly this | `weather.ts` `valueBase` uses the **broad** `evaluationBasisSchema`, which includes `mixed`, and never imports the narrow one. A `WeatherValue` can therefore validate while asserting a per-container basis — the one thing §4 forbids. `planting_windows_basis_check` in the database gets this right | Fixed in 5.0 as a contract defect, not a documentation change |
| BullMQ is the scheduler | `data-flow.md` §1, `background-processing.md` §3–§5 | **No queue library is installed.** The BullMQ wording is a target, not a dependency |
| Four climate read endpoints | `api-conventions.md` §6, `data-flow.md` §5 | `GET /v1/climate/outlook`, `/monthly`, `/anomalies`, `/data-quality`, each `?fieldId=` | **documented surface, not routed.** No `apps/api/src/climate` module exists, and no response schema is written | `outlook` is the only one in Phase 5 scope; the other three wait for the data they would summarise |

---

## 4. Data source evaluation

Evidence date: **2026-11-18**, from `weather-source-matrix.md`,
`forecast-horizon-capabilities.md`, and `data-licensing-and-attribution.md`. It is
**not re-tested in this phase.** The "Freshness" column says what must be re-verified
before the sub-phase that depends on it, and by what evidence.

| Source | Data role | Resolution | Temporal | Coverage / horizon | Variables | Access | Licensing posture | Freshness | Needed by |
|---|---|---|---|---|---|---|---|---|---|
| BMKG `prakiraan-cuaca` | `weather_forecast` (village forecast) | village/kelurahan point, not gridded; one `adm4` code per request | 3-hourly, 7 slots/day (05/08/11/14/17/20/23 local) | ~48 h + a partial third day (observed 17 slots) | `t`, `tp`, `hu`, `ws`, `wd`, `tcc`, `weather`, `weather_desc`, `vs` | JSON API, no auth; `adm4` required (`adm3` → 404); ≤60 req/min/IP | **ToU §9.3: commercial use, repackaging, and third-party integration require written permission; §8.1 prohibits scraping.** Attribution "Sumber: BMKG" + logo, next to the data | **must re-verify** before enabling; needs a written reply from BMKG | 5.4 (gated) |
| Open-Meteo Forecast | `weather_forecast` | model grid, snapped (IFS 0.25° ≈ 28 km at Jakarta); served point recorded per record | hourly / 3-hourly / daily | `forecast_days` 0–16, server-enforced (400 outside) | precipitation, temp, humidity, wind, gust, radiation, ET₀, soil | JSON API, multi-coordinate per call; free tier 600/min, 5 000/h, 10 000/day, 300 000/month | Data CC BY 4.0 + Open-Meteo attribution; **free tier is non-commercial only** ("You may only use the free API services for non-commercial purposes"); commercial = paid plan or AGPL self-host | **must confirm plan** (`OPEN-03`) before production use | 5.4 |
| Open-Meteo Ensemble (`ecmwf_ifs025`) | `weather_forecast` (ensemble) | IFS 0.25° grid; served −6.25/106.75 at Jakarta | daily | **day 14.** `forecast_days=35` returns 35 rows with every value `null` from day 15 (measured) | same, per member: `…_member01..50` + mean | ensemble endpoint, same key/limits | as Open-Meteo Forecast | re-verify member count at first call | 5.4 |
| EC46 via Open-Meteo seasonal API | `subseasonal_forecast` | ~36 km (O320) | 6-hourly raw → daily to day 45; weekly statistics to day 42 (100 members) | 46 days; **no monthly product** (`models=ecmwf_ec46&monthly=…` returns 0 rows) | precipitation, temp, EFI/SOT; soil moisture, soil temp, gusts, showers limited to 46 d | seasonal endpoint, own budget share | ECMWF CC BY 4.0 + ECMWF attribution; raw EC46 is **not** in the ECMWF Open Data portal — Open-Meteo is the documented route | re-verify lead-time shape and member count | 5.6 |
| SEAS5 via Open-Meteo seasonal API | `seasonal_forecast` | ~36 km (O320) | 6-hourly raw → **monthly only** | 6 months default, 7 with `forecast_days ≥ 200`, server cap 217 | precipitation `mean` + `anomaly`, `temperature_2m_mean`; **no spread variable** (`*_spread` → 400, measured) | seasonal endpoint | as EC46; hindcast via Copernicus CDS licence, attribution "Contains modified Copernicus Climate Change Service information [year]" | re-verify the 6-vs-7 row split with the pinned `forecast_days` | 5.6 |
| ECMWF Set VII | `annual_outlook` (months 8–13) | GRIB grid, not a point service | monthly means/anomalies per member; quarterly production (Feb/May/Aug/Nov, 5th 12:00 UTC) | 13 months | precipitation (`tp` as **m/s rate**, not mm — conversion depends on month length), temperature | GRIB; **no free point API**; not in Open Data; C3S seasonal CDS stops at 7 months | access route **unverified** | **blocked**: licence enquiry + GRIB proof of concept | not planned in Phase 5 |
| ERA5 (archive) | `reanalysis` | 0.25° (≈28 km) | hourly | 1940 → present, multi-day latency (no published figure) | precipitation, temp, wind, radiation | CDS API; also reachable via `archive-api.open-meteo.com/v1/archive` | Copernicus Licence, commercial OK, attribution "Contains modified Copernicus Climate Change Service information [year]" | usable as the climatology fallback; verify the archive route at build time | 5.5 |
| ERA5-Land | `reanalysis` | 0.1° (≈9–11 km) | hourly | 1950 → present | land-surface variables | CDS API | as ERA5 | not needed in Phase 5; **precipitation is not independently downscaled**, so a finer grid is not better rain | — |
| CHIRPS v3.0 | `satellite_estimate` (gauge-blended) | 0.05° (≈5.5 km) | daily, pentadal, monthly | 1981 → near-present; **v2 production ends after December 2026** | precipitation only | bulk HTTP/FTP; GEE | **public domain *and* CC BY 4.0** — attribution expected, no commercial restriction; citation Funk et al. | **`data.chc.ucsb.edu` timed out on 2026-11-18**; a reachable route (mirror or GEE) must be found, and GEE's commercial terms are **not evaluated** | 5.5 |
| NASA POWER | `reanalysis` (MERRA-2 derived) | 0.5° × 0.625° | daily / monthly | 1981 → present | precipitation, temp, radiation, humidity, agronomic set (`community=AG`) | point JSON API | NASA open data, attribution per NASA guidance, no blocker | usable as a cross-check baseline; not the system of record | 5.5 (optional) |
| GPM IMERG V07 | `satellite_estimate` | 0.1° | half-hourly → monthly | 2000 → present; **Final lags ~3.5 months**, so operational use would need Early/Late | precipitation only | GES DISC, GEE | US Government, effectively public domain; citation requested | out of Phase 5; belongs to verification (`OPEN-12`) | — |

Two documented contradictions in the 2026-11-18 research, recorded so they are not
inherited as facts:

- The BMKG probe window (`2026-11-18 05:00 → 2026-11-20 05:00`, 17 slots) is
  described in one file as "~48 h plus a partial third day" and in another as
  "≈72 h". The shorter reading is the measured one; treat the BMKG band as 48 h.
- The served coordinate `-6.221441/106.78094` is attributed in the matrix to both the
  Open-Meteo forecast grid and the ERA5 grid. Two different grids do not snap to the
  same point by design; re-check which probe produced it before citing it.

### 4.1 Constraints that this table is written to honour

1. **No 12-month daily forecast exists, and none is claimed.** Months 8–12 are
   `climatology`, labelled "Normal historis (1991–2020)".
2. **BMKG stays disabled by default** until written permission is on file. With the
   flag off, days 0–3 are Open-Meteo, labelled `weather_forecast` — never "BMKG".
3. **Open-Meteo free-tier commercial use is an assumption, not a fact.** Until
   `OPEN-03` is settled, the plan is treated as non-commercial and 5.4 must not be
   pointed at a production deployment.
4. **Climatology is never substituted for a failed forecast.** A missing seasonal
   month is `ingest_failed` / `provider_unavailable`, not `beyond_horizon`.
5. **A model anomaly is never an observed historical anomaly.**
   `model_anomaly` is primary; `baseline_difference` requires a grid-matched
   baseline **and** the disclosed `model_climate_offset_mm`.
6. **No skill or bias claim.** `bias_corrected` is `false` everywhere (schema CHECK),
   and `modelSkill` is `null` until Phase 9 verification exists.
7. **Provider facts, measurements, documented claims, and inference are kept
   separate** — the table above quotes documented capability as of 2026-11-18, and
   marks as unverified everything that was not measured here.

### 4.2 What must be revalidated, and for what

| Revalidate | Before | Evidence needed |
|---|---|---|
| BMKG permission + ToU §9.3 wording | any BMKG enablement | written permission, filed |
| Open-Meteo commercial plan (`OPEN-03`) | production deploy | contract or self-host decision |
| SEAS5 6-vs-7 monthly row split | 5.6 | one controlled response with the pinned `forecast_days` |
| EC46 daily/weekly shape and member count | 5.6 | one controlled response |
| Ensemble null boundary (day 14) | 5.4 | one controlled ensemble response per variable set |
| A reachable CHIRPS v3.0 route | 5.5 | a fetched month, or the decision to ship ERA5 |
| Set VII access route | any `annual_outlook` claim | licence reply + GRIB parse proof |
| Provider attribution strings | 5.4 | the licence text verbatim, stored beside the adapter |

A live call is **not** part of the ordinary test suite (§7.3).

---

## 5. Architecture

### 5.0 Components and where they live

```
provider ──▶ adapter ──▶ raw payload ──▶ normalizer ──▶ cell resolution ──▶ weather_records
                                                                                   │
                                                          climatology ─────────────┤
                                                                                   ▼
                                                                            aggregation
                                                                                   ▼
                                                                           monthly_outlooks
                                                                                   ▼
                                                                              read API
```

| Component | Location | Purity | Owns |
|---|---|---|---|
| Adapter (per provider/product) | `packages/weather-core/src/adapters/*` (**exists**; SEAS5 monthly only) | pure given `(request, now)` except for the injected fetch | request shape, response parse, provider error mapping, attribution |
| Normalizer | `packages/weather-core/src/normalize/*` (**exists**; monthly only, no unit conversion yet) | **pure** | unit conversion, `dataClass`, validity times, coverage accounting, record assembly |
| Cell resolution | `packages/weather-core/src/grids/*` (the registry instance; **not written**) + `@agroclimate/contracts` `grid.ts` (the pure resolver; **implemented**) | **pure** | `(provider, model)` → `GridSpec` selection; requested coordinate → `(i, j)`, anchor, `cellKey`. **Never** served coordinates, **never** distance |
| Ingestion pipeline | `apps/worker/src/ingest/*` | impure | run upsert, transaction, supersession, status transitions |
| Aggregation | `apps/worker/src/aggregate/*` + `packages/climate-core/aggregate/*` (the documented `climate-core`) | pure core, impure writer | daily/weekly/monthly rollup, anomaly, coverage, spread |
| Persistence | `packages/database/src/climate.ts` (new; not importable from `weather-core`) | impure | typed access to the six global tables, and to `field_outlook_cells` for the ingest-side mapping write |
| Read path | `apps/api/src/climate/*` (new module) | impure, read-only | `GET /v1/climate/outlook`, freshness computation |

Two rules that shape every file above:

1. **Provider-specific field names never leave `packages/weather-core/adapters`.** After
   the normalizer, nothing downstream can tell BMKG from SEAS5 — only `dataClass`,
   resolution, `forecastRunId`, and `ingestionRunId` remain (`data-flow.md` §1).
2. **The pure layers are pure.** Adapter parse, normalizer, cell rounding, and
   aggregation take data and return data. That is what lets the whole pipeline be
   tested from recorded fixtures with no network and no clock (§7).

`climate-core` does not exist yet (§8.7 adds it). `weather-core` exists as a package
since 5.1, but only the SEAS5 monthly adapter, the transport, and the monthly
normalizer are written; cells, the other adapters, and record assembly are not (§5.1.2). The
alternative — putting adapters inside `apps/worker` —
was rejected because `packages/contracts` cannot import from an app, and the
`WeatherValue` contract is the type these functions must return.

### 5.0.1 Package names are the architecture's, not this document's

`system-architecture.md` §3–§4 already names the two packages and fixes the
dependency directions: `weather-core` owns "provider adapters, normalization,
DataClass, horizon table", `climate-core` owns "monthly aggregation, anomalies,
climatology, outlook assembly", and two edges are forbidden —
`weather-core → database` ("adapters are pure; persistence is the caller's job") and
`climate-core → agronomy`. Three consequences:

- The worker owns every write. An adapter cannot reach `@agroclimate/database`.
- `climate` asks `weather` for a normalized series through a service; it does not
  query `weather_records` itself.
- Neither package exists yet. They are deliverables of 5.1 and 5.7, and adding them
  is the only new-package work in Phase 5.

### 5.1 Provider adapter boundary

An adapter is a named, versioned translation of one provider product into
`WeatherValue`s. It is the only place that knows a provider's URL, parameter names,
JSON shape, or error codes.

```ts
// packages/contracts/src/climate.ts — implemented (AdapterResult only; the
// HTTP adapter that produces it is still 5.1, unwritten)
interface AdapterRequest {
  cells: RequestedCell[];          // coordinates we ask for
  variables: VariableRequest[];    // logical names, adapter maps to provider names
  window: { from: IsoInstant; to: IsoInstant };
  forecastDays?: number;           // pinned where the provider truncates by it
}

type AdapterResult =
  | { kind: "complete";      /* answers every requested cell */ }
  | { kind: "partial";       /* answers some, leaves at least one */ }
  | { kind: "transport" }
  | { kind: "rate_limited" }
  | { kind: "request_invalid" }
  | { kind: "provider_changed" };
```

The success variants carry `meta`, `receivedAt`, `rawPayloadRef` (`null` when
retention is not permitted), `sourceUrl`, `observations`, and `coverage`. `meta`
holds the run identity, so the adapter does not mint an id: the worker does that
before the fetch and stamps the observation.

Coverage invariants (F-04), all enforced by `adapterCoverageSchema`:

- `requestedCells` is a **positive** integer; `answeredCells` a non-negative one.
  A request for zero cells is a programming error, not a result, so there is no
  division-by-zero case to define.
- `answeredCells ≤ requestedCells`.
- `coveragePercent = round(answeredCells × 10 000 / requestedCells) / 100` — basis
  points, rounded half away from zero, one implementation (`coveragePercentOf`) so
  producer and validator cannot disagree.
- **The counts are authoritative; the percentage is a representation.** `kind`
  is decided by `answeredCells` vs `requestedCells` alone. Rounding can produce
  `100` from an incomplete answer — 20 000 of 20 001 cells rounds to 100 — and
  that result is still `partial` (F-07). A validator that rejected a `partial`
  whose rounded percentage reached 100 would reject a legitimate answer, and a
  producer that promoted it to `complete` would claim coverage it does not have.
- `kind: "complete"` requires `answeredCells === requestedCells`.
- `kind: "partial"` requires `answeredCells < requestedCells`; its percentage may
  read 100 and the display must not turn that into "complete".
- The failure kinds are calendar-independent and carry no coverage at all, so a
  transport failure can never be mistaken for thin coverage.

Persistence: `ingestion_runs` stores `record_count` and `coverage_percent`
(`double precision`, `CHECK BETWEEN 0 AND 100`) and **no** requested/answered
counts. The database therefore cannot express the complete/partial distinction by
counts; `status` is the authority there, and a `status = 'partial'` row may carry
`coverage_percent = 100`. Nothing in the DDL contradicts the contract, and no
migration is required for F-07. A future migration that adds the counts would let
the database enforce what the status already asserts.

This rounding rule is scoped to the **run-level** coverage figure. An evidence
segment's `coveragePercent` (`provenance-contract.md` §3) keeps its own rule: it is
a share of days with a value, and a segment with missing days may not report 100.

Responsibilities, each with a reason:

| Responsibility | Rule | Why |
|---|---|---|
| Request construction | adapters accept **logical** variable names and map them internally | a downstream service that says `precipitation` must not learn that SEAS5 calls it `tp` with a rate unit |
| Initialisation time | read from the response; **never** inferred from wall clock | `initialized_at` is what freshness and the "initialized 5 November" label are computed from |
| Horizon | `horizon_end` derived from the provider's declared coverage, and truncated to the last instant that actually returned a value | a null past day 14 is horizon evidence, not a fetch failure (`data-flow.md` §8) |
| Units | converted to the documented stored unit, or the record is rejected | an unknown unit must never become a stored scientific value (`data-flow.md` §1) |
| Error classification | provider response → one of five classes in §5.1.1 | retry policy is a queue concern; the adapter must classify, not decide |
| Attribution | the licence string for that product, attached to every record and surfaced by the API | `ADR-001` D7 requires it on the record |
| Version | `adapterVersion` and `normalizerVersion` are code constants, exported and asserted in tests | they feed `ingestion_version`; an unversioned change would silently re-label history |
| Pinning | `forecast_days`, model name, and endpoint version are explicit constants | a provider default change must not silently move the horizon |

#### 5.1.1 Provider error taxonomy

| Class | Examples | Retry | Recorded as |
|---|---|---|---|
| `transport` | DNS, TLS, connection reset, 5xx | yes, exponential (1/5/20 m, 5 attempts) | `ingestion_runs.status = 'failed'`, `error.code = 'transport'` |
| `rate_limited` | 429, quota exhausted | yes, honour `Retry-After`; defer, do not fail | `status = 'queued'`, bucket decremented |
| `request_invalid` | 400, unknown model, bad parameter | **no** | `failed`, `error.code = 'request_invalid'`, payload ref logged |
| `provider_changed` | missing field, renamed variable, unexpected schema | **no**, and surface loudly | `failed`, `error.code = 'provider_changed'` — this is the class that means an adapter edit is required |
| `partial` | fewer rows/days than requested | **no** | `status = 'partial'`; `coverage_percent` may round to 100 when the shortfall is a fraction of a large request |
| `invalid_config` | bad coordinate, non-https base URL, missing required parameter | **no**, no request is made | `failed`, `error.code = 'invalid_config'` |
| `incomplete_horizon` | 6 monthly rows when 7 were required — the code-level name for `partial` where the short axis is not a coverage fraction | **no** | `status = 'partial'` |
| `invalid_payload` | negative precipitation amount, out-of-order month, empty series | **no** | `failed`, `error.code = 'invalid_payload'` |
| `unsupported_unit` | a unit with no approved conversion | **no** | `failed`, `error.code = 'unsupported_unit'` |

The last four exist in `packages/weather-core/src/failures.ts`; `partial` is split into
`partial` (coverage) and `incomplete_horizon` (axis) because a monthly series has no
cells to count. Both are recorded as `ingestion_runs.status = 'partial'`. `invalid_payload`
and `unsupported_unit` are the normalizer's two refusals: a value it cannot represent,
and a unit it must not convert.

`provider_changed` is separated from `request_invalid` on purpose: the first is our
bug or the provider's breaking change and needs a human; the second is a bad request
and retrying is pointless.

#### 5.1.2 Implemented adapters — 5.1

| Provider / product | Status | What exists |
|---|---|---|
| Open-Meteo seasonal, `ecmwf_seas5`, `monthly=precipitation_mean` | **implemented** | `adapters/open-meteo-seasonal.ts`: request build, HTTP classify, payload parse, month-axis validation |
| Open-Meteo daily (`forecast_days` ≤ 16) | **deferred** | needs record assembly (`weather_records`) and the daily coverage threshold; nothing to store it yet |
| ECMWF EC46 subseasonal | **deferred** | no monthly product, so no monthly target; daily assembly is `Q-P5-6` |
| ERA5 climatology | **deferred** | the dataset route is `Q-P5-4`/`OPEN-16`; no download verified |
| BMKG | **blocked** | written permission pending; never enabled |
| ECMWF Set VII | **blocked** | licence and GRIB proof of concept pending |

The SEAS5 request is pinned, not defaulted: `models=ecmwf_seas5`,
`monthly=precipitation_mean`, `forecast_days=217`. The provider's default horizon is
six months; seven rows require that explicit value, so a six-row answer is
`incomplete_horizon`, never a six-month outlook.

**Seven rows must also be seven consecutive calendar months** (`F-10`). A strictly
increasing axis is not a continuous one: a provider that drops January returns seven
ordered keys and no longer describes a seven-month horizon. Each key must be the
calendar successor of the previous one, computed as `year * 12 + month` adjacency
(`calendar-month.ts`) rather than by elapsed milliseconds or a `Date`, so
December → January rolls over correctly and no timezone can move a month. A gap, a
duplicate, a reversal, or an unparseable key is `provider_changed` at the adapter and
`invalid_payload` at the normalizer, naming the index and both months. The normalizer
enforces the same rule with the same function, because it is a separate boundary and
may later receive a monthly series from another source. This says nothing about what
`precipitation_mean` means — that is still `F-09` / `Q-P5-7`.

`initializedAt` is supplied by the
caller and recorded as `initializedAtSource: 'request_configuration'`, because the
payload reports no initialisation time and inferring it from the clock would corrupt
every freshness calculation downstream.

**The adapter stops at the provider's quantity.** It returns `variable:
'precipitation_mean'`, the provider's own `unit` string, and the untouched values. It
does not produce `valueMm`, a monthly total, an anomaly, or a `dataClass`. The domain
meaning of `monthly_outlooks.value_mm` for a `precipitation_mean` row is undecided
(`F-09` / `Q-P5-7`): a mean is not an amount, and converting one into the other would be
a scientific claim nobody has made.

The monthly normalizer validates and orders; it converts nothing. Only `mm` is
accepted, a null stays `provider_null` with no value, a negative or non-finite value is
refused, and the month key must be a first-of-month date whose every entry is the
**calendar successor** of the one before it — a continuous axis, not merely an ordered
one (`F-10`).
Its output carries `reproducible: false` with `raw_payload_not_retained` — the honest
state per §5.4, since nothing retains the bytes.

**Fixture provenance.** Every test payload is synthetic and labelled as such: it
reproduces the *shape* and the pinned parameters observed on 2026-11-18, not the
response bytes. No test touches the network, and no test asserts a value that only a
live provider could have produced.

### 5.2 Spatial resolution and cell identity

A field's geometry becomes a provider cell in one direction only:

```
field.geom ──▶ anchor point (centroid, v1) ──▶ requested (lat, lon)
             ──▶ grid resolver for (provider, model) ──▶ (i, j)
             ──▶ serialized cellKey ──▶ outlook_cells identity
provider response ──▶ served_lat / served_lon  (recorded, never derived)
             ──▶ field_outlook_cells (fieldId, provider, model, cell, distance, elevationDelta)
```

The last line is the **ingest** step, not the resolver. `field_outlook_cells` needs
`distance_km`, measured from the provider's served coordinate, so resolution stops at
the `outlook_cells` identity and writes no mapping row (§5.2.8).

#### 5.2.1 Six concepts, never merged

Conflating any two of these is the defect this section exists to prevent.

| Concept | Produced by | Stored as | Never |
|---|---|---|---|
| Requested coordinate | the field's anchor | `weather_records.requested_lat/lon` | treated as the cell identity |
| Grid definition | the grid registry, one per `(provider, model)` | code constant + `gridSpecHash` | inferred from a resolution figure |
| Selected cell | the resolver | indices `(i, j)`, then `cellKey` | recomputed from a served coordinate |
| Served coordinate | the provider's response | `outlook_cells.served_lat/lon`, `weather_records.served_lat/lon` | reconstructed from the request or from the key |
| Interpolation flag | the provider's response | `served_value_is_interpolated` | guessed from distance |
| `cellKey` | the serializer | `outlook_cells.cell_key` | parsed back to recover a coordinate |

`OPEN-18` is therefore narrower than "write down a rounding rule": the generic
resolver contract and the registry identity are decided, and the per-`(provider,
model)` grid constants are not.

**`OPEN-18` — owner decision 2026-11-21.** The generic contract is **approved**:
cell identity is computed by a provider/model-specific deterministic resolver whose
grid origin, spacing, orientation, and revision are explicit inputs; it is not
derived from a universal coordinate-rounding rule. The **provider grid
configurations remain pending external evidence** and are not asserted here.

#### 5.2.2 `GridSpec` — the only shape a resolver accepts

```ts
// packages/contracts/src/grid.ts — implemented
interface GridSpec {
  readonly gridId: string; // stable id of *this definition*, e.g. "synthetic-1deg"
  readonly originLat: string; // node of index (0, 0)
  readonly originLon: string;
  readonly stepLat: string; // positive; row spacing
  readonly stepLon: string; // positive; column spacing
  readonly latRange: readonly [string, string]; // both bounds are lattice points
  readonly lonDomain: "global" | "bounded";
  readonly lonRange?: readonly [string, string]; // required when bounded
  readonly orientation: "south-west"; // v1: the only supported orientation
  readonly rowCount: number; // derived: (latMax - latMin) / stepLat
  readonly colCount: number; // derived: 360 / stepLon, or (lonMax - lonMin) / stepLon
  readonly spatialResolutionKm: number;
  readonly gridSpecHash: string; // sha256 of the canonical JSON of every other field
}
```

Rules:

1. **Decimal strings, not floats.** `"0.25"`, `"-90"`, `"-180"`. Each is parsed
   once to integer micro-degrees (`µ° = value × 1e6`) and every identity
   computation is integer arithmetic. No `float` and no `Number` participates in a
   cell identity.
2. **Orientation is a resolver property, not a sign trick.** `stepLat` and
   `stepLon` are positive; the anchor names the corner. A provider with a
   north-to-south axis needs a resolver implementation, not a negative step.
3. **v1 supports one orientation: `south-west`.** Rows grow northward and columns
   grow eastward from `(originLat, originLon)`; a cell owns
   `[node, node + step)` on both axes. A north-to-south or east-to-west axis is a
   different resolver, not a negative step, and `defineGridSpec` rejects it with
   the typed `unsupported_grid_orientation` code. Nothing is silently flipped.
4. **v1 supports regular lat/lon grids only.** A curvilinear or genuinely reduced
   grid that cannot be expressed as `GridSpec` must fail as `provider_changed`
   rather than be approximated by a rectangle.
5. **A range bound must be a lattice point of the origin.** `(latMin - originLat)`
   and `(latMax - originLat)` must be whole multiples of `stepLat`, and the same
   for a bounded lon range. A grid anchored at 0° may therefore cover −90° with
   negative row indices; an offset lattice is rejected as `invalid_range`.
6. **The registry is keyed by `provider` + `model`; `gridId` is a label.** Two
   providers may expose the same model string with different grids, so neither name
   alone addresses a configuration (§5.2.9). `GridSpec` carries no provider or model
   field — that identity lives in the registry entry — and `gridId` names one
   definition without being globally unique: two different configurations may share
   it. `gridSpecHash` is computed from the configuration and includes `gridId`
   (§5.2.9), so an in-place edit changes the hash. Literal fixtures pin that hash
   (5.2.1, `44b278c`): the suite proves both that the hash is a function of its fields
   and that it equals four reviewed values, so editing the preimage fails a test.
7. **The spec is immutable at runtime, nested arrays included.** `defineGridSpec`
   copies `latRange` and `lonRange` into frozen arrays before storing them and
   freezes the resulting object, so a caller that mutates the array it passed in
   changes nothing and a consumer that writes to `spec.latRange[0]` throws. The
   registry stores a re-defined spec rather than the caller's object and returns
   that frozen value, so no lookup path hands out mutable internal state. Shallow
   `Object.freeze` on the outer object was the defect (F-06): every field became
   read-only while the two ranges did not.

#### 5.2.3 Mapping algorithm

```
resolve(spec, requestedLat, requestedLon):
  1. parse both coordinates as decimal strings; reject non-finite or > 6 dp
  2. reject unless lat is inside latRange
  3. lonDomain = "global"  → shift by ±360 until lon ∈ [originLon, originLon + 360)
     lonDomain = "bounded" → reject unless lon is inside lonRange
  4. i = floorDiv(latµ - originLatµ, stepLatµ)
     j = floorDiv(lonµ - originLonµ, stepLonµ)
  5. bounded grids: reject unless i and j are inside the range's lattice window
  6. nodeLatµ = originLatµ + i × stepLatµ
     nodeLonµ = originLonµ + j × stepLonµ
  7. key = serialise(nodeLatµ, nodeLonµ, decimals(spec))   // origin and step
  8. return { i, j, nodeLat, nodeLon, key, gridSpecHash }
```

Three details carry the determinism:

- **`floorDiv`, not truncation.** `floorDiv(-1, 4) = -1`; truncation gives `0` and
  would put `-0.1` in the same cell as `0.1`. This is the single most likely bug in
  a hand-written resolver, which is why it is a named golden vector (5.2.6 #9).
- **Half-open cells, lower edge inclusive.** A cell owns
  `[node, node + step)` on both axes, so a coordinate exactly on a grid line
  selects the cell whose lower edge is that line. Deterministic by construction,
  not by which way a float rounded.
- **Decimal input, not binary input.** A caller that holds a JS `number` renders it
  with `toFixed(6)` before parsing, so the same user value lands in the same cell
  across engines and across versions. The resolver never sees a raw float.

Longitude wrapping applies **only** to `lonDomain = "global"`, and only around
`originLon`. A regional grid is `bounded`; wrapping it would merge two cells the
provider distinguishes. Latitude is never wrapped.

#### 5.2.4 Serialization

`cellKey = "<lat>,<lon>"`, produced by one formatter:

- `decimals = max(2, decimalsOf(originLat), decimalsOf(originLon), decimalsOf(stepLat), decimalsOf(stepLon))`.
  The **origin** participates: an origin of `0.123456` on a `0.25` grid needs six
  places, and deriving precision from the step alone would collapse distinct cells
  onto one key. A value needing more places than six is rejected at registry load,
  not at ingest. (Review finding **F-01**.)
- Fixed-point, no exponent, no leading `+`, no spaces, negative allowed:
  `-6.25,106.75`.
- The value comes from the **integer node coordinate**, never from rounding the
  requested coordinate. `-6.2` and `-6.20` must not both exist; the formatter is
  the only producer, so they cannot.

`cell_key` stays `text` (`tables-climate.md` §1) and the key identifies the **cell
anchor**, not the served location. A provider that answers with an interpolated
point still has cells at anchors; the interpolation is recorded on the record, and
`served_value_is_interpolated` says so.

#### 5.2.5 Re-gridding and versioning

- A grid change that alters identity **requires a new `model` string inside the same
  `provider`** (for example `ecmwf_seas5_v2`). The registry binds one `GridSpec` per
  `(provider, model)` pair and refuses a second one; the revision is the pair, and
  the label (`gridId`) is free to repeat.
- The hash is the guarantee, and it is **pinned**: `assertGridSpecIntegrity` recomputes
  it, and four literal `gridSpecHash` fixtures in `grid.test.ts` were committed in
  5.2.1 (`44b278c`) — 1° global, the same lattice under a second `gridId`, 0.25°
  global, and 0.05° bounded. An edit to the resolver's preimage, to a preimage field,
  or to how `canonicalJson` serialises one now fails the suite. Writing the preimage
  object literal in a different order does not, because `canonicalJson` sorts keys.
- Old `outlook_cells` rows and old `field_outlook_cells` rows keep their model and
  keep their meaning. They are not rewritten. A field re-resolves under the new
  model on its next write, and `field_outlook_cells_live_key` supersedes the old
  resolution rather than updating it. The mapping row itself is written by ingest,
  not by resolution (§5.2.8).
- `UNIQUE (provider, model, cell_key)` therefore keeps meaning "one identity per
  provider and model per cell" across revisions, because the revision is part of the
  model string.
- **Rejected alternative:** embedding `gridId` in the key. It enforces the same
  invariant without relying on the model string, but duplicates the version in two
  places, lengthens every key, and diverges from the documented key format for no
  additional guarantee.

#### 5.2.6 Provider grid configurations — pending, not invented

No real grid is asserted in this document. An origin, a spacing, and an axis
orientation cannot be derived from a resolution figure, and **one** measured
request→served pair is not enough to derive them either: a pair from an endpoint
that interpolates says nothing about the lattice, and a pair that happens to land on
a plausible lattice is consistent with every origin in the same congruence class.
Evidence is therefore graded, and only the first two grades can ever promote a row.

| Grade | What it is | Sufficient for |
|---|---|---|
| **A — documented** | the provider's or model's own statement of grid spacing, origin/reference convention, axis order, and reduced/regular construction | spacing, axis, longitude convention; still needs one measured pair to confirm the served point is a node |
| **B — measured** | request→served pairs produced under the protocol below | node-vs-interpolation behaviour and the lattice step; the origin only up to its congruence class |
| **C — inferred** | a resolution figure, an approximate coordinate, or a neighbouring model's grid | **nothing**. Recorded as a hypothesis, never configured |

Validation protocol for grade B (run once per endpoint, record request, served,
elevation, timestamp, and whether the value equals the anchor):

1. At least three requests at distinct fractional offsets inside one cell — for
   example `+0.05`, `+0.37`, and `+0.83` of a step — with identical parameters
   otherwise.
2. One request just inside each side of a suspected boundary.
3. **Identical served coordinates for different requests prove snapping.** Distinct
   served coordinates prove interpolation; that endpoint cannot supply a grid and the
   row stays unavailable.
4. For a snapping endpoint, take differences of the served values: the greatest
   common step is the spacing, and the served value modulo the step is the origin's
   congruence class. Two different pairs that imply different steps stop the
   validation.
5. Confirm the provider's own interpolation flag, if the response carries one. A
   measured pair that the provider reports as interpolated is grade C for grid
   purposes no matter how round it looks.

| `provider` / `model` | Grid definition | Evidence needed before 5.2 |
|---|---|---|
| Open-Meteo / `ecmwf_ifs025` | **pending** | one measured pair exists and is ambiguous (the served point is on a plausible 0.25° lattice, but the same research calls it an interpolated point), so the row is grade C until protocol steps 1–3 separate the two readings |
| Open-Meteo / `ecmwf_ec46` | **pending** | the exposed point grid must be documented explicitly, because the upstream model is reduced Gaussian; a rectangle is not a substitute |
| Open-Meteo / `ecmwf_seas5` | **pending** | one served point at one request, not on a lattice under any assumed step; needs protocol steps 1–4 |
| ERA5 archive | **pending** | measured pairs; the single observed ERA5 served point is not on a 0.25° lattice, which must be explained before any regular grid is configured |
| CHIRPS v3.0 | **pending** | the reachable route and licensing posture first (`weather-source-matrix.md`), then the grid protocol |

Until a row is validated, the resolver exists but that model cannot ingest. That is
`BLOCKED_EXTERNAL_INPUT` in the decision register, not a design gap, and it is why
5.2's acceptance test is written against synthetic grids.

#### 5.2.7 Golden-vector specification (implemented)

Every vector is `(grid, input) → (i, j, key)`. The grids are **synthetic and
labelled as such**; none is a claim about a real provider. `origin` and `step` are
degrees, `domain` is `global` or `bounded`.

Vectors 1–18 are executed in `packages/contracts/src/grid.test.ts`. Vectors 13–16
exist because of review finding **F-01** (serialization precision), 17 because of
**F-02** (axis orientation).

| # | Grid: origin / step / domain | Input | `(i, j)` | Key | Served (synthetic) | Proves |
|---|---|---|---|---|---|---|
| 1 | `(0,0)` / `1,1` / global | `(0.5, 0.5)` | `(0, 0)` | `0.00,0.00` | `0.00,0.00` | interior point |
| 2 | `(0,0)` / `1,1` / global | `(0, 0)` | `(0, 0)` | `0.00,0.00` | `0.00,0.00` | lower edge is inclusive |
| 3 | `(0,0)` / `1,1` / global | `(1, 1)` | `(1, 1)` | `1.00,1.00` | `1.00,1.00` | an internal boundary starts the next cell |
| 4 | `(0,0)` / `1,1` / global | `(0.999999, 0.999999)` | `(0, 0)` | `0.00,0.00` | `0.00,0.00` | just below a boundary |
| 5 | `(0,0)` / `1,1` / global | `(1.000001, 1.000001)` | `(1, 1)` | `1.00,1.00` | `1.00,1.00` | just above a boundary |
| 6 | `(-90,-180)` / `0.05,0.05` / bounded | `(-6.21, 106.79)` | `(1675, 5735)` | `-6.25,106.75` | `-6.25,106.75` | non-zero origin, negative latitude, floor not trunc |
| 7 | `(0,0)` / `0.25,0.25` / global | `(-6.21, 106.79)` | `(-25, 427)` | `-6.25,106.75` | `-6.25,106.75` | one resolution |
| 8 | `(0,0)` / `0.4,0.4` / global | `(-6.21, 106.79)` | `(-16, 266)` | `-6.40,106.40` | `-6.40,106.40` | a different resolution for the same input yields a different cell |
| 9 | `(0,0)` / `1,1` / bounded `(-180,180)` | `(-0.1, -0.1)` | `(-1, -1)` | `-1.00,-1.00` | `-1.00,-1.00` | truncation would give `0.00,0.00`; bounded so wrapping does not apply |
| 10 | `(0,0)` / `1,1` / global | `(0, 359.5)` and `(0, -0.5)` | `(0, 359)` | `0.00,359.00` | `0.00,359.00` | longitude wrapping, both inputs agree |
| 11 | `(0,0)` / `1,1` / bounded, `latRange=(-90,90)`, `lonRange=(0,10)` | `(91, 0)` and `(0, 400)` | — | typed `out_of_grid` | — | invalid input produces no cell |
| 12 | same origin/step, different `gridId` | `(0.5, 0.5)` | same `(0,0)` | same key | `0.00,0.00` | a revision is a new **model**, not a new key format |
| 13 | origin `0.123456` / `0.25,0.25` / bounded `(0.123456,10.123456)`×`(0,10)` | `(0.2, 0.2)` | `(0, 0)` | `0.123456,0.000000` | `0.123456,0.000000` | **F-01**: the origin needs more places than the step; two decimals would have written `0.12` |
| 14 | origin `10.5` / `0.25,0.25` / bounded `(10.5,12.5)`×`(10.5,12.5)` | `(10.6, 10.6)` | `(0, 0)` | `10.50,10.50` | `10.50,10.50` | **F-01**: a non-zero fractional origin stays exact |
| 15 | origin `-10.5` / `0.25,0.25` / bounded `(-10.5,10.5)` | `(-0.6, -0.6)` | `(39, 39)` | `-0.75,-0.75` | `-0.75,-0.75` | **F-01**: negative origin and negative anchor |
| 16 | vector 6's grid, re-resolved at vector 6's anchor | `(-6.25, 106.75)` | `(1675, 5735)` | `-6.25,106.75` | `-6.25,106.75` | **F-01**: serialization round-trips without losing the integer micro-degree node |
| 17 | any grid with `orientation: "north-west"` | `(0.5, 0.5)` | — | typed `unsupported_grid_orientation` | — | **F-02**: an unsupported axis is rejected, never flipped by a negative step |
| 18 | origin `0` / `0.25,0.25` / bounded `(0.1,10)` | `(0.5, 0.5)` | — | typed `invalid_range` | — | a range bound that is not a lattice point is a configuration error |

Every synthetic grid is node-serving, so a synthetic fixture may record that its
`served` coordinate equals its anchor. That is a property of the fixture, not a
resolver output: the resolver returns no served coordinate, and no production path
may copy the anchor into one. A live provider that interpolates returns a different
served coordinate with `served_value_is_interpolated = true`, and the key still comes
from the cell — that is the case the synthetic vectors cannot cover, so 5.1 records
the provider's answer verbatim and the flag.

Vector 8 is exact only for the synthetic grid; it is there to prove that resolution
changes identity, not to predict a provider's answer. What the suite asserts per
vector is the key round-trip to the node it was built from (`grid.test.ts:224`).

The vectors do not assert a `gridSpecHash`; the four literal fixtures in §5.2.5 do,
in the same file.

#### 5.2.8 Two-phase cell write

Forced by the column grants, unchanged by this reconciliation: `app_api` may
insert only `(provider, model, cell_key)` into `outlook_cells`; `app_system` fills
`served_lat`, `served_lon`, `elevation_m`, `spatial_resolution_km`. The ingest job
performs the second write. A cell created by a user's field therefore exists before
its coordinates do — the documented lifecycle ("`NULL` until first ingest"), not an
error state.

**Field → cell mapping waits for the served coordinate (owner decision 2026-11-21).**
`field_outlook_cells.distance_km` is `NOT NULL` and is defined as the geodesic
distance from the anchor to the **served** coordinate, which does not exist until the
first ingest. Resolution therefore stops at the cell identity: it may mint the
`outlook_cells` row, and it must not write a `field_outlook_cells` row. `0` is never
a placeholder for an unknown distance, and the anchor is never substituted for the
served coordinate to manufacture one. The mapping row is created by the ingest that
first learns the served coordinate, or by a later migration that makes the column
nullable — not by a fabricated value.

#### 5.2.9 Phase 5.2 design addendum — registry identity, result, longitude

Approved 2026-11-21. **Partially implemented.** Steps 5.2.1, 5.2.2 and 5.2.3 landed at
`44b278c`, `965f528` and `6963709`: the literal hash fixtures exist, the registry is
keyed by `(provider, model)` with declared evidence, and `SpatialResolution` with
`GRID_RESOLUTION_ALGORITHM_VERSION` exists in `grid.ts`, assembled by
`createSpatialResolution` after it re-checks the entry's `gridSpecHash`. The registry
instance, the centroid read, persistence and the route are **not** implemented — the
5.2 steps in §8.2 say which is which.

##### 5.2.9.1 Registry identity is `(provider, model)`

`ADR-001` D8 says the rounding rule is per model, and the pipeline already speaks
`(provider, model, product)` everywhere (`ForecastRun`, `outlook_cells_grid_key`,
`weather_records`). A model string is a provider's own name for its model and is not
unique across providers: Open-Meteo re-exports ECMWF models under strings it chooses,
and a second provider may use the same string for a different lattice. Keying the
registry by `model` alone therefore lets the wrong grid serve a request.

```ts
// implemented — packages/contracts/src/grid.ts
interface GridKey { readonly provider: string; readonly model: string }
type GridEvidence = "synthetic" | "validated";

interface GridRegistryEntry {
  readonly provider: string;
  readonly model: string;
  readonly spec: GridSpec;          // carries gridId, gridSpecHash, no identity
  readonly evidence: GridEvidence;  // "validated" only with §5.2.6 grade A + B
}

interface GridRegistry {
  specFor(key: GridKey): GridSpec;                    // unknown → typed failure
  resolve(key: GridKey, r: GridResolutionRequest): ResolvedGridCell;
  evidenceFor(key: GridKey): GridEvidence;
  requireValidated(key: GridKey): GridSpec;           // ingest paths only
}
```

| Property | Rule |
|---|---|
| duplicate registration | same `(provider, model)` twice → `duplicate_grid_spec`, at construction |
| unknown key | `unknown_model` naming both components; no fallback, no nearest match, no other provider's grid |
| revision | a re-grid is a new `model` string within the **same** provider; no in-place edit, enforced by the pinned hash (§5.2.5) |
| immutability | the registry stores a re-defined frozen spec and returns it, as in `createGridRegistry` today |
| synthetic vs validated | `evidence` is on the entry, not inferred from `gridId`. A synthetic entry resolves (tests, dev) and `requireValidated` refuses it, so an unvalidated grid cannot reach ingestion |
| `gridId` | a label on the definition, may repeat across providers and models; never a lookup key |
| lookup by model alone | **not provided.** A model-only convenience would reintroduce the ambiguity this change removes |

`gridSpecHash` **keeps** `gridId` in its preimage (`grid.ts:185-217`). The hash's job
is to pin one named definition, and the label is part of what is reviewed and
committed; dropping it would change every hash that will ever exist, for no gain,
before any hash is persisted. Consequence to state plainly: two byte-identical
lattices under different `gridId`s hash differently. That is intended — they are two
reviewed definitions — and it does not affect `cellKey`, which carries only the node.

**Status.** The identity layer and the result contract are implemented. At `965f528`
the registry in `grid.ts` is keyed by `(provider, model)`, entries declare
`GridEvidence`, `requireValidated` refuses a `synthetic` entry, and four literal
`gridSpecHash` fixtures pin the preimage (`grid.test.ts`). 5.2.3 added
`SpatialResolution` and `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"`, with a
`createSpatialResolution` assembler that copies the requested coordinate verbatim and
the anchor from the resolver's own node. The result shape of §5.2.9.2 now exists; the
HTTP layer's `servedCoordinate: null` and `extractionPolicy` still do not, and
5.2.4–5.2.7 are unbuilt.

Two limits worth stating, because the code cannot enforce them. `GridEvidence` is a
**declared** value: `requireValidated` rejects an entry declared `synthetic`, but no
code verifies the grade A + B documents behind a `validated` entry. Admission to that
string is a review decision, not a runtime check. And no provider grid is registered
at all, so every real model still fails with `unknown_model`.

Compatibility: this was a **deliberate breaking change** to `createGridRegistry`, not
an extension, and it has landed. There was no production consumer (`grep` found
`resolveGridCell`, `createGridRegistry`, `specFor` only in the test file), so the blast
radius was `grid.test.ts` plus the suite. A model-only overload was rejected because
Decision 6 forbids selecting a grid by model name alone; a second parallel registry
was rejected because it would duplicate the resolver and force two lookups for one
identity. `CONTRACTS_VERSION` (`packages/contracts/src/version.ts`) and the package
version both moved `0.1.0` → `0.2.0`, since the exported signature broke. The decision
is recorded in `docs/adr/ADR-007-spatial-registry-identity.md`.

##### 5.2.9.2 The resolution result names three coordinates

Three coordinates exist and must never merge: **requested** (what entered the
resolver), **anchor** (the cell's own node, derived from `i`/`j`), **served** (what
the provider answered). The resolver knows the first two. It cannot know the third,
so it does not return it.

```ts
// implemented — packages/contracts/src/grid.ts, assembled by createSpatialResolution()
interface SpatialResolution {
  readonly provider: string;
  readonly model: string;
  readonly gridId: string;
  readonly gridSpecHash: string;
  readonly resolutionAlgorithmVersion: string; // GRID_RESOLUTION_ALGORITHM_VERSION
  readonly evidence: GridEvidence;
  readonly requested: { readonly lat: string; readonly lon: string };
  readonly anchor: { readonly lat: string; readonly lon: string };  // nodeLat/nodeLon
  readonly i: number;
  readonly j: number;
  readonly cellKey: string;
}
```

`GRID_RESOLUTION_ALGORITHM_VERSION` is `"grid-resolve/1"`, and the field's type is
`GridResolutionAlgorithmVersion`, the literal type of that constant — so the contract
cannot silently carry an arbitrary version string. `createSpatialResolution(entry,
request)` first re-checks `entry.spec.gridSpecHash` with `assertGridSpecIntegrity`, so a
hand-built entry or an in-place edited lattice fails with `grid_spec_hash_mismatch`
before any result exists. Beyond that it adds no validation: `resolveGridCell` rejects
an unparseable or out-of-grid request, and a failure throws before an object is minted.
It reads `evidence` from the entry as declared and never upgrades it.

| Field | Why it is there | Why nothing else is |
|---|---|---|
| `provider`, `model` | the registry key that selected the grid; without them the hash is unattributable | — |
| `gridId`, `gridSpecHash` | the exact definition and its pin; required to audit an old key | — |
| `requested` | the input, as supplied, decimal-string | a float would re-introduce binary rounding |
| `anchor`, `i`, `j` | proof the key came from the lattice, not from rounding the request | `i`/`j` are internal but cheap and make a support report readable |
| `cellKey` | the `nodeLat,nodeLon` form the DB stores | **unchanged format**: `UNIQUE (provider, model, cell_key)` already supplies the other two components, so embedding them would duplicate the key |
| `resolutionAlgorithmVersion` | a constant in `grid.ts`, bumped when the algorithm or the key format changes — **not** derived from the package version | one row, `gridSpecHash`, and this string reproduce the cell; two of the three would not |
| `evidence` | says whether this result may feed ingestion | — |
| `served` | **absent** | the resolver has no provider response; an HTTP layer may write `servedCoordinate: null` so a client cannot read the anchor as served |
| `distanceKm` | **absent** | unknowable before the served coordinate exists (§5.2.8) |
| `extractionPolicy` | **absent from the resolver** | a field concept, not a grid concept; it belongs to the mapping that 5.2 defers |

Reuse check: `Reproducibility` is about retained raw payload bytes and
`DerivationProvenance` is about derived artifacts with `inputRefs`. A cell identity
is neither — it is a pure function of a pinned configuration — so a focused
`SpatialResolution` is smaller and more truthful than wrapping the grid in a
provenance envelope with an empty `inputRefs`, which `provenance.ts:204-205` rejects
anyway.

`ResolvedCell` is the near miss, and it is deliberately not used: it exists
(`provenance.ts:104-112`) but requires `servedLat`, `servedLon`, and a non-negative
`distanceKm`, so a value of that type cannot exist before the first ingest. Reusing
it would force exactly the fabrication §5.2.8 forbids. `SpatialResolution` is a new,
smaller type; `ResolvedCell` keeps its present meaning in field snapshots.

##### 5.2.9.3 Longitude: four separate questions

| Concept | Question it answers | Scope |
|---|---|---|
| coordinate normalization | is `-180` the same position as `180`? | generic, representation only |
| grid-domain validation | is this position inside the grid's declared lon domain? | per grid |
| longitude wrapping | which 360° window does the grid number its columns in? | per grid, `global` only, around **its own** origin |
| cell index calculation | which column owns the position? | per grid, `floorDiv` |

Approved behaviour — current implementation, no change proposed in this pass. The
worked examples use `stepLon = 1` and a `global` domain.

| Input | `originLon = 0` | `originLon = -180` | bounded `[0, 360)` | Reading |
|---|---|---|---|---|
| `-180` | wraps to `180`; `j = 180`, key `0.00,180.00` | `j = 0` | `out_of_grid` (below the domain) | valid geographic coordinate; the grid's origin decides the column |
| `180` | `j = 180` — **same cell as `-180`** | wraps to `-180`, `j = 0` — **same cell as `-180`** | `j = 180` | accepted as a coordinate. It is the antimeridian, so a global grid must fold it onto one cell; which one is the origin's business |
| `0` | `j = 0` | `j = 180` | `j = 0` | the same position, a different column; no normalization changes it |
| `360` | wraps to `0`, `j = 0` | wraps to `0`, `j = 180` | `out_of_grid` (index window: `j = colCount`) | accepted only by wrapping on a `global` domain; never clamped |
| `-0.5` | wraps to `359.5`, `j = 359` | `j = 179` | `out_of_grid` (below the domain) | west-of-Greenwich position in a `[0, 360)` numbering |
| `359.5` | `j = 359` — **same cell as `-0.5`** | `j = 179` | `j = 359` | east-of-Greenwich position, same cell under a 0-origin global grid |

A grid whose declared upper bound *is* the position (`bounded [-180, 180]`, upper
edge `180`) excludes it, because a cell owns `[node, node + step)`: there, `180` is
`out_of_grid` and the antimeridian must be requested as `-180`. That asymmetry is a
consequence of the half-open rule, not a second wrapping rule.

The `bounded [0, 360)` column records what the resolver does with that configuration
today. It is **not** a recommendation that a provider's `[0, 360)` convention must be
modelled that way — that choice is question 3 below and is not made.

What is deliberately **not** decided here (owner approval required, recorded in
`OPEN-18`):

1. Whether generic coordinate validation rejects `|lon| > 180` before wrapping. Today
   it does not: `400` resolves to a cell. Tightening it is a contract change and
   would invalidate golden vector 10's `359.5` input.
2. Whether `180` should map to the lower edge on a `[-180, 180)`-origined grid
   (antimeridian folding) instead of failing as the exclusive upper edge. Both are
   defensible; they must not both be implemented.
3. How a provider whose convention is `[0, 360)` is expressed: a `global` domain with
   `originLon = 0` (today's only route) or a bounded `[0, 360)` grid.
4. Whether `lonRange` gains the absolute bound that `latRange` already has
   (`grid.ts:278`), so `["0", "400"]` stops being a legal configuration
   (`grid.ts:295-309`).
5. Whether `spatialResolutionKm` belongs in the hash preimage. It is a descriptive
   figure (`tables-climate.md`: "36 for EC46/SEAS5, ≈28 for ERA5"), not part of the
   lattice, yet it is hashed today. Correcting a published resolution figure
   therefore changes `gridSpecHash` and, under the one-spec-per-pair rule, forces a
   new model string although no cell identity changed. Keeping it is defensible — the
   hash pins the whole reviewed definition — but it must be a stated choice, and no
   answer is recorded yet.

Approved, and not re-opened: wrapping stays around the grid's own origin; latitude is
never wrapped; a regional grid stays `bounded`, because wrapping it would merge two
cells the provider distinguishes.

### 5.3 Run lifecycle and idempotency

The two identities are the existing ones and no third is introduced.

| Question | Answer |
|---|---|
| What is one run? | `ForecastRun` — `(provider, model, product, initialized_at)`, UUIDv7 id |
| What is one ingest? | `IngestionRun` — `(forecast_run_id, ingestion_version)`, where `ingestion_version = sha256(adapterVersion, normalizerVersion, targetSelectorHash)` |
| What is one retry? | `attempt` on that row, incremented in place. Never a new row |
| What is one job? | `ingest:{queue}:{forecastRunId}:{targetSelectorHash}` |

Lifecycle, end to end:

1. **Discover.** The scheduler knows the provider's cadence, not a user request.
   SEAS5: the 5th, 12:00 UTC, ingest +30 min with per-cell jitter. EC46: daily after
   ~20:30 UTC. Short-range: hourly-ish, cell-grouped. Climatology: once per
   `baseline_version`.
2. **Resolve identity before fetching.** `targetSelectorHash` is computed from the
   requested `(cellKey, variable)` set for that job, so the job id is stable and a
   duplicate enqueue is dropped by id rather than by a second check.
3. **Upsert the run.** Insert-or-find by natural key. Fetching the same run twice
   creates nothing.
4. **Upsert records.** On the live uniqueness key
   `(forecast_run_id, cell_key, variable, valid_at, ensemble_member)` with
   `NULLS NOT DISTINCT`, so a deterministic re-ingest collides instead of appending.
5. **Supersede, never delete.** A changed `normalizerVersion` creates a new
   `IngestionRun` under the **same** `ForecastRun` and sets `superseded_by_id` /
   `superseded_at` on the rows it replaces. A normalization fix must never surface
   to a user as a new forecast.
6. **Record outcome.** `status ∈ {queued, running, partial, succeeded, failed}`,
   `record_count`, `coverage_percent`, `error {code, message, payloadRef}`,
   `finished_at` (enforced by `ingestion_runs_finished_check`).
7. **Trigger downstream.** On success, enqueue aggregation for the affected cells;
   aggregation supersedes `monthly_outlooks`; the recompute fan-out is Phase 6.

Reprocessing rules that must be encoded, not remembered:

| Event | Expected effect |
|---|---|
| Same job re-delivered (at-least-once) | zero new rows, zero new runs |
| Process died mid-write | the transaction rolls back; `attempt` increments on retry |
| Normalizer bug fixed | new `IngestionRun`, same `ForecastRun`, rows superseded |
| Target cell set changed | new `IngestionRun` (different `targetSelectorHash`) |
| Provider republishes the same init | same `ForecastRun`; records upsert |
| Run past its TTL | nothing is deleted; freshness makes it stale at read time |

Recovery after provider failure is **not** a backfill of cells that were never
ingested: the provider retains members for about one month, so a late registration
reports `spreadUnavailable` rather than inventing a mean (`ADR-001` D8b).

### 5.4 Raw payload and normalized records

| Question | Decision |
|---|---|
| What must be retained | nothing by default in Phase 5; the normalized row is the system of record |
| May a payload be retained | only where the provider's licence allows it, recorded per adapter |
| Where | an object store key in `ingestion_runs.raw_payload_ref` — **the store does not exist yet** |
| What a normalized record must contain | every column of `weather_records`, all of which are either provider facts or provenance: `provider`, `model`, `data_class`, `variable`, `value`, `unit`, `valid_at`, `initialized_at`, `requested_lat/lon`, `served_lat/lon`, `served_value_is_interpolated`, `spatial_resolution_km`, `temporal_resolution`, `ensemble_member/size`, `bias_corrected=false`, `aggregation_level`, `source_url`, `attribution`, `normalizer_version` |
| Unit conversion boundary | at the normalizer, once. The stored `unit` is post-conversion and is what the UI prints |
| Malformed payload | reject the record, fail the job with `payloadRef`, never store a guessed value |
| Incomplete payload | accept what exists, record coverage, `status = 'partial'`, never extrapolate |
| Reproducibility | an artifact built on a non-retained provider payload is `reproducible: false` with `unreproducible_reason = 'raw_payload_not_retained'` |

**`OPEN-05` — owner decision, 2026-11-21: retention is deferred, not abandoned.**
Do not build it in the initial release. Reasons: the
object store is new infrastructure with its own access control; Open-Meteo's free
tier imposes terms that are themselves unresolved (`OPEN-03`); and the honesty cost
is already representable — `reproducible: false` with a stated reason is exactly what
`provenance-storage.md` §7 designed for. Retention becomes worth building when
(a) a paid or self-hosted plan makes it lawful, and (b) the first verification run
needs to re-derive a score. Until then, `raw_payload_ref` stays `NULL` and no artifact
claims replayability it cannot deliver.

The distinction that must survive in code and in prose: **`reproducible: false` is not
missing provenance.** The artifact still names its provider, model, run ids, cell,
requested and served coordinates, initialization time, and derivation version. What
it cannot do is re-run the adapter on the original bytes. A record with no `inputRefs`
is a different and worse defect, and the two must not collapse into one "not
reproducible" flag.

**`OPEN-16` — owner decision, 2026-11-21: no automatic pruning, measure first.**
Retention of `weather_records` is not urgent at
Phase 5 scale, and the growth figure in the research (≈56 000 rows per ensemble run)
is a per-run-per-cell-set estimate that must be measured against the real cell count
before any policy is chosen. The committed direction for the initial release, to be
reassessed — not implemented — after the first month of 5.4 traffic:

- Never delete a row referenced by any `input_refs` — the hash audit depends on it.
- Superseded rows are retained; they are the audit trail of a normalization change.
- Delete whole **runs** only, by age, and only when no derived artifact references
  them; a run is the smallest safe unit because a partial delete breaks coverage
  accounting.

`climatology_normals` is outside this policy: a baseline version is never pruned,
because every stored anomaly names it.

### 5.5 Temporal semantics and aggregation

No new vocabulary. `temporal-and-weather-semantics.md` is binding, including
`valid_at` / `initialized_at` / `ingested_at` / `received_at` / `computed_at`, the
Asia/Jakarta calendar, and the horizon map.

What Phase 5 must add is the **aggregation boundary**, stated as four rules:

1. **A daily value is a Jakarta calendar day.** The UTC → Jakarta conversion happens
   once, in the aggregator, and the result is keyed by `date`. Two conversions in two
   code paths is how a day lands in the wrong month.
2. **Daily needs ≥ 1 valid hourly value and a coverage figure.** A day with 3 of 24
   hours is not a daily sum; it is a partial day with `coverage_percent ≈ 12.5`.
   Below the coverage threshold (a 5.0 decision) the day is absent, not zero.
3. **Monthly is a month key (`date`, day 1) and never a 30-day span.** Aggregation
   from daily to monthly uses the calendar month in Jakarta, and the monthly
   outlook's `month` column is written with `EXTRACT(DAY) = 1` (schema CHECK).
4. **A month is supplied by one product that has a monthly quantity**, and the
   class names that product:
   a live SEAS5 monthly row within TTL → `seasonal_forecast`; else the month is
   genuinely beyond the seasonal horizon → `climatology` with
   `missing_reason = 'beyond_horizon'`; else the month is `pending` /
   `ingest_failed` / `provider_unavailable` with **no** value.

   This is a **capability** rule, not an ordering preference. The observed
   provider evidence decides it:

   | Class | Reach | Monthly product | A whole calendar month? |
   |---|---|---|---|
   | `weather_forecast` | 16 d | none | no |
   | `subseasonal_forecast` | 46 d | none — `models=ecmwf_ec46&monthly=…` returns **0 rows** | no |
   | `seasonal_forecast` | 7 mo | SEAS5 monthly, 6–7 rows observed | **yes** |
   | `annual_outlook` | 8–13 mo | Set VII, access unverified | not permitted |
   | `climatology` | any | 1991–2020 normal | **yes** |

   So a subseasonal month would have to be aggregated from EC46 daily values,
   which needs a coverage threshold and an aggregation rule that do not exist
   (`Q-P5-6`). The earlier "EC46 covering the month → `subseasonal_forecast`"
   branch assumed a monthly product that the provider does not return; it is
   corrected here rather than left to be discovered by an adapter.

   The class names the **source product** for that month, not a per-day band and
   not the evaluation basis, and a calendar month is not a 30-day window.

   A month whose days come from two products is **not** representable:
   `monthly_outlooks` has one `data_class` and the contract has one field.
   Whether to support that, and how, is `Q-P5-5` — not decided here. Partial
   coverage stays honest the other way: below the coverage threshold the month
   has no value at all (`below_coverage_threshold`), never a value with a
   misleading class.

   **`monthly_outlooks.data_coverage_percent` is deliberately unpopulated in
   5.0.** A provider-supplied monthly quantity has no day-level coverage to
   report, and the contract does not carry the field. It becomes meaningful only
   if daily→monthly aggregation is adopted (`Q-P5-6`); the column stays nullable
   for that reason and no migration is needed.

The month cell therefore reports two independent axes: forecast availability and
climatology availability. `monthly_outlooks` has no `data_availability` column, so
both are computed at read time (§5.7).

### 5.6 Provenance and data quality

Existing contract, no extension except where listed.

Every normalized value is explainable because it carries `forecastRunId`,
`ingestionRunId`, `cellKey`, requested and served coordinates, `initializedAt`,
`validAt`, `spatialResolutionKm`, `temporalResolution`, `ensembleMember/Size`,
provider, model, `dataClass`, `sourceUrl`, and `attribution`. Every derived artifact
carries `inputRefs[]`, `fieldSnapshotHash` where applicable, `inputSnapshotHash`,
`derivationVersion`, and `computedAt`.

Five uncertainty quantities stay five, and none of them is a percentage score:

| Quantity | Source | May not be rendered as |
|---|---|---|
| Data coverage | `ingestion_runs.coverage_percent`, per-month `data_coverage_percent` | "confidence" |
| Ensemble spread | `monthly_outlooks.ensemble_spread_mm` or `spread_unavailable_reason` | a probability |
| Forecast probability | only from ensemble members or a published probability | a score |
| Model skill | `null` until Phase 9 | any number |
| General uncertainty | qualitative text | a number |

`grade` A–D is evidence quality and is never a probability
(`provenance-storage.md` §8).

Two quality checks the pipeline must perform on itself, because the schema cannot:

1. **Dangling reference audit.** `input_refs` holds ids with no foreign keys
   (`provenance-storage.md` §2). A periodic audit resolves every `forecastRunIds`,
   `ingestionRunIds`, `baselineVersion`, and `observationIds` entry and reports
   orphans. It reads; it never rewrites.
2. **Coverage reconciliation.** `coverage_percent` on the ingestion must equal the
   fraction of requested `(cell, variable, valid_at)` tuples that produced a non-null
   value. A disagreement means either the adapter overstated coverage or rows were
   dropped, and both are silent lies about a month.

### 5.7 Storage and read path

#### 5.7.1 Is the existing schema sufficient?

Reviewed against the applied catalogue, table by table.

| Table | Exists | Sufficient for Phase 5? | Limitation, if any |
|---|---|---|---|
| `outlook_cells` | yes | **yes** | `spatial_resolution_km` is nullable "until established"; the adapter must fill it on first ingest or the field snapshot cannot describe resolution |
| `forecast_runs` | yes | **yes** | `horizon_end` derivation differs per product and has no documented rule; that belongs in the adapter, not a migration |
| `ingestion_runs` | yes | **yes for forecast products; no for dataset-shaped ingest** | no `dataset_version` column. CHIRPS v3.0 and ERA5 are datasets, not forecasts; their version must go somewhere. Recommendation: model the dataset version inside the `model` string (`chirps_v3.0_1991-2020`) and use `product = 'archive'`, rather than adding a nullable identity column with one consumer. Revisit if verification (`OPEN-12`) needs independent dataset versioning |
| `weather_records` | yes | **yes** | `data_class` CHECK excludes reanalysis and satellite estimates by design; a CHIRPS row therefore has nowhere to live. Phase 5 handles this by storing CHIRPS **as climatology normals only** (aggregated into `climatology_normals`), not as `weather_records`. A raw CHIRPS record set is a verification concern (`OPEN-12`) |
| `monthly_outlooks` | yes | **yes for precipitation** | `variable = 'precipitation'` only. Temperature outlooks need a second migration once the assembly rule for temperature exists; not Phase 5 |
| `climatology_normals` | yes | **yes** | no `baseline_hash` column by design; must be computed over the consumed subset |
| `field_outlook_cells` | yes | **yes** | no `created_at` (creation instant is `resolved_at`, per the consistency checklist); `area_weighted` policy exists and is unimplemented |
| dead-letter / `sync_attempts` / watermark | **no** | **deferred** (`Q-P5-2`) | `background-processing.md` §10 names `sync_attempts` and a dead-letter surface that have no table. Structured logs + `ingestion_runs.error` + `ingestion_runs_running_idx` for stuck detection is enough for 5.4; a migration is written only if a query cannot answer a real question |

**No migration is proposed by this phase.** Two are foreseeable — a temperature
outlook variable, and dataset versioning — and both are cheap when the need is real.
Neither is needed to ship a precipitation outlook.

#### 5.7.2 Read path

```
GET /v1/climate/outlook?fieldId=…
  → authenticate; authorize field → user (existing guard + ownership)
  → resolve the field's live cells from field_outlook_cells   (one query, tenant-scoped)
  → read monthly_outlooks for those cells, 12 month keys, status = 'active'
  → compute freshness per source from forecast_runs.initialized_at and baseline_version age
  → assemble 12 months, each with dataClass, missingReason, coverage, spread
  → envelope: { data: { months: [...] } }, per api-conventions.md §2
```

Rules:

- **No provider call on a GET.** No on-the-fly aggregation.
- **No class substitution on read.** A month that is `ingest_failed` is returned as
  such; the read path may never promote it to climatology.
- **Freshness is computed, never stored.** A stored flag is correct once.
- **The 12 months are always 12 rows.** A month with nothing is returned with
  `missingReason`, because omission is indistinguishable from "not asked".
- **The read is `app_api`'s existing grants.** No new grant, no `BYPASSRLS`, no
  `app_system` in the request path.
- **Status semantics are `api-conventions.md` §3, not this document.** A
  stale-but-usable month is `200` with `freshness.dataAvailability = "stale"` and a
  reason; an absent month whose ingest is running is `202` with `retryAfter`; an
  absent month whose ingest failed is `503 PROVIDER_UNAVAILABLE`. There is no
  `DATA_STALE` status. `429 RATE_LIMITED` applies (reads: 300 req/min per user) with
  the three `RateLimit-*` headers.
- **`freshness` is per value.** `weather.ts` requires it on every `WeatherValue`, so a
  12-month response carries twelve freshness objects, not one page-level timestamp.

Cost: three indexed reads (`field_outlook_cells_field_idx`,
`monthly_outlooks_cell_month_idx`, `forecast_runs_recent_idx`) and one ownership
check. No `weather_records` scan on the request path — that series is the
aggregator's input, not the API's.

Delivery of a *recompute* is not this endpoint's job: a new run triggers aggregation
and (Phase 6) the recompute fan-out. The read path only reads.

---

## 6. Failure handling and observability

### 6.1 Failure semantics (binding, from `background-processing.md` §8, restated here because phase 5 implements them)

| Situation | Required outcome | Forbidden outcome |
|---|---|---|
| Provider down for a forecast cycle | days in that band report `ingest_failed` / `provider_unavailable` | filling the band from a coarser class |
| Partial payload | store what exists, `status = 'partial'`, `coverage_percent < 100` | extrapolating or marking complete |
| Normalization rejects a record | job fails with `payloadRef`, no value stored | storing a guessed unit or value |
| Aggregation fails | previous `monthly_outlooks` rows stay `active` | deleting them, or writing a `failed` row over a good one |
| Cell never registered before a run | `spreadUnavailable` / `pending` | backfilling from a mean, or claiming `beyond_horizon` |
| Seasonal run older than 35 d | month is `stale` at read time (computed) | relabelling it `climatology` |

The single rule under all of them: **missing data is missing.** A placeholder row is
worse than an absent one, because it is indistinguishable from a measurement.

### 6.2 Minimum observability

Everything below is derivable from state Phase 5 already stores, plus structured
logs. No monitoring stack is introduced.

| Signal | Source | Notes |
|---|---|---|
| Ingestion success / failure rate | `ingestion_runs.status` over `started_at` | per provider and per queue |
| Provider latency | `ingestion_runs.started_at` → `finished_at`, plus the adapter's recorded fetch duration | p50/p95 per provider |
| Rate-limit consumption | token-bucket counters; `attempt` and `status = 'queued'` show deferral | per provider, per day |
| Payload size | what the normalizer counted | no number is stored yet; `Q-P5-2` is deferred |
| Records received / accepted / rejected / persisted | adapter counts + `ingestion_runs.record_count` | the four must reconcile; a gap means silent drops |
| Coverage per cell and run | `ingestion_runs.coverage_percent`, per-month `data_coverage_percent` | the honesty metric |
| Forecast freshness | computed from `forecast_runs.initialized_at` at read time | never stored |
| Retry count | `ingestion_runs.attempt` | in-place counter |
| Dead-letter count | `ingestion_runs.status = 'failed'` with a terminal `error.code`, or a store if one is added | no table today |
| Normalization errors | `error.code = 'request_invalid'` vs `'provider_changed'` | the second one is a page |
| Ingestion lag | `initialized_at` → first `succeeded` `finished_at` | the metric that says whether a 12-month view is current |

Correlation: `forecastRunId` is the spine. A job id, an `ingestion_run`, every
`weather_record`, and every derived `input_refs` entry resolve to it. Log lines carry
`forecastRunId`, `ingestionRunId`, `cellKey`, `queue`, `attempt`. A user request is
traced by `fieldId` → `field_outlook_cells` → `cellKey` → `forecastRunId`.

Alerting is Phase 9 work (`background-processing.md` §9); Phase 5 only has to make
the numbers *queryable*, which is why `ingestion_runs` already carries them.

---

## 7. Verification strategy

### 7.1 What runs without any provider

| Test | What it proves | Fixture |
|---|---|---|
| Adapter parse | a recorded provider payload becomes the expected `WeatherValue[]` | one recorded response per product, committed under `test/fixtures/providers/` |
| Adapter error mapping | each provider failure shape maps to one of the five classes | recorded error bodies (`400`, `404`, `429`, `500`, schema change) |
| Normalizer unit conversion | mm/day, `m/s` rate → mm/month, K → °C, Indonesian slot → Jakarta day | hand-computed tables, including a 28/29/30/31-day month for the rate conversion |
| Timestamp semantics | no naive timestamp survives; provider value without a zone is rejected | table of instants |
| Cell-key determinism | the same requested coordinate always yields the same `(provider, model, key)`; the key is the **anchor node**, and the served coordinate is a separately recorded fact | golden table per synthetic grid, §5.2.7 |
| Idempotency | the same payload ingested twice produces zero new rows and zero new runs | real database, real roles |
| Supersession | a bumped `normalizerVersion` creates a new `IngestionRun`, same `ForecastRun`, old rows superseded | real database |
| Partial payload | `status = 'partial'`, coverage recorded, no extrapolation | truncated fixture |
| Aggregation boundaries | day → week → month in Jakarta, month keys on the 1st, no 30-day "month" | fixture series across a month end and a year end |
| Class assembly | the documented order, and every `missingReason` state | fixture availability matrix |
| Provenance | every produced artifact's `input_refs` resolves; `inputSnapshotHash` is reproducible | contracts golden vectors + database |
| Retention policy | a pruned run leaves no dangling `input_refs` | real database |

### 7.2 What needs the real database and real roles

Tenant and privilege checks are not simulated: `test:rls` and `db:verify` connect as
`app_api` / `app_system` over TCP. Phase 5 additions follow the same pattern — the
aggregator runs as `app_system`, the read path as `app_api` inside `withTenant`, and
the negative assertions pin SQLSTATEs (`42501` for privilege, `23503` for a
cross-tenant key) rather than accepting any error.

`field_outlook_cells` writes are tenant-owned and must be proven under
`withTenant(ownerId)`; a test that runs them as `migration_owner` would prove nothing
about production.

### 7.3 What needs a live provider, and is therefore opt-in

Live calls are **not** part of `pnpm test`. One controlled probe per provider runs
manually, once per sub-phase, and its response is committed as the fixture the
offline suite then uses. That inverts the usual dependency: the network is used to
*record*, and never to *pass a test*.

Consequence for honesty: an adapter merged without a recorded fixture has untested
parsing, and the pull request says so.

### 7.4 Not verified by any of this

Forecast accuracy, bias, and skill. Nothing in Phase 5 measures whether SEAS5 is
right over the maritime continent; that is `OPEN-12` and Phase 9, and no Phase 5
artifact may imply otherwise.

---

## 8. Implementation sequence

Nine sub-phases. Each ends in something reviewable and independently useful; none is
a pure abstraction layer. Dependency graph:

```
5.0 ──▶ 5.1 ──▶ 5.2 ──▶ 5.4 ──┐
 │        │        │           ├──▶ 5.7 ──▶ 5.8
 │        └──▶ 5.5 ─┴───────────┤
 │                 │            │
 └──▶ 5.3 ─────────┴──▶ 5.6 ────┘
```

### 8.0 Phase 5.0 — foundation decisions and contracts

| | |
|---|---|
| Objective | every decision, contract, and test fixture that 5.1–5.8 depends on exists, is executable, and is recorded in the register — and no provider-specific implementation is started |
| Prerequisites | this document approved; the 2026-11-21 owner decisions recorded in `docs/data-model/open-decisions.md` |
| Scope | **Delivered:** `packages/contracts/src/climate.ts` (run identities, `AdapterResult`, `MonthlyOutlook`), `packages/contracts/src/grid.ts` (resolver, registry, `gridSpecHash`), `packages/contracts/src/provenance.ts` (reproducibility shape), `packages/contracts/src/weather.ts` (`valueBase` → `singleValueEvaluationBasisSchema`), plus `climate.test.ts` / `grid.test.ts`. **Not delivered:** `packages/weather-core/cells/` (weather-core is 5.1's package, not created here), `apps/worker/src/queue/contract.ts` (the job interface belongs to 5.3), `packages/database/src/climate.ts` (no row types needed yet), and the `OPEN-14` vocabulary freeze |
| Contracts | `ForecastRun` (+ natural identity), `IngestionRun` (+ `ingestionVersionOf`), `AdapterResult` (five classes), `GridSpec`, `GridRegistry`, `ResolvedGridCell`, `MonthlyOutlook` (+ `OutlookMonth` band rules), `DerivationProvenance` / `Reproducibility`. `ResolvedCell` is reused from `provenance.ts` rather than duplicated |
| Database impact | **none.** The `jobs` table belongs to 5.3, not 5.0 |
| Tests | `grid.test.ts` executes vectors 1–18 of §5.2.7, orientation rejection, lattice rejection, hash-mismatch detection, the four literal `gridSpecHash` fixtures, a `(provider, model)` registry (duplicate pair, unknown pair, one model string under two providers, one `gridId` on two pairs, declared evidence, `requireValidated` rejection), the `SpatialResolution` cases (algorithm version, identity components, requested ≠ anchor, frozen result and nested coordinates, no served coordinate or distance, a failed request mints nothing, a hash-mismatched entry rejected), coordinate rejection, and the F-06 immutability cases (input copy, frozen nested ranges, frozen registry value). `climate.test.ts` covers `mixed` rejection, run identity and version derivation, the five adapter classes, the `reproducible` / `inputRefs` distinction, the F-04 coverage invariants, the F-05 month cross-field rules, the F-03 twelve-month horizon, the F-07 count-authority cases, and the monthly source-capability cases. `pnpm --filter @agroclimate/contracts test`: **392 passed** after 5.2.1–5.2.3 (354 at 5.0) |
| Acceptance | met: `mixed` is **rejected** on a single value; vectors 1–18 pass, including negative-floor, longitude-wrap, and origin-precision cases; `reproducible: false` needs a reason and empty `inputRefs` fails on `inputRefs`; a complete result at less than 100% is rejected; a duplicate, missing, or out-of-order lead month is rejected; a mutated `GridSpec` range is impossible; **not met yet:** the queue interface, which moved to 5.3 |
| Dependencies | — |
| Risks | freezing a vocabulary too early (`OPEN-14`) — still deferred, not guessed at; contract churn while 5.1 is written — mitigate by versioning adapter and normalizer constants in 5.1, not the row contracts |

Two layout deviations from the original scope, both deliberate:

1. **The resolver lives in `packages/contracts/src/grid.ts`, not
   `packages/weather-core/cells/`.** Creating a package for one pure module would
   have introduced a workspace boundary with no consumer; `weather-core` is still
   5.1's package. `grid.ts` depends only on `canonical.ts` and `hash.ts`, so moving
   it later is a file move, not a rewrite.
2. **`ForecastRun` / `IngestionRun` live in `climate.ts`, not `weather.ts`.** They
   are the climate plane's identity contracts; `weather.ts` stays the value
   contract. `valueBase` was changed there as planned.

`AdapterResult` also grew from the §5.1 success sketch into the five-class
discriminated union of §5.1.1: a result type that cannot express `rate_limited`
would force the adapter to throw, which loses the classification the queue needs.

#### 8.0.1 Corrective passes — F-03…F-10 (2026-11-21)

A review of the delivered contracts produced four findings, all fixed in place. No
new file, dependency, or sub-phase.

| Finding | Correction |
|---|---|
| **F-03** | `leadMonth` is 1-based, `1–12` inclusive. `MONTHLY_OUTLOOK_BANDS` is `1–7` (`seasonal_forecast`) and `8–12` (`climatology`) after the source-capability correction below; the 1–2 band no longer admits short-range classes. `monthlyOutlookHorizonSchema` enforces exactly twelve entries, in order, one per lead month, each bound to `calendarMonthOf(firstMonth, leadMonth)` — a pure year-rollover-safe resolver. Zero-based numbering is gone from every public contract |
| **F-04** | `coveragePercentOf` is the single rounding rule (basis points, half away from zero); `requestedCells ≥ 1` removes the zero-request case instead of defining it; `complete` requires 100%, `partial` requires an unanswered cell; counts and percentage must agree |
| **F-05** | `outlookMonthSchema` cross-checks `dataClass` against `evaluationBasis`: climatology only with the climatology basis, forecast only with the monthly basis, pending with the monthly basis and no value. Every issue carries the offending path |
| **F-06** | `defineGridSpec` copies and freezes `latRange`/`lonRange`, freezes the spec, and the registry stores a re-defined frozen spec rather than the caller's object |
| **F-07** | Complete/partial is decided by `answeredCells` vs `requestedCells` only. A rounded 100 from an incomplete answer stays `partial`; the percentage is display, not status. `ingestion_runs` stores no counts, so `status` is the authority there and a `partial` row may read 100 — no migration needed |
| **F-08** | 5.1 adds a real `@agroclimate/weather-core` package — transport, failure union, SEAS5 monthly adapter, monthly normalizer — with no dependency beyond the workspace `zod` catalogue entry. Transport owns bytes/status/timeout/body cap and nothing else; adapters classify, they never retry; the normalizer refuses instead of converting |
| **F-09** | `precipitation_mean` is a **mean**, and `MonthlyOutlook.valueMm` reads as a monthly amount. No approved definition says they are the same quantity, so the adapter and normalizer stop at the provider-native series and populate no `valueMm`. The decision — whether a monthly outlook stores a mean, a total derived by an approved rule, or gains a separate column — is `Q-P5-7`, owner-owned and open |
| **F-10** | A seven-row monthly axis is not a seven-month forecast: strictly increasing keys can still skip a month. The adapter and the normalizer both require each key to be the calendar successor of the previous one, using one shared `year * 12 + month` adjacency check (`calendar-month.ts`) with no `Date` and no elapsed-time division. Row count alone is never completeness |

Capability status after 5.0, stated so no reader infers more than exists:

| Capability | Status |
|---|---|
| Generic `GridSpec` resolver | **Implemented** — `packages/contracts/src/grid.ts`, eighteen synthetic vectors |
| Generic grid hash and registry | **Implemented.** `gridSpecHash` with four literal fixtures (`grid.test.ts`), and `createGridRegistry` keyed by `(provider, model)` with declared `GridEvidence` and `requireValidated` (5.2.2 at `965f528`) |
| Golden grid resolver tests | **Implemented** — vectors 1–18 plus F-06 immutability |
| Provider-specific grid configurations | **Pending external evidence** — all five |
| Field-to-cell resolution service | **Not implemented** |
| Persisting resolved cells | **Not implemented** — no migration, no query |
| Served-coordinate assignment | **Not implemented** |
| Provider adapters | **Partially implemented** — SEAS5 monthly only; daily, EC46, ERA5 deferred, BMKG and Set VII blocked (§5.1.2) |
| HTTP transport | **Implemented** — `packages/weather-core/src/http.ts`, cap + timeout + AbortSignal, no retry |
| Normalizer | **Partially implemented** — monthly validation/ordering only; no unit conversion, no record assembly |
| Queue, worker, scheduler | **Not implemented** |

### 8.1 Phase 5.1 — adapter and normalization foundation

| | |
|---|---|
| Objective | one real provider payload can be turned into contract-valid records, offline |
| Prerequisites | 5.0 |
| Scope, as built | `@agroclimate/weather-core` created with `src/{failures,http,runtime,index}.ts`, `src/adapters/open-meteo-seasonal.ts`, `src/normalize/monthly.ts`; `apps/worker` untouched |
| Scope, changed | the plan named `adapters/open-meteo-forecast.ts` (daily) first. SEAS5 monthly was built instead: it is the only product with a verified monthly quantity, and it is the only class a monthly outlook accepts at lead months 1–7. The daily adapter is deferred because it needs record assembly and the daily coverage threshold |
| Contracts | `failures.ts` derives its four shared failure kinds from the contract's `AdapterResult` (`Extract<AdapterResult, { kind: … }>["kind"]`), so a rename there fails this package at compile time instead of letting two unions drift. `weather-core` depends on `@agroclimate/contracts` for that. Its own `AdapterOutcome<T>` stays narrower on purpose: the contract's success variants need observations and a cell-count coverage figure, which a monthly series does not have |
| Not built | `normalize/*` does not produce `{ values, coverage, rejects }` or `weather_records`-shaped records — it validates a monthly series and stops at the provider's quantity (F-09). `fixtures/*` do not exist; the tests build labelled synthetic payloads inline |
| Database impact | none |
| Tests | 36 in `weather-core` — request pinning and determinism, 429/400/5xx/302 mapping, invalid config with no request made, six-row horizon, malformed month keys, unequal array lengths, non-JSON body, null preservation, calendar continuity on both sides of the boundary (missing month, rollover gap, duplicate, reversal, year crossing), and the normalizer's refusals |
| Acceptance | met for the SEAS5 monthly boundary: the request is reproducible from explicit config, a short axis is refused, a schema change is classified as `provider_changed`, and the output never claims a monthly total |
| Dependencies | 5.0 |
| Risks | over-fitting the normalizer to one payload shape; mitigate with three fixtures of different lengths |

### 8.2 Phase 5.2 — cell resolution and field mapping

| | |
|---|---|
| Objective | the resolver exists and is proven; 5.2 adds provider/model selection, a reproducible result, and the centroid read, so a field yields a deterministic cell identity. It does **not** create the field → cell mapping |
| Prerequisites | 5.0 (resolver), 5.1 (grid metadata) |
| Scope | the registry instance and its synthetic entry in `packages/weather-core/src/grids/` (the resolver stays in `@agroclimate/contracts` — no second implementation, no `weather-core/cells/`); `SpatialResolution` in `packages/contracts`; `upsertCell` in `packages/database/src/climate.ts` and `selectFieldAnchor` in `fields.ts`; `POST /v1/fields/:id/resolve-cell`. **No** `field_outlook_cells` write (§5.2.8) |
| Contracts | `SpatialResolution`, `GridKey`, `GridRegistry`, `GridEvidence` (§5.2.9); `ResolvedGridCell` is reused unchanged. `GridKey`, `GridEvidence`, `GridRegistryEntry` and the `(provider, model)` registry landed in 5.2.2, and `SpatialResolution` with `GRID_RESOLUTION_ALGORITHM_VERSION` in 5.2.3. The existing `ResolvedCell` (`provenance.ts:104-112`) is left alone — it requires served coordinates and a `distanceKm`, so it cannot hold a pre-ingest result. No `CellKey` is added, no second `ResolvedCell`, and no `distanceKm` |
| Database impact | none new. `outlook_cells` identity only — three columns, `GRANT INSERT (provider, model, cell_key)` (`migration.sql:737`). No table, column, grant, RLS or migration change. No `field_outlook_cells` row: `distance_km` is `NOT NULL` and needs a served coordinate that does not exist yet |
| Tests | the eighteen vectors of §5.2.7 unchanged; a literal `gridSpecHash` per registered spec; registry keyed by `(provider, model)` — duplicate pair rejected, unknown pair rejected, one `gridId` on two pairs accepted, two providers sharing one model string independent; synthetic entries refused by `requireValidated`; the result keeps requested ≠ anchor and carries no served coordinate; `ST_Centroid` → six-decimal anchor |
| Acceptance | all eighteen vectors still pass; editing the hash preimage or a spec field fails the fixture; the same field anchor always resolves to the same `cellKey`; an unknown pair **fails** with `unknown_model` and mints no cell; a synthetic entry cannot reach an ingest path; `field_outlook_cells` is untouched; no cross-tenant anchor is readable |
| Dependencies | 5.0, 5.1 |
| Risks | the centroid of a large plot falling near a grid boundary (two cells differ by one step), documented and unsolved while `OPEN-15` is undecided; no real model resolves until its grid configuration reaches §5.2.6 grade A + B, so 5.2 lands while 5.4 waits on evidence |
| Deferred to 5.4 | the `field_outlook_cells` row, `distance_km`, `elevation_delta_m`, supersession on geometry edit — every one of them needs the served coordinate |

**Implementation sequence.** 5.2.1, 5.2.2, 5.2.3 and 5.2.8 are implemented;
5.2.4–5.2.7 are not. The step numbers are the ones other sections cite.

| Step | Objective | Files | Acceptance | Depends on | Status |
|---|---|---|---|---|---|
| 5.2.1 | pin `gridSpecHash` with a literal fixture | `packages/contracts/src/grid.test.ts` | editing the resolver's preimage or a spec field fails the suite | — | **Done** — `44b278c`. Four literals: 1° global, 1° relabelled, 0.25° global, 0.05° bounded |
| 5.2.2 | registry key → `(provider, model)`; add `evidence`, `requireValidated`; drop model-only lookup | `packages/contracts/src/grid.ts` | duplicate pair rejected; unknown pair rejected; one `gridId` on two pairs accepted; two providers sharing one model string independent; `CONTRACTS_VERSION` bumped | 5.2.1 | **Done** — `965f528`. `CONTRACTS_VERSION` and the package version are `0.2.0` |
| 5.2.3 | `SpatialResolution` + `resolutionAlgorithmVersion` | `packages/contracts/src/grid.ts` | requested ≠ anchor; no served coordinate; hash and evidence present | 5.2.2 | **Done** — `6963709`. `SpatialResolution`, `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"`, and `createSpatialResolution`, which re-checks `gridSpecHash` before resolving; twelve tests |
| 5.2.4 | registry instance with one labelled synthetic entry | `packages/weather-core/src/grids/{registry,synthetic}.ts` | unknown pair fails; a synthetic entry is not ingestion-eligible | 5.2.2 | Pending — no such file exists |
| 5.2.5 | field anchor via `ST_Centroid(geom)` inside `withTenant` | `packages/database/src/fields.ts` | known square → known six-decimal anchor; a cross-tenant field is invisible | — | Pending |
| 5.2.6 | `upsertCell` — three columns, `ON CONFLICT DO NOTHING` | `packages/database/src/climate.ts` (new) | a second resolve reuses the cell id; no fourth column attempted | 5.2.4 | Pending — `climate.ts` does not exist |
| 5.2.7 | `POST /v1/fields/:id/resolve-cell` | `apps/api/src/field/*` | 200 twice identical; unknown pair and out-of-grid are typed failures that mint nothing; no mapping row | 5.2.4–5.2.6 | Pending — no route is mounted |
| 5.2.8 | reconcile status and §8.1 after the code lands | `IMPLEMENTATION_STATUS.md`, this document | no section claims an unimplemented guarantee | all | **Done** — `1dff5fd`. Recorded 5.2.1–5.2.2 as implemented and 5.2.3–5.2.7 as pending. 5.2.3 then landed at `6963709`; §8.2 now reads 5.2.1–5.2.3 and 5.2.8 done, 5.2.4–5.2.7 pending |

### 8.3 Phase 5.3 — run lifecycle and worker runtime

| | |
|---|---|
| Objective | a job can be enqueued, claimed, retried, deduplicated, recovered after a crash, and recorded against `forecast_runs` / `ingestion_runs` — on PostgreSQL alone |
| Prerequisites | 5.0 |
| Scope | `apps/worker/src/queue/postgres.ts`, `apps/worker/src/ingest/run.ts`, `apps/worker/src/main.ts`, `packages/database/src/climate.ts` (`upsertForecastRun`, `upsertIngestionRun`, `markIngestionStatus`), the `jobs` migration |
| Contracts | the `Job` lifecycle from 5.0; `targetSelectorHash` (`sha256` over the sorted `(cellKey, variable)` set) |
| Database impact | **one additive migration**: a `jobs` table (id, kind, payload, run_at, lease_expires_at, attempt, max_attempts, status, last_error, unique idempotency key). No Redis, no new dependency. `sync_attempts`, a separate dead-letter table, and a sweep watermark remain **unbuilt** and are not implied by this table |
| Tests | §7.1 rows 6–7; two workers claim disjoint jobs under `FOR UPDATE SKIP LOCKED`; a lease expires and the job is reclaimed with `attempt` incremented in place; a duplicate enqueue is dropped by the unique idempotency key; `ingestion_runs_finished_check` holds on every transition |
| Acceptance | ingesting the same fake payload twice leaves exactly one `ForecastRun`, one `IngestionRun`, and an unchanged row count; a killed worker's job is reclaimed after lease expiry without minting a second row or a second run; graceful shutdown releases the lease and leaves the job claimable; `SKIP LOCKED` alone is shown by test **not** to be sufficient (the lease and attempt assertions fail if it is removed) |
| Dependencies | 5.0 |
| Risks | the queue choice becomes load-bearing — mitigate by keeping the interface narrow and the job semantics (atomic claim, lease, retry, dead-letter, idempotency) independent of the backing; a Postgres queue under load becomes a poller hotspot — measure before tuning, and treat a move to Redis as a backing swap behind the same interface |

### 8.4 Phase 5.4 — short-range forecast ingestion

| | |
|---|---|
| Objective | 0–14 days of real forecast values for a field's cells |
| Prerequisites | 5.1, 5.2, 5.3 |
| Scope | `packages/weather-core/adapters/open-meteo-forecast.ts` (live), `…/open-meteo-ensemble.ts`, `apps/worker/src/ingest/forecast.ts`, `ingest.forecast` queue wiring |
| Contracts | `WeatherValue` forecast variant |
| Database impact | none; writes `weather_records` as `app_system` |
| Tests | §7.1 rows 1–7 and 10; the day-14 ensemble null truncation asserted from a recorded payload |
| Acceptance | one scheduled run stores deterministic and ensemble rows for a real cell; `horizon_end` equals the last non-null instant; a 429 defers instead of failing |
| Dependencies | 5.1, 5.2, 5.3 |
| Risks | free-tier budget exhaustion and no commercial permission — both `OPEN-03`, and both must be settled before this runs on a schedule; the model's grid configuration must be validated first (§5.2.6) |

### 8.5 Phase 5.5 — climatology baseline

| | |
|---|---|
| Objective | 1991–2020 monthly normals per cell, versioned — the class that fills months 8–12 |
| Prerequisites | 5.1, 5.3 |
| Scope | `packages/climate-core/climatology.ts` (baseline builder), `packages/weather-core/adapters/open-meteo-archive.ts` (ERA5), `apps/worker/src/ingest/climatology.ts` |
| Contracts | `baselineVersion`, `baselineHash` over a consumed subset |
| Database impact | none; writes `climatology_normals` |
| Tests | a hand-computed 30-year mean for one cell and month; a rebuild with a changed dataset produces a **new** `baseline_version` and leaves the old one intact |
| Acceptance | 12 normals per cell for one `baseline_version`; `sample_years` recorded; no row edited in place |
| Dependencies | 5.1, 5.3 |
| Risks | ERA5's ~25–34 % under-representation of convective rainfall is unverified locally; the baseline is labelled by dataset, and CHIRPS is preferred the moment a route exists |

### 8.6 Phase 5.6 — seasonal ingestion (EC46 and SEAS5)

| | |
|---|---|
| Objective | months 2–7 (`seasonal_forecast`) and days 15–45 (`subseasonal_forecast`) |
| Prerequisites | 5.3, 5.4 (a working pipeline), 5.2 |
| Scope | `packages/weather-core/adapters/open-meteo-seasonal.ts`, `apps/worker/src/ingest/seasonal.ts`, `ingest.climate` queue |
| Contracts | monthly and daily seasonal variants; ensemble-member aggregation |
| Database impact | none; `weather_records` for EC46 daily, and monthly aggregates for SEAS5 |
| Tests | the pinned `forecast_days` → 6-or-7 row assertion; spread computed from members (never from a nonexistent monthly spread variable); a truncated seasonal response is `partial`, never a 5-month outlook |
| Acceptance | one SEAS5 run yields the asserted number of monthly values per cell, each with `data_class = 'seasonal_forecast'`; an EC46 run yields daily values to day 45 and none past it |
| Dependencies | 5.3, 5.4, 5.2 |
| Risks | monthly-only resolution being over-read as daily; the read path's `evaluationBasis` is the only guard, so it must be exercised |

### 8.7 Phase 5.7 — aggregation and climate read API

| | |
|---|---|
| Objective | `GET /v1/climate/outlook?fieldId=…` returns 12 labelled months from stored data |
| Prerequisites | 5.5 (climatology alone is enough for a first honest release), 5.2 |
| Scope | `packages/climate-core/aggregate.ts`, `apps/worker/src/aggregate/outlook.ts`, `apps/api/src/climate/*`, `packages/contracts/src/climate.ts` (response schema) |
| Contracts | `MonthlyOutlook` response: month key, `dataClass`, `valueMm`, `missingReason`, coverage, spread, freshness per source |
| Database impact | none; writes and reads `monthly_outlooks` |
| Tests | §7.1 rows 8–9; §7.2 read-path tenancy; a month with `ingest_failed` is not promoted; a 12-month response always has 12 entries |
| Acceptance | with only climatology ingested, the API returns 12 entries: **five** (lead months 8–12) labelled `climatology` with `missing_reason = 'beyond_horizon'`, and lead months 1–7 present as `pending` / `not_requested` with no value, so no month claims a forecast; with seasonal data present, lead months 3–7 change class and 8–12 do not |
| Dependencies | 5.2, 5.5 (minimum), 5.4 and 5.6 (for a complete timeline) |
| Risks | shipping a read API before the data exists and calling it done; the acceptance criterion above is written to prevent exactly that |

### 8.8 Phase 5.8 — data quality and operations

| | |
|---|---|
| Objective | the numbers can be trusted and the pipeline can be run |
| Prerequisites | 5.4, 5.5, 5.6, 5.7 |
| Scope | `packages/climate-core/audit.ts` (dangling refs, coverage reconciliation), `apps/worker/src/maintenance/*`, `docs/operations/climate-ingestion.md` (runbook, new) |
| Contracts | none new |
| Database impact | possibly one migration for a dead-letter/attempt history, per `Q-P5-2` |
| Tests | coverage mismatch is detected and reported; an orphan `forecastRunIds` entry is reported without rewriting; the maintenance sweep touches no tenant table |
| Acceptance | one week of scheduled runs produces a report whose counts reconcile with `ingestion_runs`; zero tenant-row writes from `app_system` |
| Dependencies | 5.4–5.7 |
| Risks | building monitoring before there is data to monitor; this is why it is last |

### 8.9 What "first usable capability" means here

After 5.7 with climatology only, a farmer can be shown **five** correctly labelled
months of historical normals (lead months 8–12) plus an explicit pending state for
the months that require a forecast — not twelve months presented as normals, which
would be the same substitution the product forbids. After 5.6, lead months 3–7
become a real seasonal forecast. After 5.4, days 0–14 become a real short-range forecast.
That is the order in which the product becomes useful, and it is why 5.5 precedes
5.6 and 5.4 rather than following them.

The count is a contract, not a convenience: 0–14 d is `weather_forecast`, 15–45 d is
`subseasonal_forecast`, lead months 3–7 (five) are `seasonal_forecast`, and lead
months 8–12 (five) are `climatology`. Lead month is 1-based, `1–12`, exactly twelve
entries, no month 0 and no month 13. A 12-month response always has twelve entries
and never promotes one class into another to fill the grid.

---

## 9. Decision status

`docs/data-model/open-decisions.md` is the **authoritative** register. This section is
a view of the items Phase 5 depends on, with the fields that register records. It is
not a second register, and it closes nothing: a decision is only settled when the
register says so and the deliverable exists.

### 9.1 Recorded by the owner, 2026-11-21

| ID | Decision | Rationale | Scope | Status | Revisit condition |
|---|---|---|---|---|---|
| `OPEN-18` | A provider/model-specific deterministic grid resolver; grid origin, spacing, orientation, and revision are explicit inputs; a change that alters identity requires a new `model` string within the same `provider` | A universal `floor(lat / resolution)` assumes a zero origin, square cells, and one axis orientation, none of which is established for any provider; and an in-place rule change would silently re-point historical cells | The generic resolver contract, the serialization rule, and the `(provider, model)` registry identity (§5.2.2–§5.2.5, §5.2.9). **Not** any provider's actual grid constants | **Generic contract, identity layer and result contract implemented.** Resolver, eighteen vectors, four literal `gridSpecHash` fixtures, the `(provider, model)` registry with declared `GridEvidence`, and `SpatialResolution` at `grid-resolve/1` exist in `packages/contracts` (5.2.1–5.2.3); v1 accepts `south-west` only. The registry instance and every field→cell write do not exist. Provider grid configuration pending external evidence | A provider re-grid, which creates a new `model` string; or a grid that cannot be expressed as `GridSpec`, which becomes a resolver implementation |
| `Q-P5-1` | PostgreSQL is the initial queue backing, using row locking and `FOR UPDATE SKIP LOCKED` behind a narrow job interface | PostgreSQL is already required; Redis and BullMQ would be new infrastructure with no operational evidence yet; the documented job semantics survive a backing swap | Job claiming, leases, retries, attempts, idempotency, dead-letter state, observability, transaction boundaries, and shutdown (§8.3) | **Owner-approved architecture decision.** No `jobs` table, no queue code, no dependency. Implementation is 5.3 | Measured contention or polling cost on the `jobs` table; a multi-region worker requirement; or a queue feature (scheduling at scale, fan-out) that is expensive to express in SQL |
| `OPEN-03` | Do not commit to a paid Open-Meteo plan yet; commercial operation is conditional on verified licensing and an appropriate commercial plan; the free tier is not used for commercial operation; self-hosting is not assumed to resolve licensing or redistribution terms | Price, quota, attribution, and permitted use are unresolved, and a plan chosen before 5.4 exists would be a guess | Commercial deployment legality and any `raw_payload_ref` retention. Not the schema, not the adapter | **Deferred** pending commercial and cost evaluation. Not closed | Before any commercial deployment; after pricing, quotas, attribution, and permitted-use terms are reviewed |
| `OPEN-05` | Defer durable raw-payload retention for the initial release; normalized records carry sufficient provenance to identify origin and transformation; artifacts that cannot be reproduced record `reproducible: false` with a machine-readable reason; no full-reproducibility claim | An object store is new infrastructure with its own access control, and the provider terms that would make retention lawful are unsettled; the honesty cost is already representable | `ingestion_runs.raw_payload_ref`, object storage, and the `reproducible` claim. Not the normalized row, which is the system of record | **Owner-approved deferral.** No store, no writer. Reopening is a later phase | A lawful paid or self-hosted plan, known storage cost, and a verification run that must re-derive a score |
| `OPEN-16` | No automatic pruning for the initial release; preserve existing data; measure growth and query needs during initial ingestion; reassess after at least one month of 5.4; never let a future policy delete data required for provenance or audit | The growth estimate is per-run-per-cell-set and has never been measured against a real cell count; a policy chosen now would be a guess with an audit cost | `weather_records` and superseded rows. Not `climatology_normals`, which is never pruned | **Owner-approved deferral** pending measured usage | At least one month of observed 5.4 ingestion, plus a demonstrated storage or query need |

### 9.2 Deferred, or out of Phase 5

| ID | Item | Status |
|---|---|---|
| `OPEN-02` | BMKG written permission | **External evidence.** The flag stays off; days 0–3 fall back to labelled Open-Meteo |
| `OPEN-14` | Freeze the five `temporal_resolution` and five `aggregation_level` values | **Assigned to 5.0, not yet delivered**; the columns are unconstrained `text`, and an unfrozen vocabulary is a silent re-labelling risk |
| `OPEN-15` | `area_weighted` weight set | **Already decided** as `centroid` for v1; the policy stays accepted-but-unimplemented |
| `OPEN-21` | Field snapshot vocabularies | **Deferred to Phase 6**; blocks snapshots, not climate reads |
| `Q-P5-2` | Operational history storage (`sync_attempts`, dead-letter, watermark) | **Deferred**; structured logs + `ingestion_runs.error` first. None of those tables exists |
| `Q-P5-3` | Temperature outlook | **Deferred**; `monthly_outlooks.variable` is precipitation-only by CHECK |
| `Q-P5-4` | A reachable, lawful CHIRPS v3.0 route | **External evidence**; ERA5 is the fallback, labelled by dataset |
| `ADR-001` D2a | ECMWF Set VII annual outlook | **Deferred**; months 8–12 stay climatology |

### 9.3 External evidence, not a decision

These cannot be settled by the owner alone, and no document in this repository may
assert them as done: written BMKG permission (`OPEN-02`), the Open-Meteo commercial
evaluation (`OPEN-03`), a reachable CHIRPS route (`Q-P5-4`), the five provider grid
configurations (§5.2.6), and the seasonal payload shape (`forecast_days` split, EC46
lead-time shape, ensemble null boundary).

---

## 10. Owner decisions and external evidence

### 10.1 Recorded, 2026-11-21

1. **`OPEN-18`** — generic grid-resolver contract approved and now implemented
   with tests; the five provider grid configurations are still pending evidence,
   so no real model can resolve yet.
2. **`Q-P5-1`** — PostgreSQL-first queue, behind an interface; no queue table or
   code exists.
3. **`OPEN-03`** — no paid plan commitment; commercial use conditional on verified
   licensing and an appropriate plan.
4. **`OPEN-05`** — raw-payload retention deferred; `reproducible: false` plus a
   reason where a payload is not retained.
5. **`OPEN-16`** — no automatic pruning until at least one month of measured 5.4
   ingestion.

Recording a decision is not implementing it. Each item above still names the
sub-phase that delivers it, and that sub-phase has not started.

### 10.2 Still needs external evidence

BMKG written permission; Open-Meteo commercial terms and pricing; a lawful and
reachable CHIRPS route; each provider's grid origin/axis; the seasonal payload
shape. Until each is on file, the dependent sub-phase either runs on the labelled
fallback or does not run.

---

## 11. What this document does not change

- No migration, no Prisma model, no column, constraint, index, grant, or policy.
- No queue table: the `jobs` table is 5.3's deliverable, not this document's.
- No API contract, no route, no response envelope.
- No authentication, RLS, or tenant-transaction behaviour.
- No dependency, and no new package (the two new packages are *proposed*, §8.1).
- No phase status: Phase 5.0's contracts and resolver are **implemented and tested**;
  sub-phases 5.1–5.8 are **not started**.
- `ADR-001`, `provenance-contract.md`, `tables-climate.md`,
  `temporal-and-weather-semantics.md`, and `data-flow.md` are cited, not edited.
  `background-processing.md` is edited only to record the queue backing decision and
  to mark its queue tables as proposed. Where another document is wrong (§3.5), the
  divergence is recorded here for a separate correction, not silently overridden.
