# Phase 1.1 — Architecture Reconciliation Review

Date: 2026-11-18
Scope: `docs/PROJECT.md`, `docs/architecture/*`, `docs/adr/ADR-001`, `docs/adr/ADR-002`.
Method: read every document end to end, grep for the ten vocabulary terms, then resolve contradictions in a single normative file (`docs/architecture/provenance-contract.md`) and patch the rest to defer to it.

Outcome: **Phase 1.1 accepted. Phase 2 may begin**, subject to the blockers in §6.

> **Partially superseded by Phase 1.2** (`docs/review/phase-1-architecture-review.md` §10). This document is a dated record of what Phase 1.1 decided and stays as written. Phase 1.2 corrected five of its contracts: `inputRefs` (was `inputRunRefs`), `SegmentProvenance` (was `sourceRunIds`), conditional per-class API provenance, `FieldSnapshot`, and `IngestionRun.attempt` semantics. Where this document and the provenance contract disagree, the contract wins.

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

---

## 10. Phase 1.2 — final consistency correction

Nine corrective items, each verified against the actual file text before changing anything. Two premises were adjusted, and one was rejected in favour of a third option.

### Findings

| # | Finding | Severity |
|---|---|---|
| F13 | `DerivationProvenance.inputRunRefs` required `forecastRunId` **and** `ingestionRunId` on every entry, while one of its own `role` values was `climatology`. The type could only be satisfied by writing nulls into required fields — a baseline is not a run. This is the Phase 1.1 union that was still not a union. | **P0** |
| F14 | The API contract required `forecastRunId`/`ingestionRunId`/`initializedAt` on *every* weather value, so a climatology value could only be expressed by inventing them, and the worked example did exactly that by introducing `displayedClass` — a field that states the class without being the class. | **P0** |
| F15 | `inputSnapshotHash` covered cells, variables, runs, and baseline — but **not** soil, pH, drainage, irrigation, geometry, extraction policy, or the plot's own observations. Two windows computed on different fields could share a hash; editing a field's soil type would not change it. The hash therefore did not mean "identical computation inputs". | **P0** |
| F16 | Contradiction between three documents: "IDs are opaque ULID strings", `current_setting('app.user_id')::uuid`, and `withTenant(user.fn)` taking `user.id`. ULID cannot be cast to `uuid`; the RLS policy would have thrown at runtime. | **P0** |
| F17 | The `withTenant` example used `$executeRaw` for `SELECT set_config(...)`. That API is for statements returning a count; the returned value is discarded. A silently failing context set is a cross-tenant read, which is the worst possible failure for this block. | **P0** |
| F18 | `background-processing.md` §8 still said "if SEAS5 is unavailable for a cell, months fall to climatology because the class rule says so" — the exact substitution the contract forbids everywhere else. | **P0** |
| F19 | ADR-002 D3 said "`ST_SimplifyPreserveTopology`, tolerance documented in metres" on raw EPSG:4326 geometry. That function's tolerance is in SRID units — degrees — so 5.0 would mean 5 degrees, roughly 550 km. | P1 |
| F20 | `BYPASSRLS` was granted to "the worker" wholesale, including `recompute.windows`, which writes tenant-owned rows. Worse, fan-out was specified as "batches of 100 fields", which spans tenants and therefore cannot run under one `app.user_id` at all. | **P0** |
| F21 | The segment invariant said "non-overlapping and contiguous" but never stated that segments **plus** missing ranges must partition the window, so a window could be persisted with a gap that the UI renders as coverage. | P1 |
| F22 | `IngestionRun.attempt` sat inside the uniqueness key. Every BullMQ retry would then mint a new row, multiplying record counts and making "how many times did we ingest this run" unanswerable. Retry and reprocessing had one field between them. | P1 |

### Decisions accepted

**A12. `inputRefs` is a four-variant discriminated union** — `forecast` (run ids + `recordSetHash`), `baseline` (`baselineVersion` + `baselineHash` + `cellKeys`, no run ids), `observation` (`observationIds` + hash), `dataset` (`datasetVersion` + hash). `inputRunRefs` is deprecated because "run" was the wrong noun and the required fields were unsatisfiable.

**A13. The API value type is a union discriminated on `dataClass`**, with `source?: never` and `initializedAt?: never` on climatology and observation variants. This makes "climatology carrying an `initializedAt`" a compile error rather than a review comment. `displayedClass` is deleted.

