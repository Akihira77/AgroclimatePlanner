# Provenance & Evidence Contract

Status: Phase 1.1 — **normative**. Every other architecture document defers to this one on the four axes below.
Scope: vocabulary, evidence segmentation, run identity, derived-artifact provenance, freshness, fallback semantics, API reporting.

If a document contradicts this file, this file wins until amended.

---

## 1. Four independent axes (they are not synonyms)

A single number can be, at once: computed on a monthly basis, derived from a seasonal forecast, currently stale, and reproduced by a specific run. Four axes, four fields.

| Axis | Field | Values | Question answered |
|---|---|---|---|
| Evaluation granularity | `evaluationBasis` | `daily` · `weekly` · `monthly` · `climatology` · `mixed` | How finely could this be evaluated? |
| Evidence type | `dataClass` | the 9 `WeatherDataClass` values (ADR-001 D9) | What kind of data is this? |
| Availability | `dataAvailability` | `available` · `stale` · `pending` · `unavailable` · `not_applicable` | Can I use it right now? |
| Reproducibility | `forecastRunId` / `ingestionRunId` / `derivationVersion` | ids + versions | Can I reproduce it exactly? |

Rules:
1. `evaluationBasis` is **not** a claim of quality. `monthly` on a `seasonal_forecast` is legitimate; `daily` on a `seasonal_forecast` is a lie.
2. `dataClass` is a property of the source, never of the display date. A climatology month in 2027 is still `climatology`.
3. `dataAvailability = stale` is a **usable** state; `unavailable` is not. They must never be collapsed into one flag.
4. `mixed` is only legal at the container level (a window, an outlook), never on a single value. A single value with `mixed` basis is a modelling bug.

### Deprecated terms

| Term | Status | Replacement | Reason |
|---|---|---|---|
| `temporalClass` | **deprecated** | `dataClass` | Two names for one enum caused drift between ADR-001 and the architecture docs. Survives only in Phase 0 research prose describing history. |
| `precision` (`daily\|dekadal\|monthly`) | **deprecated** | `evaluationBasis` | `dekadal` was never derivable from the monthly product and the enum could not express `mixed` or `climatology`. |
| `outlookRunId` | **deprecated** | `inputRunRefs[]` (+ `primaryForecastRunId` when a single run dominates) | A derived artifact routinely consumes EC46 + SEAS5 + climatology baseline; one id cannot represent that. |
| `runId` (bare) | **deprecated** | `forecastRunId` or `ingestionRunId` explicitly | The two were conflated, which would let a re-normalization masquerade as a new forecast. |

### Intentional distinction: `evidenceClass` vs `dataClass`

`dataClass` describes **one record**. `evidenceClass` describes **one segment of a derived artifact** and must equal the `dataClass` of the records backing that segment. They are deliberately different names because a segment also carries a basis, coverage, and run references — calling it `dataClass` would invite someone to set it by hand.

---

## 2. EvidenceSegment

A planting window spans weeks to months, crossing data classes. It is therefore composed of segments.

```ts
interface EvidenceSegment {
  startDate: string;          // inclusive, ISO date in Asia/Jakarta
  endDate: string;            // inclusive
  evaluationBasis: "daily" | "weekly" | "monthly" | "climatology";
  evidenceClass: WeatherDataClass;
  sourceRunIds: string[];     // forecastRunId values; empty for climatology
  coveragePercent: number;    // 0..100, share of days with a value
  provenance: Array<{
    provider: string;
    model: string;
    modelVersion?: string;
    initializedAt?: string;   // absent for climatology
    spatialResolutionKm: number;
    servedValueIsInterpolated: boolean;
    baselineVersion?: string; // present for climatology
  }>;
}
```

### Segment construction rules

1. Segments are **non-overlapping and contiguous** within a window. No gaps: a day either has a segment or has `dataAvailability = unavailable` recorded in `missingRanges`.
2. Segment boundaries are set by data availability, never by convenience — a `seasonal_forecast` segment starts after the last day with genuine subseasonal data, not at the start of a calendar month.
3. `coveragePercent < 100` is allowed and is reported; it is never silently rounded to 100.
4. A segment may not mix classes. If a source changes mid-interval, split the segment.
5. Climatology segments carry **no** `initializedAt` and **no** `sourceRunIds`. If either is present, the segment is mislabelled.
6. `startDate`/`endDate` for `monthly` and `climatology` segments snap to calendar months. A monthly segment may not be used to justify a day-level recommendation.

### Window-level rollup

```ts
interface PlantingWindow {
  evaluationBasis: "daily" | "weekly" | "monthly" | "climatology" | "mixed";
  evidenceSegments: EvidenceSegment[];
  primaryBasis: "daily" | "weekly" | "monthly" | "climatology"; // basis of the critical stage
  mixedEvidence: boolean;       // true iff segments contain ≥2 classes
  weakestEvidenceClass: WeatherDataClass;
  missingRanges: Array<{ startDate: string; endDate: string; reason: MissingReason }>;
}
```

