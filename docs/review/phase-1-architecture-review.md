# Phase 1.1 — Architecture Reconciliation Review

Date: 2026-11-18
Scope: `docs/PROJECT.md`, `docs/architecture/*`, `docs/adr/ADR-001`, `docs/adr/ADR-002`.
Method: read every document end to end, grep for the ten vocabulary terms, then resolve contradictions in a single normative file (`docs/architecture/provenance-contract.md`) and patch the rest to defer to it.

Outcome: **Phase 1.1 accepted. Phase 2 may begin**, subject to the blockers in §6.

---

## 1. Findings

Each finding is a concrete inconsistency found in the documents as they stood, not a hypothetical.

| # | Finding | Files | Severity |
|---|---|---|---|
| F1 | `temporalClass` and `dataClass` were two names for one enum, used inconsistently. ADR-001 D7 said `temporalClass`; the D9 amendment introduced `dataClass`; both survived. | ADR-001, domain-model, data-flow, api-conventions, forecast-horizon | **P0** |
| F2 | `runId = provider:model:initializedAt` conflated model-output identity with our fetch attempt. A unit-conversion fix would have produced a new `runId`, invalidating every derived artifact and telling users a new forecast had arrived when none had. | background-processing §3, domain-model, data-flow | **P0** |
| F3 | Derived artifacts stored a single `outlookRunId`, but a 12-month outlook consumes EC46 **and** SEAS5 **and** a climatology baseline. One id cannot represent that, and the artifact becomes unreplayable. | domain-model, data-flow, api-conventions, ADR-001 follow-up 6 | **P0** |
| F4 | "Derived rows inherit the **oldest** input freshness" was wrong twice: climatology has no initialization time (so a 12-month outlook would be permanently stale), and a month missing for `beyond_horizon` is not stale at all. | background-processing §6 | **P0** |
| F5 | Fallback rule said a seasonal feed absence makes months "degrade to climatology". That silently converts an ingestion failure into historical context — the exact failure mode the product's rules forbid. | system-architecture §7, data-flow §3 | **P0** |
| F6 | `503` was specified for `DATA_STALE`, i.e. staleness mapped to a 5xx. That trains clients to retry a request that has a usable answer and erases the difference between "old" and "absent". | api-conventions §3 | **P0** |
| F7 | `PlantingWindow` carried one `evidenceClass` and one `evaluationBasis`, although a window spanning 6 weeks crosses daily → weekly → monthly → climatology. A single class could only be a lie or an arbitrary pick. | domain-model §5 | **P0** |
| F8 | Ten queues, of which three shared provider, failure semantics, retry shape, and budget (`ingest.short`/`ensemble`; `subseasonal`/`seasonal`/`climatology`), and one (`recompute.briefings`) did nothing but invalidate a cache key. | background-processing §2 | P1 |
| F9 | PostGIS constraints in ADR-002 D3 were one sentence. It did not state SRID, validity rejection, GiST indexing, or that planar `ST_Area` in EPSG:4326 measures square degrees. | ADR-002 D3 | **P0** |
| F10 | RLS was named but never specified. With Prisma pooling, a session-scoped `SET app.user_id` leaks across requests. | system-architecture §8, domain-model §7 | **P0** |
| F11 | `evaluationBasis`, `precision`, and "temporal resolution" were used for three different things in three documents. | agronomic matrix, domain-model, background-processing | P1 |
| F12 | Phase 0 `forecast-horizon-capabilities.md` §3 still required `temporalClass` on month records — a live requirement, not history. | forecast-horizon | P1 |

---

## 2. Decisions accepted

**D-A1. Four independent axes, four fields** (`provenance-contract.md` §1).

`evaluationBasis` (granularity), `dataClass` (evidence type), `dataAvailability` (usable now?), and run identity (reproducible?) are orthogonal. A value can be monthly-basis, seasonal-class, stale, and reproducible at once. Previously all four were expressed with two overloaded fields.

- `evaluationBasis ∈ {daily, weekly, monthly, climatology, mixed}`.
- `mixed` is legal **only on a container** (window, outlook). On a single value it is a modelling bug, and the API rejects it.