**A14. `FieldSnapshot` is a hashed input**, not an implicit read. It carries `geometryHash`, `areaHa`, elevation, soil type, pH, drainage, irrigation, extraction policy, resolved cells, and the observations used — each `null` preserved as `null`, never defaulted. `inputSnapshotHash` now covers it.

**A15. One id space: UUIDv7 everywhere.** API ids, primary keys, and `app.user_id` are the same value. Rejected "UUID internally + ULID publicly" (every policy, join, and URL parse needs a mapping) and rejected ULID as the PK (26-char text doubles the index, needs a CHECK, buys sortability that v7 already has).

**A16. Row-returning raw SQL uses the row-returning API.** Verified against the current Prisma docs: `$queryRaw` returns rows, `$executeRaw` runs a write; ORM 7 renames these to `db.query()` / `db.execute()` with `.returnsRow(spec)`. Also recorded: ORM 7's `db.transaction(cb)` takes no isolation options, and `tx` cannot nest — so transaction-aware helpers must accept `tx`.

**A17. Climatology is licensed only by `beyond_horizon`,** and "we have nothing" is never a reason to conclude "the horizon ends here". Failure states stay failure states.

**A18. Worker roles are split by what the job writes.** `app_system` (`BYPASSRLS`) is confined to ingest, aggregate, verify, and maintenance — none of which touch a tenant row. `recompute.windows` runs as `app_api` inside `withTenant(ownerId)`, with `ownerId` resolved at enqueue time and carried in the payload.

**A19. Fan-out is grouped by owner, then batched to ≤100 fields.** Batching across tenants was incompatible with transaction-scoped RLS, not merely inelegant.

**A20. `IngestionRun` has `ingestionVersion` (identity) and `attempt` (physical counter).** Uniqueness is `(forecastRunId, ingestionVersion)`. Retries increment `attempt` in place; adapter/normalizer/target changes mint a new `IngestionRun` at `attempt = 1`.

**A21. v1 rejects complex polygons instead of simplifying them.** 5 000-vertex cap; no projection-aware geometry pipeline. The UTM sequence is documented for the day it is actually needed, with zone selection by centroid longitude (Indonesia spans 46S–54S, so a hardcoded zone is wrong).

**A22. The partition invariant is executable**, with six assertions (no overlap, no gap, full span, internal contiguity, reason present, coverage reconciles). A window failing it is not persisted.

### Decisions rejected

**R7. Do not make every provenance property optional to fit one flat shape.** That was the underlying proposal of "reconcile the three documents"; it would have made the contract unable to express the one rule the product depends on. Conditional requiredness via a union is the fix.

**R8. Do not store a hash *instead of* run references.** A hash proves sameness; it cannot tell you which run to re-fetch. Both are kept — `recordSetHash` per input ref answers "which numbers", `forecastRunIds` answers "which run".

**R9. Do not add a separate weather-snapshot table.** `recordSetHash` over the stored records achieves verifiability without duplicating bytes, and raw-payload retention is ToS-gated anyway. A second copy of provider data would be a licensing problem disguised as a provenance feature.

**R10. Do not extend `attempt` to mean both retry and reprocessing.** Two meanings in one field is what caused F22; splitting the field is cheaper than adding a table, which is why no new table was introduced.

### Remaining risks introduced by this pass

| Risk | Mitigation | Next check |
|---|---|---|
| `recordSetHash` is only verifiable if the records still exist; supersession keeps history but a normalizer change replaces rows | `reproducible: false` + reason stored | Phase 4: verify that superseded rows remain readable for hashing, or store the hash input separately |
| `FieldSnapshot` is captured at compute time, so a window computed before a soil edit cannot be recomputed against the *new* soil — by design | `fieldSnapshotHash` on the artifact makes the difference explicit | Phase 6: test that editing soil marks windows stale |
| `source?: never` requires the Zod/OpenAPI generation to emit real `oneOf` variants | contract test with a climatology fixture carrying `initializedAt` must fail | Phase 2: generate the schema and assert the negative case |
| Grouping fan-out by owner can produce many small jobs | per-owner batching, priority ordering | Phase 4: measure job count on a synthetic 10k-owner set |
| UUIDv7 exposes a millisecond timestamp | identical exposure to ULID; ids are opaque and not secrets | accepted, no action |

### Consistency matrix

Each corrected contract, and every document that had to move with it.