`primaryBasis` is the basis covering the **critical stage** of the crop, not the basis covering the longest interval. A window whose critical stage falls in a climatology segment is a weak recommendation regardless of how good the surrounding days looked, and the API must say so.

---

## 3. Run identity

```ts
interface ForecastRun {
  id: string;                 // f_run_…
  provider: string;           // bmkg | open-meteo | ecmwf
  model: string;              // ecmwf_ifs025 | ecmwf_ec46 | ecmwf_seas5 | …
  modelVersion?: string;
  product: string;            // forecast | ensemble | seasonal | archive
  initializedAt: string;      // ISO instant, UTC
  horizonEnd: string;         // ISO instant
  receivedAt: string;
}

interface IngestionRun {
  id: string;                 // i_run_…
  forecastRunId: string;
  adapterVersion: string;     // weather-core adapter semver
  normalizerVersion: string;
  targetSelectorHash: string; // hash of the cells/variables requested
  status: "queued" | "running" | "succeeded" | "partial" | "failed";
  attempt: number;
  startedAt: string;
  finishedAt?: string;
  recordCount: number;
  coveragePercent: number;
  error?: { code: string; message: string; payloadRef?: string };
}
```

### Uniqueness

- `ForecastRun` is unique on `(provider, model, product, initializedAt)`. Optional `modelVersion` participates in identity when the provider publishes one that can change mid-run.
- `IngestionRun` is unique on `(forecastRunId, adapterVersion, normalizerVersion, targetSelectorHash, attempt)`.

### Idempotency and reprocessing

1. Ingestion **upserts** `ForecastRun` by natural key. Fetching the same run twice never creates a second `ForecastRun`.
2. Re-normalizing stored payloads creates a **new `IngestionRun`** with a bumped `normalizerVersion` and the **same `forecastRunId`**. This is the rule that prevents a normalization fix from appearing to the user as "a new forecast arrived".
3. `WeatherRecord` uniqueness: `(forecastRunId, cellKey, variable, validAt, ensembleMember)` plus `normalizerVersion` in the supersede key — a changed normalizer supersedes rows rather than duplicating them.
4. Job idempotency keys use `forecastRunId`, never wall-clock time: `ingest:{queue}:{forecastRunId}:{targetSelectorHash}`.
5. At-least-once delivery is assumed. Every consumer is safe to run twice.

### Why this matters

Without the split, a bug fix in unit conversion would rewrite `initializedAt`-derived ids, invalidate every derived artifact, and show users a "new forecast" that is the same forecast interpreted differently. The split makes reprocessing a normalizer event, not a forecast event.

---

## 4. Derived artifact provenance

Applies to `MonthlyOutlook`, `SuitabilityRun`, `PlantingWindow`, and `AiBriefing`.

```ts
interface DerivationProvenance {
  derivationVersion: string;        // version of the derivation rule set
  engineVersion?: string;           // agronomy engine semver (windows only)
  profileVersionId?: string;        // crop profile version (windows only)
  baselineVersion?: string;         // e.g. "ERA5:1991-2020:v1" (outlook only)
  inputRunRefs: Array<{
    forecastRunId: string;
    ingestionRunId: string;
    role: "short_range" | "subseasonal" | "seasonal" | "climatology" | "verification_truth";
  }>;
  inputSnapshotHash: string;        // sha256 over canonical input descriptor
  computedAt: string;
  supersedesId?: string;
  supersededById?: string;
  status: "active" | "superseded" | "failed";
}
```

### Snapshot hash definition

`inputSnapshotHash` = SHA-256 of the canonical JSON of:

```
{ artifact, cells[], variables[], variablesUnits[], evaluationBasis[],
  inputRunRefs (sorted by role,forecastRunId), baselineVersion?, profileVersionId?, engineVersion?,
  derivationVersion }
```

Canonical = sorted keys, fixed number formatting, no timestamps. Two derivations with the same hash must produce identical outputs; a hash change with identical outputs is a defect, not a feature.

### Reproducibility requirements

1. Every derived row records **every** run it consumed, not one. A 12-month outlook consumes EC46, SEAS5, and a climatology baseline simultaneously.
2. Given `inputRunRefs` + `inputSnapshotHash` + `derivationVersion`, re-running must yield byte-identical results. If it cannot (e.g. provider payload was not retained), the row is marked `reproducible: false` and the reason is stored.
3. `profileVersionId` is mandatory on windows: editing a crop profile must not retroactively change a stored recommendation.
4. Supersession is a linked list: `active → superseded`. Historical artifacts are never deleted by a recompute.

---

## 5. Freshness

Two different questions, two fields. Collapsing them produced the previous "inherit the oldest input freshness" assumption, which is wrong when one input is climatology (no freshness at all) or when a month is structurally missing rather than stale.

