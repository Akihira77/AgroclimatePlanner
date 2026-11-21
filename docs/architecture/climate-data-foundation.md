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
| Cell resolution | `tables-climate.md` §1; `physical-model.md`; `OPEN-18` | `cell_key` is per-model `text`; identity is `(provider, model, cell_key)` | **tables exist** (`outlook_cells` 10 columns, `field_outlook_cells` 11 columns with live-uniqueness partial index); **no rounding rule is written for any model** | `OPEN-18` in full: five rounding rules, their precision, and the re-grid policy (§5.2) |
| Field → cell mapping | `data-flow.md` §2; `tables-identity.md` §4 | Centroid in v1 (`OPEN-15`); resolution stored, never recomputed on read; a geometry edit supersedes rows | **tables exist and are tenant-scoped with `FORCE` RLS**; no code resolves a field into a cell | The resolution service; the geometry-edit supersession trigger; `field_outlook_cells` writes are not in the Field API |
| Normalized records | `tables-climate.md` §4 | One row per `(run, cell, variable, valid_at, ensemble_member)`; `value` nullable; never deleted, only superseded | **table exists** (32 columns, 5 indexes, `weather_records_live_key` uses `NULLS NOT DISTINCT`) | The normalizer itself; unit conversion table; the supersession writer; `OPEN-14` vocabulary for `temporal_resolution`/`aggregation_level` |
| Climatology | `ADR-001` D2; `tables-climate.md` §6 | 1991–2020, CHIRPS preferred, ERA5 as implemented fallback; a rebuild is a new `baseline_version` | **table exists** (`climatology_normals`, 11 columns, unique `(baseline_version, outlook_cell_id, month)`) | The baseline builder; the route to a reachable CHIRPS v3.0 (host timed out 2026-11-18); `baselineHash` computation over a consumed subset |
| Temporal aggregation | `temporal-and-weather-semantics.md` §1–§6 | Every instant `timestamptz(6)` UTC; every calendar decision Asia/Jakarta; one conversion at aggregation | **designed only.** `temporal.ts` exists in contracts; no aggregation code | The daily → weekly → monthly aggregation; the UTC → Jakarta day boundary at the one permitted conversion point; `monthly_outlooks` assembly order |
| Provenance | `provenance-contract.md`; `provenance-storage.md`; `canonical.ts` | Hash preimages stored as documents; freshness computed at read time, never stored | **implemented in contracts only**, with 239 passing contract tests including golden vectors; the derived tables that store those documents exist | No producer writes any `input_refs`; `DerivedFreshness` has no producer; the provenance audit that resolves dangling refs does not exist |
| Raw payload retention | `OPEN-05`; `OPEN-03` | Per-provider licensing decides; `reproducible: false` + reason is the honest alternative | **nothing exists**: no object store, no `raw_payload_ref` writer, no retention table | The decision (`OPEN-05`), the store, and the retention policy per provider (§5.4) |
| Tenant access | `ADR-003`; `tenant.ts`; `system-architecture.md` | `withTenant(userId, fn)` is the only entry point; one `createTenantScope` per request; `app_system` owns global writes and holds no tenant-row grant | **implemented and tested**: `withTenant` ships, `test:rls` passes 90 assertions as real roles, `db:verify` passes | The recompute fan-out has no permitted read of `field_outlook_cells` (`OPEN-27`); climate read path is `app_api` only, which is already granted |
| Background processing | `background-processing.md` | Six queues, run identity by `forecastRunId`, retry classes, budget guards, explicit failure semantics | **nothing exists.** `apps/worker/src/main.ts` is a stub; no queue library, no Redis client, no scheduler, no HTTP client is installed anywhere in the workspace | Queue backing decision (§9, `Q-P5-1`), the worker runtime, the six queues, the budget buckets, the maintenance sweep |

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
| `sync_attempts` table, dead-letter table, sweep watermark | `background-processing.md` §10 | **No such tables exist.** `ingestion_runs` carries `error` and `status`, but per-attempt latency/bytes and dead-letter entries have no home. Phase 5 must decide whether structured logs suffice or a migration is needed (§5.4, `Q-P5-2`) |
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
| Adapter (per provider/product) | `packages/weather-core/adapters/*` (new; the documented `weather-core`) | pure given `(request, now)` except for the injected fetch | request shape, response parse, provider error mapping, attribution |
| Normalizer | `packages/weather-core/normalize/*` | **pure** | unit conversion, `dataClass`, validity times, coverage accounting, record assembly |
| Cell resolution | `packages/weather-core/cells/*` | **pure** | geometry → `cellKey`; served coordinate acceptance; distance |
| Ingestion pipeline | `apps/worker/src/ingest/*` | impure | run upsert, transaction, supersession, status transitions |
| Aggregation | `apps/worker/src/aggregate/*` + `packages/climate-core/aggregate/*` (the documented `climate-core`) | pure core, impure writer | daily/weekly/monthly rollup, anomaly, coverage, spread |
| Persistence | `packages/database/src/climate.ts` (new; not importable from `weather-core`) | impure | typed access to the six global tables + `field_outlook_cells` |
| Read path | `apps/api/src/climate/*` (new module) | impure, read-only | `GET /v1/climate/outlook`, freshness computation |