| Contract | Corrected in | Dependent documents updated |
|---|---|---|
| `inputRefs` discriminated union (A12) | `provenance-contract.md` §4 | `domain-model.md` §5, `data-flow.md` §4/§7, `api-conventions.md` §10, `background-processing.md` §3, ADR-001 follow-up 6, ADR-002 D6, `phase-0-review.md`, `IMPLEMENTATION_STATUS.md` |
| Conditional API provenance (A13) | `api-conventions.md` §4 + §11, `provenance-contract.md` §6 | `system-architecture.md` §6, `domain-model.md` §4 invariant |
| `FieldSnapshot` + hash coverage (A14) | `provenance-contract.md` §4 | `domain-model.md` §5, `data-flow.md` §4, ADR-001 follow-up 6, ADR-002 D6 |
| Single UUIDv7 id space (A15) | `api-conventions.md` §1 | `system-architecture.md` §8 (policy cast + `withTenant`), `provenance-contract.md` §3 (id comments), `domain-model.md` §7 |
| Row-returning raw SQL (A16) | `system-architecture.md` §8 | ADR-002 D8 |
| `beyond_horizon` exclusivity (A17) | `background-processing.md` §8 | already held in `data-flow.md` §3 and `system-architecture.md` §7; no contradiction left |
| Worker role split (A18) | `system-architecture.md` §8 | `background-processing.md` §7, ADR-002 D8 |
| Owner-grouped fan-out (A19) | `background-processing.md` §7 | `system-architecture.md` §8 |
| `ingestionVersion` vs `attempt` (A20) | `provenance-contract.md` §3 | `domain-model.md` §4 invariant 5, `IMPLEMENTATION_STATUS.md` |
| No simplification (A21) | ADR-002 D3 item 3 | `domain-model.md` §2 (resolution policy) unchanged |
| Partition invariant (A22) | `provenance-contract.md` §2 | `domain-model.md` §5 invariant 3 |
| `SegmentProvenance` (F13 side effect) | `provenance-contract.md` §2 | `domain-model.md` §5, `phase-1` §2 D-A2 (superseded banner) |

### Phase 2 readiness

**Ready: yes.** The five P0 corrections change types, not architecture — no accepted decision was overturned, and the stack is unchanged.

Three things Phase 2 must get right on the first commit, because they are structural rather than cosmetic:

1. `withTenant` uses the row-returning raw API, and the isolation test asserts a query outside it returns zero rows.
2. `packages/contracts` emits a real `oneOf` on `dataClass`, with a *negative* test: a climatology fixture carrying `initializedAt` must fail validation.
3. `ingest` and `recompute.windows` use different DB roles from day one; the split cannot be retrofitted after the first tenant data exists.

Not blocking Phase 2: Open-Meteo paid-vs-self-host, BMKG written permission, ECMWF Set VII licence enquiry.

---

## 11. Phase 1.3 — final contract corrections

Six findings, all resolved in the contract text. No accepted decision was reopened; every fix closes a gap between what two documents each said was true.

### Finding-by-finding

