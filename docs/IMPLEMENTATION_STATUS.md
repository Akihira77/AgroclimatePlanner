# Implementation Status

Last updated: 2026-11-18.

## Phase 0 — Research & validation — **DONE (revised after adversarial review)**

| Deliverable | Status | File |
|---|---|---|
| Weather source matrix | done, corrected | `docs/research/weather-source-matrix.md` |
| Agronomic reference matrix | done, corrected | `docs/research/agronomic-reference-matrix.md` |
| Forecast horizon capabilities | done, corrected | `docs/research/forecast-horizon-capabilities.md` |
| Data licensing & attribution | done | `docs/research/data-licensing-and-attribution.md` |
| ADR-001 provider strategy | done (Proposed, revised) | `docs/adr/ADR-001-weather-data-provider-strategy.md` |
| UI reference analysis (Phase 2 input) | done | `docs/design/ui-reference-analysis.md` |
| Adversarial review + amendment log | done | `docs/review/phase-0-review.md` |
| `council` review | **not run — agent not configured in this environment.** Substituted with an oracle adversarial pass; recorded as a process gap. | — |

### Verified by live request (2026-11-18, twice — second pass fixed the first pass's errors)

`api.bmkg.go.id` 3-day village forecast, 17 slots, `tp` present · Open-Meteo forecast cap 16 d · **ensemble: 50 members, data null after day 14** · EC46: 46 daily rows, no monthly product · SEAS5: 50 members, **6 monthly rows by default / 7 at `forecast_days=200–217`**, cap 217 · archive API from 1940 · historical-forecast API `ecmwf_ifs04` · NASA POWER monthly 1991–1993 · seasonal `*_spread` variables rejected (400).

### Blocking constraints recorded

1. BMKG ToU §9.3 — commercial integration needs written permission; feature flag OFF by default.
2. Open-Meteo free tier is non-commercial only — paid plan or self-host required.
3. No free gridded annual outlook — months 8–12 are climatology, permanently labelled.
4. CHIRPS bulk host unreachable from this environment — ERA5 archive is the shipped baseline fallback.
5. Model-relative anomalies are the primary user-facing number; baseline differences require grid matching and offset disclosure.
6. **ECMWF Set VII (13-month) is real but unproven for access** — months 8–12 stay climatology until a licence enquiry + GRIB POC succeed (ADR-001 D2a).
7. **All probes were one location (Jakarta).** No provider is validated for real plot coordinates yet; see `forecast-horizon-capabilities.md` §4.

### Review rounds

1. Oracle adversarial pass — found the wrong ensemble horizon (35 d → 14 d), wrong member count, wrong seasonal row count, and a bias-contaminated anomaly contract. Amended.
2. External (GPT) review — accepted on CHIRPS licensing (public domain **and** CC BY 4.0), on overclaiming "bias-free by construction", on coarse data classes, and on single-location validation. Set VII finding verified as a real product but not as accessible data. Amended.

## Next phases

Phase 1 (product requirements, system architecture, ADR-002) — **complete; reconciled in Phase 1.1 and accepted**.

| Phase 1 deliverable | Status | File |
|---|---|---|
| Product definition | done | `docs/PROJECT.md` |
| System architecture + Mermaid | done | `docs/architecture/system-architecture.md` |
| Domain model (conceptual) | done | `docs/architecture/domain-model.md` |
| Data flow | done | `docs/architecture/data-flow.md` |
| Background processing | done | `docs/architecture/background-processing.md` |
| API conventions | done | `docs/architecture/api-conventions.md` |
| **Provenance & evidence contract (normative)** | done | `docs/architecture/provenance-contract.md` |
| ADR-002 monorepo & backend | done (Proposed) | `docs/adr/ADR-002-monorepo-and-backend-architecture.md` |
| Phase 1.1 architecture review | done | `docs/review/phase-1-architecture-review.md` |

### Phase 1.1 outcome

Twelve findings, ten decisions accepted, six rejected. The two that change the physical design, not just the prose:

1. **`ForecastRun` and `IngestionRun` are separate identities**, so re-normalizing a retained payload cannot surface to users as a new forecast.
2. **`PlantingWindow` carries `EvidenceSegment[]`**, so a window crossing daily → weekly → monthly → climatology reports what it actually used instead of one class that must be a lie.