**D-A2. `EvidenceSegment` is the unit of mixed-evidence reporting** (`§2`).

`{ startDate, endDate, evaluationBasis, evidenceClass, sourceRunIds[], coveragePercent, provenance[] }`. Segments are non-overlapping, contiguous, and never mix classes internally. Boundaries are set by **data availability**, not calendar convenience — a `seasonal_forecast` segment starts after the last day of genuine subseasonal data even if that is mid-month. Gaps become `missingRanges[]`, never silently widened segments.

Window rollup adds `primaryBasis` (basis of the **critical stage**, not the longest interval), `mixedEvidence`, `weakestEvidenceClass`. A window whose critical stage sits in climatology is reported as such regardless of how good the surrounding days looked.

**D-A3. `ForecastRun` and `IngestionRun` are separate identities** (`§3`).

- `ForecastRun` unique on `(provider, model, product, initializedAt)` — identity of the model output.
- `IngestionRun` unique on `(forecastRunId, adapterVersion, normalizerVersion, targetSelectorHash, attempt)` — identity of our attempt.
- Re-normalizing a retained payload creates a new `IngestionRun` under the **same** `ForecastRun`. Job idempotency keys use `forecastRunId`, never wall-clock.

This is the decision that stops a bug fix from impersonating a new forecast.

**D-A4. Derived provenance is a record, not an id** (`§4`).

`derivationVersion`, `engineVersion?`, `profileVersionId?`, `baselineVersion?`, `inputRunRefs[]` (with `role`), `inputSnapshotHash`, `computedAt`, `status`, `supersedesId`/`supersededById`. The snapshot hash is defined precisely enough to be comparable across runs (canonical JSON, sorted, no timestamps). Same hash ⇒ must produce identical output; different hash with identical output is a defect.

If the provider payload was not retained and the row cannot be replayed, the row is stored with `reproducible: false` **and the reason**. Silent unreproducibility is not allowed.

**D-A5. Freshness is per-source and per-artifact, and climatology contributes no ageing** (`§5`).

`SourceFreshness` and `DerivedFreshness` are distinct types with distinct fields. `oldestInputInitializedAt` is computed over non-climatology inputs only. Derived artifacts report `staleInputRoles[]` — a set, not a boolean. A failed recompute leaves the previous artifact `active` with `reason = "recompute_failed"`; supersession is a status change and a link, never a deletion.

**D-A6. Two structurally different kinds of missing** (`§6`).

`MissingReason ∈ {beyond_horizon, not_requested, pending, ingest_failed, provider_unavailable, insufficient_history, below_coverage_threshold}`. Only `beyond_horizon` licenses climatology in that slot. Every month/day carries **two axes** — forecast availability and climatology availability — reported independently. A month never renders as a forecast because the slot needed filling.

**D-A7. Staleness is not an HTTP error** (`§7`, `api-conventions.md` §3).

| Situation | Status |
|---|---|
| Fresh | 200 |
| Stale but usable | 200 + `dataAvailability = "stale"` + reason |
| Missing, job pending | 202 + `retryAfter`, no fabricated value |
| Provider failed, last-known usable | 200 + `lastKnown` + stale + reason |
| Provider failed, nothing usable | 503 `PROVIDER_UNAVAILABLE` |
| Partial source availability | 200 + per-source map + `meta.availability = "partial"` |

`503` means "no usable value exists". `DATA_STALE` is removed as an error code entirely.

**D-A8. Six queues instead of ten** (`background-processing.md` §2).

| Queue | Why it survives |
|---|---|
| `ingest.forecast` | must stay responsive hourly; a seasonal burst must never delay it |
| `ingest.climate` | MB-scale payloads, multi-minute fetches; separate budget and separate pause |
| `aggregate` | no network, different failure mode, bulk-replayable |
| `recompute.windows` | largest blast radius; must be pauseable and rate-limited independently |
| `verify` | years of history, off-hours only, must not compete with interactive work |
| `maintenance` | must run while everything else is paused — that is its purpose |