| # | Finding | Resolution |
|---|---|---|
| **F23** | `background-processing.md` assigned briefing invalidation to `maintenance`, while `system-architecture.md` forbade `app_system` from writing `ai_briefings`. A stated capability that the privilege model forbids is worse than a missing one: someone implements it and the only thing that stops them is an integration test that does not exist yet. | Briefing invalidation has **one** executor: `recompute.windows` as `app_api` inside `withTenant(ownerId)`. `maintenance` may *detect* that a briefing's `inputRefs` no longer match current runs and enqueue that work — never mutate. New `background-processing.md` §10 specifies read/write/enqueue per queue. The contradiction also exposed a deeper redundancy: derived freshness is now explicitly **computed at read time** from stored provenance (`provenance-contract.md` §5), so "mark stale" is not an operation at all and no tenant write is needed to keep a status column honest. |
| **F24** | `background-processing.md` §3 still defined `forecastRunId = {provider}:{model}:{product}:{initializedAt}`, contradicting the UUIDv7 id in the contract. | `ForecastRun.id` is UUIDv7, the only persisted/exposed identifier. `(provider, model, product, initializedAt)` is the natural key used for lookup and upsert and for nothing else. Job keys resolve the UUIDv7 at enqueue time. The composite string survives only in the sentence forbidding it. |
| **F25** | `verification_truth` sat under `kind: "forecast"`, so using CHIRPS or IMERG as truth would have been recorded as a forecast input — a false class in the provenance record, produced by the very schema that exists to prevent it. | `purpose: "input" \| "verification_truth"` is now orthogonal to `kind`/`role`, and `role: "verification_truth"` no longer exists. CHIRPS-as-truth is `{kind:"dataset", role:"satellite_estimate", purpose:"verification_truth"}`; a later SEAS5 run as truth is `{kind:"forecast", role:"seasonal", purpose:"verification_truth"}`. `annual_outlook` was added as a forecast role, matching `SegmentProvenance` and `ForecastValue`. A role→`dataClass` table makes the mapping explicit and assertable. |
| **F26** | `withTenant(user: AuthUser, …)` vs `withTenant(ownerId, …)`. | One signature: `withTenant(userId: UUID, fn)`. Requests pass `user.id`; workers pass the resolved `ownerId`. Taking an object would force background jobs to fabricate a user record — the impersonation the role split exists to prevent. Transaction-local `set_config` and the row-returning raw API are unchanged. |
| **F27** | `SegmentProvenance` named `forecastRunIds` but not `ingestionRunIds`, while `DataInputRef` named both. | Added `ingestionRunIds` to the `forecast` and `dataset` variants. Rationale: a `normalizerVersion` bump supersedes `WeatherRecord` rows, so the same forecast run can yield different values — a segment naming only the forecast run cannot explain why last week's number for the same day changed. Non-redundant because segments attribute date ranges to sources while `inputRefs` lists the artifact's inputs as a set. Climatology takes no ingestion id; a baseline is rebuilt only by version bump. |
| **F28** | The hash descriptor said `dataInputRefs[]` while the field is `inputRefs`; and it repeated `extractionPolicy`/`resolvedCells` outside the snapshot hash while also including the snapshot hash. | Descriptor now uses `inputRefs` and is defined per artifact (`MonthlyOutlook` has no field snapshot; the agronomy artifacts carry `fieldSnapshotHash`). `fieldSnapshotHash` appears **instead of** the snapshot body, and the duplicated `extractionPolicy`/`resolvedCells` were removed — they are inside the snapshot the hash covers, so repeating them created a second place to drift. Canonicalisation stated once. |

### Decisions accepted

**A23.** `maintenance` is read-and-enqueue only. Its write surface is non-tenant bookkeeping (`sync_attempts`, dead-letter status, sweep watermark). It may not mark tenant rows stale — because derived freshness is computed, not stored.

**A24.** `ForecastRun.id` is UUIDv7; the natural key is a lookup mechanism, never an identifier. This is now enforced as a rule, not a habit.

**A25.** `purpose` is orthogonal to `kind`/`role`; no role names a purpose. Verification truth is whatever class the evidence actually is.

**A26.** `withTenant(userId: UUID, fn)` — id in, not user object.

**A27.** Segment provenance names both forecast and ingestion runs, because values depend on the normalizer version.

**A28.** One descriptor field name (`inputRefs`) and one inclusion rule (snapshot hash, not snapshot body).

### Decisions rejected

**R11. Do not add a `recompute.briefings` queue back.** The briefs suggest either keeping invalidation in `maintenance` or moving it to the tenant-scoped path; a third queue was already deleted in Phase 1.1 for good reason. The tail of an existing job is the right place.

**R12. Do not split `verification_truth` into its own `kind`.** It is a purpose, not a data class; a fifth variant would have made the union describe intent instead of evidence.

**R13. Do not store a materialised `is_stale` flag to avoid read-time computation.** That would reintroduce the tenant-write problem F23 exposed, and would make staleness a thing that can disagree with its inputs.

### Remaining risks

| Risk | Why it survives | Validation needed |
|---|---|---|
| Read-time freshness computation costs a join per response | acceptable at this scale, unmeasured | Phase 4: measure on a 12-month outlook with 4 segments |
| `maintenance` may read more metadata than it needs | the boundary is documented, not enforced by a policy (weather tables have no `user_id`) | Phase 2: separate DB roles with column-level grants if the read surface grows |
| `purpose: "verification_truth"` on a `forecast` variant could be misused to smuggle a non-truth input | it is legal in the type system by design | Phase 9: `verify` writes only to scoring tables; a recommendation must never carry `purpose: "verification_truth"` — assert on persist |
| `fieldSnapshotHash` correctness depends on one canonicalisation implementation | a second implementation would silently produce different hashes for identical fields | Phase 2: single exported `canonicalJson` helper + golden-vector test |
| Segment `ingestionRunIds` may list runs that no longer hold the rows used | supersession replaces rows rather than keeping per-normalizer copies | Phase 4: confirm superseded rows remain hashable, or store hashes at ingest |