```ts
interface SourceFreshness {
  kind: "source";
  dataAvailability: "available" | "stale" | "pending" | "unavailable" | "not_applicable";
  initializedAt?: string;
  validAt?: string;
  ageSeconds?: number;
  ttlSeconds?: number;
  reason?: MissingReason;
}

interface DerivedFreshness {
  kind: "derived";
  computedAt: string;
  dataAvailability: "available" | "stale" | "pending";
  oldestInputInitializedAt?: string;   // min over non-climatology inputs, null if none
  staleInputRoles: string[];           // which roles were stale at compute time
  reason?: "inputs_stale" | "recompute_failed" | "superseded_pending";
}
```

### Artifact-specific policies

| Artifact | Freshness rule | Stale when |
|---|---|---|
| Forecast values (0–3 d) | `initializedAt` age | > 6 h |
| Forecast values (4–14 d) | `initializedAt` age | > 12 h |
| Subseasonal values | `initializedAt` age | > 48 h |
| Seasonal values | `initializedAt` age | > 35 d |
| Climatology | `baselineVersion` age | baseline > 13 months old |
| `MonthlyOutlook` | derived from inputs; `oldestInputInitializedAt` excludes climatology | any non-climatology input stale |
| `PlantingWindow` | derived; TTL = min over segments' source TTL, floor 6 h | window older than its shortest-lived input's TTL |
| `AiBriefing` | derived; invalidated by new run id, not by a clock | any input role changed |

### Rules

1. Climatology contributes **nothing** to `oldestInputInitializedAt`. Treating "no initialization time" as infinitely old would mark every 12-month outlook permanently stale and train users to ignore the flag.
2. `dataAvailability` is computed per source, and a derived artifact reports the **set** of stale roles, not a boolean.
3. A failed recompute does not deactivate the previous artifact: it stays `active` with `DerivedFreshness.reason = "recompute_failed"` until a successful replacement exists.
4. A new forecast run supersedes artifacts by status change, never by deletion. `supersededById` preserves the audit trail (BRAINSTORM requires "recommendation update time"; this is how it is honoured).

---

## 6. Missing data: two structurally different cases

This is the distinction that prevents climatology from disguising an operational failure.

```ts
type MissingReason =
  | "beyond_horizon"      // structural: no genuine forecast exists at this lead time
  | "not_requested"       // cell not in scope for this run
  | "pending"             // ingest queued or running
  | "ingest_failed"       // adapter/job failed
  | "provider_unavailable"// provider down
  | "insufficient_history"// baseline could not be computed
  | "below_coverage_threshold";
```

| Case | Meaning | Allowed presentation |
|---|---|---|
| `beyond_horizon` | SEAS5 genuinely stops at month 7 | Climatology, labelled `climatology`, with `dataAvailability = not_applicable` on the forecast axis and `available` on the climatology axis |
| `pending` | A run exists and is being ingested | `pending`; do **not** show climatology as a substitute in the same slot |
| `ingest_failed` / `provider_unavailable` | We have no value and no basis to claim one | `unavailable`; previous value may be shown as `stale` with the failure reason; never replaced by climatology |
| `insufficient_history` | Baseline missing for the cell | `unavailable` on both axes; say so |

The API therefore carries **two parallel axes** for every month/day:

```json
{
  "date": "2027-03-01",
  "forecast":   { "dataAvailability": "not_applicable", "reason": "beyond_horizon" },
  "climatology":{ "dataAvailability": "available", "baselineVersion": "ERA5:1991-2020:v1" },
  "value": 244.2, "unit": "mm",
  "displayedClass": "climatology"
}
```

A month never renders as a forecast because the slot needed filling.

---

## 7. API reporting of freshness and availability

`docs/architecture/api-conventions.md` §4 consumes this section. Summary:

| Situation | Status | Body |
|---|---|---|
| Fresh data | 200 | values + `freshness` |
| Stale but usable | **200** | values + `freshness.dataAvailability = "stale"` + `reason` |
| Missing, job pending | **202** | `pending` + `retryAfter`; no fabricated value |
| Provider failed, last-known usable | **200** | `lastKnown` + `dataAvailability = "stale"` + `reason = "provider_unavailable"` |
| Provider failed, nothing usable | **503** | `error.code = PROVIDER_UNAVAILABLE`, `retryAfter` |
| Partial source availability | **200** | per-source availability map + `meta.availability = "partial"` |

`503` is reserved for "the request cannot be answered with any usable value". Staleness alone is never a 5xx.

---

## 8. Cross-document obligations

| Document | Obligation |
|---|---|
| `domain-model.md` | persist `EvidenceSegment`, `ForecastRun`, `IngestionRun`, `DerivationProvenance`; no bare `runId` |
| `data-flow.md` | construct segments from availability, never from convenience; report both axes |
| `api-conventions.md` | expose `evaluationBasis`, `evidenceClass`, `dataAvailability`, per-source freshness |
| `background-processing.md` | enqueue by `forecastRunId`; reprocessing bumps `normalizerVersion` only |
| ADR-001 | `dataClass` is the canonical enum; `temporalClass` is deprecated |
| ADR-002 | derived artifacts must carry `inputSnapshotHash` and be replayable |