Merges: `ingest.short`+`ingest.ensemble` → `ingest.forecast` (payload size is a per-job timeout, not a queue); `ingest.subseasonal`+`seasonal`+`climatology` → `ingest.climate` (one endpoint family, one budget, one degrade-together mode); `recompute.briefings` **deleted** (it only invalidated a cache key; invalidation moved to `maintenance` and the tail of `recompute.windows`).

**D-A9. PostGIS constraints are enumerated and testable** (ADR-002 D3).

SRID 4326 enforced; `ST_IsValid` at the boundary with `422` + `ST_IsValidReason` (no silent `ST_MakeValid`); vertex cap 5 000; GiST in the same migration as the column; area via `ST_Area(geom::geography)` — never planar in 4326; `ST_PointOnSurface` for cell resolution with `extractionPolicy` recorded per row; all spatial SQL in `packages/database/src/spatial.ts`; `$queryRawUnsafe` banned; integration tests against a real `postgis/postgis` container including an index-usage assertion.

**D-A10. RLS is transaction-scoped** (ADR-002 D8, system-architecture §8).

`withTenant(user, fn)` opens a transaction and calls `set_config('app.user_id', $1, true)`. Session-scoped `SET` is banned and CI-checked. An unset setting yields `NULL` ⇒ policies match zero rows ⇒ fail closed. Workers use a dedicated `BYPASSRLS` role rather than impersonating a user. Controller-level ownership checks remain the primary mechanism; RLS is the backstop.

**D-A11. Vocabulary is fixed** (`§1`, deprecated-terms table).

| Term | Status |
|---|---|
| `dataClass` | canonical, 9 values, ADR-001 D9 |
| `temporalClass` | **deprecated** → `dataClass` |
| `precision` | **deprecated** → `evaluationBasis` |
| `runId` (bare) | **deprecated** → `forecastRunId` or `ingestionRunId` |
| `outlookRunId` | **deprecated** → `inputRunRefs[]` (+ `primaryForecastRunId` convenience) |
| `evidenceClass` | kept, deliberately distinct from `dataClass`: it belongs to a segment and carries basis/coverage/runs |
| `freshness` | always present on weather-derived data; `kind ∈ {source, derived}` |
| `DATA_STALE` | **removed** — not an error code |

---

## 3. Decisions rejected

**R1. Do not collapse `dataAvailability` into a boolean `isStale`.** Rejected because `pending` and `unavailable` are not stale, and the UI must say different things for each; a boolean forces the client to guess.

**R2. Do not keep one `evidenceClass` on `PlantingWindow` for simplicity.** Rejected: it cannot be correct for a window crossing four horizons. `EvidenceSegment` costs one join and removes an entire class of mislabelling.

**R3. Do not introduce an event bus / outbox to "properly" handle recompute fan-out.** Rejected: no measured bottleneck, and BullMQ at-least-once with idempotent jobIds already satisfies the requirement. Recorded as a deliberate omission in ADR-002.

**R4. Do not add a `forecastVersusClimatology` merged display field.** Rejected: it would recreate the failure mode the two-axis contract exists to prevent.

**R5. Do not reduce below six queues.** Rejected as an arbitrary goal: `ingest.climate` sharing slots with `ingest.forecast` is a real availability risk, and `maintenance` must be able to run while others are wedged.

**R6. Do not adopt `If-Match` ETags on weather reads.** Rejected: weather data is not edited by clients; concurrency control belongs on profile edits only.

---

## 4. Remaining risks