### Consistency verification (static only)

| Check | Result |
|---|---|
| No composite string used as an identifier | pass — the only remaining occurrences of `{provider}:{model}:{product}:{initializedAt}` are the rule that forbids it (`background-processing.md` §3) and this review; no schema, contract, or example uses one |
| UUIDv7 is the only id space | pass — `api-conventions` §1, `provenance-contract` §3, RLS policy cast, `withTenant(userId: UUID)` |
| No `app_system` job writes a tenant-owned row | pass — `system-architecture` §8 table + `background-processing` §10 agree; `ai_briefings` appears only under `recompute.windows` |
| `verification_truth` cannot be written as a role | pass — the string exists only as a `purpose` value |
| `withTenant` has one signature | pass — `system-architecture`, ADR-002 D8, `background-processing` §7/§10 |
| Hash descriptor field name | pass — `dataInputRefs` appears nowhere |
| Segment provenance carries both run ids | pass — and `ingestionRunIds` is `[string, ...string[]]`, so the old "empty array means climatology" ambiguity cannot return |

**What this does not establish:** that any of it runs. There is no code and no integration test in this phase. Every claim above is about document agreement, and each row that says "pass" means "the documents no longer disagree", not "the system behaves this way".

### Phase 2 readiness

**Ready.** The three implementation-time gates are unchanged and now sharper:

1. `withTenant(userId: UUID, fn)` with the row-returning raw API, plus a test asserting a query outside it returns zero rows.
2. `packages/contracts` emits `oneOf` on `dataClass` with `source?: never` on climatology, plus a negative fixture.
3. Role split from commit one: `app_system` never writes `ai_briefings`, `suitability_runs`, `planting_windows`, `farms`, or `fields`; assert it with a test that attempts the write and expects it to fail.

External blockers unchanged: Open-Meteo licensing, BMKG written permission, ECMWF Set VII access.

---

## 12. Phase 1.4 — hash contract closable

Four findings from an external read of the Phase 1.3 documents, each verified against the file before changing it. Two would have blocked implementation of the hash contract outright.

| # | Finding | Resolution |
|---|---|---|
| **F29** (P0) | `fieldSnapshotHash` was defined as "sha256 over every field above", inside an interface whose last field is `fieldSnapshotHash`. The preimage would have contained its own digest — not implementable, and the kind of definition that gets "fixed" differently by every developer who touches it. | Preimage is now an explicit type: `FieldSnapshotPayload = Omit<FieldSnapshot, "fieldSnapshotHash">`. The stored row is `FieldSnapshot`; the hash input is the payload. Stated in the doc rather than left to intuition. |
| **F30** (P1) | The descriptor example used `"artifact": "planting_window"` for `SuitabilityRun` and `AiBriefing` as well. Since `artifact` is inside the hash, a suitability run and an AI briefing could collide with a window whenever their inputs matched — and nothing outside the hash compares artifact type, so the collision would be silent. | `DerivationDescriptor` is a four-variant union with a per-variant `artifact` literal and per-variant fields. `monthly_outlook` has no field state; the two agronomy artifacts carry snapshot/profile/engine; `ai_briefing` carries snapshot, `sourceArtifactHashes`, `promptVersion`, `modelId`. |
| **F30b** (found while fixing F30) | `ai_briefing` had no way to change its hash when `engineVersion` changed, because it consumes windows rather than forecasts. Identical weather plus a new engine version yields different windows and an identical briefing hash — a direct violation of the invariant. | Added `sourceArtifactHashes: string[]` — the sorted `inputSnapshotHash` values of the artifacts summarised. Engine version and profile version are then captured transitively, without duplicating them. |
| **F31** (P1) | "maintenance may only read metadata" was prose. RLS does not bind a `BYPASSRLS` role, so the sentence enforced nothing at runtime. | `background-processing.md` §10 now specifies column-level `GRANT SELECT` lists, the absence of `UPDATE`/`DELETE` on tenant tables, a default-deny rule for new tables, and a Phase 2 test that runs as `app_system` and asserts the forbidden `SELECT geom`, `SELECT body FROM ai_briefings`, and `UPDATE ai_briefings` each fail with `insufficient_privilege`. `system-architecture.md` points at it. |
| **F32** (P2) | `background-processing.md` §8 said a failed recompute leaves windows "intact and flagged stale", while the freshness contract says nothing materialises `is_stale`. An implementer reading only §8 would add the column. | Rewritten: the previous window stays active and intact; the read path reports `dataAvailability = "stale"` with `reason = "recompute_failed"` from the stored failed state; **no `is_stale` column is written**. |