Vocabulary is now fixed: `dataClass` (canonical), `evaluationBasis`, `dataAvailability`, `forecastRunId`/`ingestionRunId`, `inputRefs[]` + `fieldSnapshot` + `inputSnapshotHash`. `temporalClass`, `precision`, bare `runId`, `outlookRunId`, `inputRunRefs`, `sourceRunIds`, and `DATA_STALE` are removed or deprecated with no live uses.

Queues reduced 10 → 6 by merging sets that shared provider, budget, retry shape, and failure mode, and by deleting `recompute.briefings` (cache invalidation is not a queue).

Phase 2 gate (unblocked): implement `withTenant` as the only DB entry point and prove isolation before features land; make `dataClass`/`evaluationBasis`/`dataAvailability`/`freshness` required in `packages/contracts` from the first weather-emitting commit; build adapters against the split run identity from the start.

### Phase 1.2 outcome — final consistency correction

Ten further findings (F13–F22), all resolved. These change **types**, not architecture; no Phase 1.1 decision was overturned.

| Correction | Effect |
|---|---|
| `inputRefs` is a four-variant union (forecast / baseline / observation / dataset) | climatology no longer needs a `forecastRunId` it does not have |
| API `WeatherValue` is a union discriminated on `dataClass`, with `source?: never` on climatology | "climatology with an `initializedAt`" is now a compile error; `displayedClass` deleted |
| `FieldSnapshot` (soil, pH, drainage, irrigation, geometry, extraction policy, resolved cells, observations) enters `inputSnapshotHash` | the hash finally means *identical computation inputs*, not just identical weather |
| One id space: UUIDv7 for PKs, URLs, and `app.user_id` | ULID removed; the `::uuid` cast in the RLS policy is now true |
| `withTenant` uses `$queryRaw` (row-returning) | `$executeRaw` was discarding `set_config`'s result — that failure mode is a cross-tenant read |
| Worker roles split: `app_system` (`BYPASSRLS`) for non-tenant jobs, `app_api` + `withTenant` for `recompute.windows` | fan-out re-specified as per-owner batches of ≤100, since a cross-tenant batch cannot run under one `app.user_id` |
| Climatology licensed **only** by `beyond_horizon` | obsolete "falls to climatology when SEAS5 is unavailable" rule removed from `background-processing` §8 |
| `IngestionRun.ingestionVersion` (identity) vs `attempt` (retry counter) | a retry storm no longer mints rows or multiplies record counts |
| v1 rejects >5 000-vertex polygons instead of simplifying them | removed a metre-tolerance claim that was actually degrees |
| Segment partition invariant is executable | `segments ∪ missingRanges` must cover the window exactly, or the window is not persisted |

Phase 2 gate unchanged and confirmed: `withTenant` first, `oneOf` contract with a negative climatology fixture, separate DB roles from the first commit.

### Phase 1.3 outcome — final contract corrections

Six cross-document contradictions (F23–F28), all closed. No Phase 0/1.1/1.2 decision reopened.

| Correction | Effect |
|---|---|
| `maintenance` is read-and-enqueue only (§10) | briefing invalidation has exactly one executor: `recompute.windows` under `app_api` + `withTenant(ownerId)`. `BYPASSRLS` no longer appears to write `ai_briefings`. |
| Derived freshness is **computed at read time**, not stored | "mark stale" is not an operation, so no tenant write is needed to keep a status honest. Failed recompute is the one stored stale state, because it is an event. |
| `ForecastRun.id` = UUIDv7; `(provider, model, product, initializedAt)` = natural key only | the composite string is now used only to name what is forbidden, not as an identifier anywhere |
| `purpose` is orthogonal to `kind`/`role` | `verification_truth` is no longer a role; CHIRPS-as-truth is `dataset/satellite_estimate` + `purpose:"verification_truth"`. `annual_outlook` added as a forecast role. Role→`dataClass` table is explicit. |
| `withTenant(userId: UUID, fn)` | requests pass `user.id`, workers pass `ownerId`; no job has to fabricate a user object |
| `SegmentProvenance` names `ingestionRunIds` too | a segment can explain why the same forecast day changed after a normalizer bump |
| Hash descriptor: one name (`inputRefs`), snapshot hash not snapshot body | duplicated `extractionPolicy`/`resolvedCells` removed |

Verification is **static only** — document agreement, not runtime behaviour. Phase 2 gate sharper: `withTenant` isolation test, `oneOf` negative fixture, and a test asserting `app_system` cannot write a tenant-owned table.