| Risk | Impact | Mitigation now | Next check |
|---|---|---|---|
| `inputSnapshotHash` reproducibility depends on retained raw payloads, which depend on provider terms | a "replayable" artifact may not actually replay | `reproducible: false` + reason is a legal stored state, so the gap is visible rather than silent | Phase 4: decide retention per provider against ToS (ADR-001 D7 already gates this) |
| Segment boundaries are derived from availability maps that are themselves derived | a bug in availability propagates into every window's evidence claim | segments are stored, so a bad boundary is auditable after the fact | Phase 6: property test — segments must partition the window exactly |
| Normalizer version bumps supersede rows; a wrong bump could invalidate a whole run's history | corrupted history | supersession, not deletion | Phase 4: normalizer golden-payload tests before any bump |
| Recompute fan-out is O(fields) on a new seasonal run | latency spike on the 5th | 100-field batched transactions, near-term fields first | Phase 4: measure with a synthetic 10k-field set |
| `ST_PointOnSurface` versus area-weighted extraction changes the value, not just the shape | a plot may report a different rainfall depending on policy | policy recorded per resolution row | Phase 3: compare both on real concave plots |
| RLS isolation depends on every repo path using `withTenant` | cross-tenant read | CI grep + integration test | Phase 2: enforce in the repository base class, not by reviewing PRs |
| All provider behaviour was validated at Jakarta only | unknown error at real plots | documented as unvalidated, not claimed | Phase 3/4: repeat probe suite at real coordinates |
| BMKG permission, Open-Meteo licensing, Set VII access all unverified | commercial release blocked | feature flags, climatology fallback | unchanged from Phase 0 |

---

## 5. Cross-document consistency checklist

Verified by grep over `docs/`, not by reading alone.

| Check | Result |
|---|---|
| No live use of `temporalClass` | pass — remaining occurrences are the deprecation table and Phase 0 history |
| No live use of `precision` | pass — `docs/research/agronomic-reference-matrix.md` uses `evaluationBasis`; the one `precision` hit is the deprecation note |
| No bare `runId` in a schema or contract | pass — replaced by `forecastRunId`/`ingestionRunId` in domain-model, data-flow, background-processing, api-conventions |
| No `outlookRunId` | pass — ADR-001 follow-up 6 and the Phase 0 review item updated |
| `DATA_STALE` absent as a status | pass — removed from the error table; staleness is a body field |
| Every weather response requires `dataClass` + `evaluationBasis` + `dataAvailability` | pass — `api-conventions.md` §4/§11 |
| Climatology never carries `initializedAt` or `sourceRunIds` | pass — domain-model invariant, provenance-contract §2.5 |
| `beyond_horizon` is the only reason that licenses climatology | pass — provenance-contract §6, data-flow §3, system-architecture §7 |
| Queue names consistent across documents | pass — six queues, referenced identically in background-processing and data-flow |
| RLS specified as transaction-scoped | pass — ADR-002 D8 + system-architecture §8 |
| PostGIS area not planar | pass — ADR-002 D3 item 5 |
| Derived artifacts carry `inputRunRefs[]` + hash, not one id | pass — domain-model §5, data-flow §7, ADR-002 D6 |

Not checked, because it cannot be checked in documents: whether the policies actually fail closed. That is a Phase 2 integration test.

---

## 6. Phase 2 readiness

**Ready to begin: yes**, with three conditions.

1. Phase 2 scaffolding must implement `withTenant` as the only DB entry point and prove isolation with a two-user concurrent test before any feature lands on top of it. RLS is worthless as a second line if the first line can bypass it.
2. The `packages/contracts` Zod schemas must make `dataClass`, `evaluationBasis`, `dataAvailability`, and `freshness` **required** (not optional) from the first commit that emits weather data. Retrofitting required fields into a live contract is how they end up optional forever.
3. `packages/weather-core` adapters must be built against `ForecastRun`/`IngestionRun` from the start; adding the split later means rewriting every stored row's identity.

**Not blocking Phase 2**, but blocking release: Open-Meteo paid-vs-self-host, BMKG written permission, ECMWF Set VII licence enquiry. All three are external.

**This review does not claim the architecture is correct** — only that it is internally consistent and that the P0 contradictions are resolved. The four invariants that Phase 2 must not violate:

1. Derived data is materialised with full input run references and a snapshot hash.
2. The agronomy engine is a pure function of (profile version, outlook, field).
3. `dataClass` + `evaluationBasis` + `dataAvailability` are required in the contract.
4. No synchronous provider call exists on a request path.