### Decisions accepted

**A29.** Hash preimages are named types (`FieldSnapshotPayload`), not prose descriptions of "everything above".

**A30.** `artifact` is a per-variant literal in `DerivationDescriptor`. A shared literal is a silent hash collision, not a formatting shortcut.

**A31.** A derived artifact that consumes other derived artifacts records their hashes (`sourceArtifactHashes`), not their versions. Versions can stay equal while output changes; hashes cannot.

**A32.** Read restriction for a `BYPASSRLS` role is expressed as PostgreSQL grants plus a failing-operation test. Prose is not a control.

### Decisions rejected

**R14. Do not add a separate `contextHash` for briefings.** The context is the input set; a second hash over the same material is a second value that must agree and can drift. `sourceArtifactHashes` covers the one thing the shared descriptor could not.

**R15. Do not keep one descriptor shape with optional per-artifact fields.** Optional `engineVersion`/`promptVersion` would let a window hash match a briefing, which is exactly the collision F30 identified.

**R16. Do not put `is_stale` on the artifact "just for query convenience".** It would reintroduce the tenant write that F23 removed, and create a status that can disagree with the inputs it claims to summarise.

### Risks

| Risk | Validation needed |
|---|---|
| Column-level grants rot when a column is added | Phase 2: a test enumerating granted columns per table, or a migration check that fails on unlisted tenant columns |
| `sourceArtifactHashes` requires a canonical order and dedup rule | Phase 2: sorted, deduplicated, asserted in the golden-vector test |
| `FieldSnapshotPayload` must be hashed by exactly one implementation | Phase 2: single exported `canonicalJson` + `hashFieldSnapshot`, with a golden vector checked into the repo |
| Widening a grant is a one-line migration with no review signal | Phase 3: grants reviewed in the same PR as schema changes, and a CI diff over `app_system` privileges |

### Consistency verification (static)

| Check | Result |
|---|---|
| No hash preimage contains its own output | pass — `fieldSnapshotHash` excluded via `Omit`; `inputSnapshotHash` and `computedAt` never appear inside `DerivationDescriptor` |
| `artifact` discriminator is unique per artifact | pass — four literals, four variants |
| Every artifact type has exactly one descriptor | pass |
| `app_system` read surface is granted, not described | pass — explicit column lists; defaults deny |
| No materialised `is_stale` anywhere | pass — the string appears only in the sentence forbidding it |
| `contextHash` absent | pass — replaced by `inputSnapshotHash` + `sourceArtifactHashes` |

Again: static. No code, no database, no failing `UPDATE` has actually been observed. F31's test is still to be written.

### Phase 2 readiness

**Ready, and now the first three Phase 2 tasks are unambiguous**: contracts (`oneOf` + descriptor union), database (grants + roles), tenant isolation (withTenant + isolation test). No further architecture pass is warranted; the remaining uncertainty is implementation, which documents cannot resolve.

### Addendum after 1.4 (no new phase)

Two gaps were found in review of the 1.4 text. Neither warranted a pass of its own; both were contract omissions that would otherwise be rediscovered as a failing test in Phase 2.

1. **Array ordering was undefined.** Sorted object keys do not normalise array order, and `resolvedCells` arrives in provider order — so two ingests of the same run could hash the same data differently. `provenance-contract.md` now carries an ordering/dedup table for every set-like array, declared as part of `canonicalJson` rather than left to callers, with a permutation golden vector required.
2. **Grant checks stopped at grants.** PostgreSQL privileges are inherited and ownership bypasses grants. `background-processing.md` §10 now requires connecting as `app_system` and asserting non-ownership, non-membership of `app_api`, no table-level DML, no `PUBLIC` privilege, no `ALTER DEFAULT PRIVILEGES` residue, and an exact column-set match.

Both are Phase 2 acceptance criteria. Architecture review stays closed.