Two rules that shape every file above:

1. **Provider-specific field names never leave `packages/weather-core/adapters`.** After
   the normalizer, nothing downstream can tell BMKG from SEAS5 — only `dataClass`,
   resolution, `forecastRunId`, and `ingestionRunId` remain (`data-flow.md` §1).
2. **The pure layers are pure.** Adapter parse, normalizer, cell rounding, and
   aggregation take data and return data. That is what lets the whole pipeline be
   tested from recorded fixtures with no network and no clock (§7).

Neither `weather-core` nor `climate-core` exists yet; §8.1 and §8.7 add them. The
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
// packages/weather-core/adapters/types.ts — design sketch, not yet written
interface AdapterRequest {
  cells: RequestedCell[];          // coordinates we ask for
  variables: VariableRequest[];    // logical names, adapter maps to provider names
  window: { from: IsoInstant; to: IsoInstant };
  forecastDays?: number;           // pinned where the provider truncates by it
}

interface AdapterResult {
  run: RunIdentity;                // provider, model, product, initializedAt, horizonEnd
  receivedAt: IsoInstant;
  raw: RawPayloadRef | null;       // null when retention is not permitted
  values: WeatherValue[];
  coverage: { requestedCells: number; answeredCells: number; coveragePercent: number };
  attribution: string;             // exact string the licence requires
  sourceUrl: string;
}
```

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
| `partial` | fewer rows/days than requested | **no** | `status = 'partial'`, `coverage_percent < 100` |

`provider_changed` is separated from `request_invalid` on purpose: the first is our
bug or the provider's breaking change and needs a human; the second is a bad request
and retrying is pointless.

### 5.2 Spatial resolution and cell identity

A field's geometry becomes a provider cell in one direction only:

```
field.geom ──▶ anchor point (centroid, v1) ──▶ per (provider, model):
                 cellKey = round(anchor, grid) ──▶ outlook_cells identity
                 request cellKey ──▶ provider answers servedLat/servedLon
                 ──▶ field_outlook_cells (fieldId, provider, model, cell, distance, elevationDelta)
```

**`OPEN-18` — recommendation, needs owner approval.**

`cell_key` is `text` because no rounding rule is written for any grid. The
recommendation:

| Model | Grid step | `cell_key` format | Anchor rule |
|---|---|---|---|
| `ecmwf_ifs025` | 0.25° | `lat,lon` with 2 decimals, at the node: `-6.25,106.75` | floor to the node, then take the centre |
| `ecmwf_ec46` | 0.4° (36 km) | 2 decimals | as above, using the published grid origin |
| `ecmwf_seas5` | 0.4° (36 km) | 2 decimals | as above |
| ERA5 archive | 0.25° | 2 decimals | as above |
| CHIRPS v3.0 | 0.05° | 2 decimals | as above |

Rules that make the key safe:

1. **The key is the grid node the provider serves, not the requested coordinate.**
   `requested_lat`/`requested_lon` live on `weather_records`; the cell key is shared
   by every field that maps to it.
2. **The rule is part of the model identity.** If a provider re-grids, the new grid
   is a **new `model` string** (e.g. `ecmwf_seas5_v2`), never a re-interpretation of
   the old key. Otherwise `outlook_cells_grid_key` would either collide across grids
   or silently re-point historical `field_outlook_cells` rows at a different place.
   This is the only way the existing `UNIQUE (provider, model, cell_key)` can be
   trusted.
3. **Rounding at 2 decimals matches every grid in the table**, so one formatter
   suffices and the key stays readable in a URL and a log line. A grid finer than
   0.01° would need a revisit; none in scope is.
4. **`extraction_policy` is `'centroid'` in v1** (`OPEN-15`). `'area_weighted'` is
   accepted by the CHECK and not implemented; a multi-cell weight set does not exist,
   so the engine must not emit it.
5. **Distance is stored, and disagreement is not an error.** A served coordinate that
   differs from the anchor is normal (the provider snapped to its grid). Store
   `distance_km`; surface it. A 900 km mismatch is a sign error the CHECK
   (`distance_km >= 0`) cannot catch, so the ingest asserts a per-model upper bound
   and fails the resolution rather than storing it.
6. **`served_value_is_interpolated` is shown, not hidden.** A provider that
   interpolates to the requested point is not serving the cell centre, and the
   product's first rule ("never let a coarse resolution imitate a fine one") depends
   on saying so.

Two-phase write, forced by the column grants: `app_api` may insert only
`(provider, model, cell_key)` into `outlook_cells`; `app_system` fills
`served_lat`, `served_lon`, `elevation_m`, `spatial_resolution_km`. The ingest job
does the second write. A cell created by a user's field therefore exists before its
coordinates do, which is the documented lifecycle ("`NULL` until first ingest") and
not an error state.

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

**`OPEN-05` — recommendation.** Do not build retention in Phase 5. Reasons: the
object store is new infrastructure with its own access control; Open-Meteo's free
tier imposes terms that are themselves unresolved (`OPEN-03`); and the honesty cost
is already representable — `reproducible: false` with a stated reason is exactly what
`provenance-storage.md` §7 designed for. Retention becomes worth building when
(a) a paid or self-hosted plan makes it lawful, and (b) the first verification run
needs to re-derive a score. Until then, `raw_payload_ref` stays `NULL` and no artifact
claims replayability it cannot deliver.

**`OPEN-16` — recommendation.** Retention of `weather_records` is not urgent at
Phase 5 scale, and the growth figure in the research (≈56 000 rows per ensemble run)
is a per-run-per-cell-set estimate that must be measured against the real cell count
before any policy is chosen. Recommended policy to adopt in 5.0 and revisit after the
first month of 5.4 traffic:

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
4. **Class is chosen per month, in the documented order**, and never blended:
   a live SEAS5 month within TTL → `seasonal_forecast`; else EC46 covering the month
   → `subseasonal_forecast`; else the month is genuinely beyond the seasonal horizon
   → `climatology` with `missing_reason = 'beyond_horizon'`; else the month is
   `pending` / `ingest_failed` / `provider_unavailable` with **no** value.

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
| dead-letter / `sync_attempts` / watermark | **no** | **decision required** | `background-processing.md` §10 names `sync_attempts` and a dead-letter surface that have no table. Recommendation: structured logs + `ingestion_runs.error` + `ingestion_runs_running_idx` for stuck detection is enough for 5.4, and a migration is written only if a query is actually needed (§9, `Q-P5-2`) |

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
| Payload size | what the normalizer counted | no number is stored yet; §9 `Q-P5-2` |
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
| Cell-key determinism | the same anchor always yields the same key, and the key is the served grid node | golden table per model |
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
| Objective | every decision the adapters depend on is written, and the missing contracts exist |
| Prerequisites | this document approved |
| Scope | `docs/data-model/open-decisions.md` (close or explicitly defer `OPEN-14`, `OPEN-18`); `packages/contracts/src/weather.ts` (add `ForecastRun` / `IngestionRun` row contracts, and switch `valueBase` to `singleValueEvaluationBasisSchema`); `packages/contracts/src/climate.ts` (new: adapter request/result types) |
| Contracts | `ForecastRun`, `IngestionRun`, `AdapterResult`, `CellKey` per model, frozen `temporal_resolution` / `aggregation_level` vocabularies |
| Database impact | none |
| Tests | contract tests + golden vectors for the new schemas; the existing 239 must stay green |
| Acceptance | a `WeatherValue` produced by a hand-written fake adapter type-checks against the contract with no `any`; the cell-key rule table exists and is executable |
| Dependencies | — |
| Risks | freezing a vocabulary too early (`OPEN-14`); mitigate by freezing only the five values the storage CHECK already implies |

### 8.1 Phase 5.1 — adapter and normalization foundation

| | |
|---|---|
| Objective | one real provider payload can be turned into contract-valid records, offline |
| Prerequisites | 5.0 |
| Scope | new `packages/weather-core` (`adapters/open-meteo-forecast.ts`, `normalize/*`, `fixtures/*`), wired into the workspace; `apps/worker` untouched |
| Contracts | `AdapterResult`; normalizer signature `(payload, adapterMeta) => { values, coverage, rejects }` |
| Database impact | none |
| Tests | §7.1 rows 1–4 and 10; a recorded Open-Meteo forecast response as the first fixture |
| Acceptance | a fixture produces records whose `unit`, `valid_at`, `data_class`, `initialized_at`, and coverage are asserted; a recorded 429 / 400 / schema-change body maps to the right error class |
| Dependencies | 5.0 |
| Risks | over-fitting the normalizer to one payload shape; mitigate with three fixtures of different lengths |

### 8.2 Phase 5.2 — cell resolution and field mapping

| | |
|---|---|
| Objective | any field yields a deterministic `cellKey` per model, stored as a resolution |
| Prerequisites | 5.0, 5.1 (grid metadata) |
| Scope | `packages/weather-core/cells.ts`; `packages/database/src/climate.ts` (`upsertCell`, `resolveFieldCells`); one integration point in the Field write path |
| Contracts | `CellKey`, `ResolvedCell` (`provider`, `model`, `cellKey`, `distanceKm`, `extractionPolicy`) |
| Database impact | none new; writes `outlook_cells` (identity only, `app_api`) and `field_outlook_cells` inside `withTenant` |
| Tests | §7.1 row 5; the two-phase cell fill; supersession on geometry edit; `distance_km` bound rejection |
| Acceptance | the same polygon always resolves to the same cell; a geometry edit supersedes the old row and inserts a new one; no cross-tenant row is visible |
| Dependencies | 5.0, 5.1 |
| Risks | the centroid of a large plot falling near a grid boundary (two cells differ by one step); documented, not solved, because `OPEN-15` is undecided |

### 8.3 Phase 5.3 — run lifecycle and worker runtime

| | |
|---|---|
| Objective | a job can be enqueued, retried, deduplicated, and recorded against `forecast_runs` / `ingestion_runs` |
| Prerequisites | 5.0 |
| Scope | `apps/worker/src/queue.ts` (backing per `Q-P5-1`), `apps/worker/src/ingest/run.ts`, `packages/database/src/climate.ts` (`upsertForecastRun`, `upsertIngestionRun`, `markIngestionStatus`) |
| Contracts | `ForecastRun`, `IngestionRun`, `targetSelectorHash` definition |
| Database impact | none if `Q-P5-1` picks Postgres; a `jobs` table if it does |
| Tests | §7.1 rows 6–7; `attempt` increments in place; `ingestion_runs_finished_check` holds on every transition |
| Acceptance | ingesting the same fake payload twice leaves exactly one `ForecastRun`, one `IngestionRun`, and an unchanged row count; a forced failure increments `attempt` without minting a row |
| Dependencies | 5.0 |
| Risks | the queue choice becomes load-bearing; mitigate by keeping job semantics (id, retry, dead-letter) independent of the backing |

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
| Risks | free-tier budget exhaustion; no commercial permission; both are `OPEN-03` and must be settled before this runs on a schedule |

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
| Acceptance | with only climatology ingested, the API returns 12 months, 8 of them labelled `climatology` / `beyond_horizon`, and no month claims a forecast; with seasonal data present, months 2–7 change class and 8–12 do not |
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

After 5.7 with climatology only, a farmer can be shown twelve months of historical
normals, correctly labelled, for their own plot. After 5.6, months 2–7 become a real
seasonal forecast. After 5.4, days 0–14 become a real short-range forecast. That is
the order in which the product becomes useful, and it is why 5.5 precedes 5.6 and
5.4 rather than following them.

---

## 9. Decision register

| Decision | Existing decision | Recommendation | Status |
|---|---|---|---|
| BMKG permission | `OPEN-02` | keep the flag off; the 0–3 d band falls back to Open-Meteo, labelled `weather_forecast` | **needs external evidence** (written permission) |
| Open-Meteo commercial plan | `OPEN-03` | decide before 5.4 runs on a schedule; paid plan is the cheap option, self-host is `OPEN-03`-sized infrastructure | **needs owner approval** |
| Raw payload retention | `OPEN-05` | do not build in Phase 5; record `reproducible: false` + `raw_payload_not_retained` | **needs owner approval** (accepts the honesty cost) |
| Cell-key algorithm | `OPEN-18` | fixed-decimal `lat,lon` at the served grid node, 2 decimals, per model; a re-grid is a new `model` string | **needs owner approval**, then written into `open-decisions.md` |
| Weather-record retention | `OPEN-16` | no pruning in Phase 5; never delete a run referenced by `input_refs`; measure before choosing | **can be deferred** with a stated trigger |
| Temporal vocabulary | `OPEN-14` | freeze the five `temporal_resolution` and five `aggregation_level` values in 5.0, matching the columns' documented sets | **already implied by the schema** — freezing adds no risk |
| Field-to-cell mapping | `OPEN-15` | `centroid` in v1, as documented; `area_weighted` stays accepted-but-unimplemented | **already decided** |
| Field snapshot vocabularies | `OPEN-21` | out of Phase 5; it blocks snapshots and therefore Phase 6 | **can be deferred** to Phase 6 |
| Queue backing | `Q-P5-1` (new) | Postgres `jobs` table with `FOR UPDATE SKIP LOCKED` before adding Redis+BullMQ: no new dependency, and the job semantics in `background-processing.md` are preserved | **needs owner approval** |
| Operational history storage | `Q-P5-2` (new) | structured logs + `ingestion_runs` first; migrate only when a question cannot be answered | **needs owner approval**, low cost either way |
| Temperature outlook | `Q-P5-3` (new) | defer; `monthly_outlooks.variable` is precipitation-only by CHECK | **can be deferred** |
| CHIRPS route | `Q-P5-4` (new) | try a mirror or GEE; if neither is lawful and reachable, ship ERA5 and say so in the payload | **needs external evidence** |
| Annual outlook (Set VII) | `ADR-001` D2a | do not pursue in Phase 5; months 8–12 stay climatology | **can be deferred** |

Nothing in this table closes an `OPEN-*` item. Each recommendation needs the
approval or evidence in its Status column before the sub-phase that depends on it.

---

## 10. Owner decisions required

Only the items that cannot be settled by engineering evidence:

1. **`OPEN-18` cell-key format** — approve the fixed-decimal rule and the
   "re-grid means a new `model` string" consequence, or propose an alternative.
   Everything in 5.2 depends on it.
2. **`Q-P5-1` queue backing** — Postgres `SKIP LOCKED` (no new dependency) versus
   Redis + BullMQ (`background-processing.md`'s wording). This is the only place
   where following the documents exactly means adding infrastructure.
3. **`OPEN-03` Open-Meteo plan** — paid tier, self-host, or accept non-commercial use
   and never deploy. Budget, not architecture.
4. **`OPEN-05` retention deferral** — approve that Phase 5 ships without raw payload
   retention, and that derived artifacts record `reproducible: false` with a reason.
5. **`OPEN-16` retention policy direction** — approve "no pruning until measured", so
   the first month of 5.4 traffic is the evidence, not a guess.

External evidence, not a decision: BMKG written permission (`OPEN-02`) and a
reachable, lawful CHIRPS route (`Q-P5-4`).

---

## 11. What this document does not change

- No migration, no Prisma model, no column, constraint, index, grant, or policy.
- No API contract, no route, no response envelope.
- No authentication, RLS, or tenant-transaction behaviour.
- No dependency, and no new package (the two new packages are *proposed*, §8.1).
- No phase status: Phase 5 remains **designed, not implemented**.
- `ADR-001`, `provenance-contract.md`, `tables-climate.md`,
  `temporal-and-weather-semantics.md`, `background-processing.md`, and `data-flow.md`
  are cited, not edited. Where one is wrong (§3.5), the divergence is recorded here
  for a separate correction, not silently overridden.
