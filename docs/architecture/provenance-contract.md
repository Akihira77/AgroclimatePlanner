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
| `outlookRunId` | **deprecated** | `inputRefs[]` (+ `primaryForecastRunId` when a single run dominates) | A derived artifact routinely consumes EC46 + SEAS5 + climatology baseline; one id cannot represent that. |
| `inputRunRefs` | **deprecated** | `inputRefs[]` | The field required `forecastRunId` **and** `ingestionRunId` on every entry, which climatology cannot supply — the type could not describe the thing it was created for. A discriminated union replaces it; "run" was also the wrong noun for a baseline or a field snapshot. |
| `sourceRunIds` (on a segment) | **deprecated** | `provenance: SegmentProvenance` | An empty array was the only way to express "climatology", which made an empty list indistinguishable from a bug. |
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
  coveragePercent: number;    // 0..100, share of days with a value
  provenance: SegmentProvenance;
}

// Discriminated: an entry cannot claim a run id it does not have.
type SegmentProvenance =
  | { kind: "forecast";                     // weather / subseasonal / seasonal / annual_outlook
      forecastRunIds: [string, ...string[]]; // a segment may span two runs
      ingestionRunIds: [string, ...string[]];// which processing produced the values used
      initializedAt: string }
  | { kind: "climatology";                  // baselines are not runs
      baselineVersion: string }             // e.g. "ERA5:1991-2020:v1"
  | { kind: "observation";                  // user-entered measurements only
      observationIds: [string, ...string[]] }
  | { kind: "dataset";                      // reanalysis, satellite_estimate
      datasetVersion: string;
      ingestionRunIds: [string, ...string[]] };
```

### Forecast run vs ingestion run, per level

Both levels name both ids, deliberately, because they answer different questions and a segment must be answerable on its own:

- `forecastRunIds` — **which model output** covers these days. Stable across reprocessing; what the user-facing "initialized 5 November" refers to.
- `ingestionRunIds` — **which normalization produced the numbers actually shown**. Not stable: a `normalizerVersion` bump supersedes `WeatherRecord` rows, so the same forecast run can yield different values. A segment that named only the forecast run would be unable to explain why last week's number for the same day changed.

Arrays, not scalars, because a segment can legitimately span a run boundary or a partial re-ingest of a subset of cells. `[string, ...string[]]` forbids the empty array that used to mean "climatology".

This is not redundant with `DerivationProvenance.inputRefs`: `inputRefs` describes the artifact's inputs as a set, while segments attribute specific date ranges to specific sources. A 12-month window has one `inputRefs` list and four segments; the mapping from dates to sources lives only in the segments. Climatology needs no ingestion id — a baseline is a stored artifact rebuilt only by version bump.

`evidenceClass` remains a separate field rather than being derived from `kind`, because `reanalysis` and `satellite_estimate` are distinct classes that share a provenance shape, and `weather_forecast`/`subseasonal_forecast`/`seasonal_forecast` likewise. One field answers "what kind of evidence", the other "where exactly did it come from".

### Segment construction rules

1. Segments are **non-overlapping and contiguous** within a window.
2. Segment boundaries are set by data availability, never by convenience — a `seasonal_forecast` segment starts after the last day with genuine subseasonal data, not at the start of a calendar month.
3. `coveragePercent < 100` is allowed and is reported; it is never silently rounded to 100.
4. A segment may not mix classes. If a source changes mid-interval, split the segment.
5. A `provenance.kind = "climatology"` segment carries **no** `forecastRunIds` and **no** `initializedAt` — the type forbids it. A climatology segment that can name a run is a forecast mislabelled.
6. `startDate`/`endDate` for `monthly` and `climatology` segments snap to calendar months. A monthly segment may not be used to justify a day-level recommendation.

### Partition invariant (checked in code, not just documented)

For a window `[windowStart, windowEnd]`:

```
segments ∪ missingRanges  ≡  every date in [windowStart, windowEnd], exactly once
```

Formally, the test that must exist before any window is persisted:

1. **No overlap.** `∀ s₁ ≠ s₂ : s₁.end < s₂.start  ∨  s₂.end < s₁.start`. Adjacent means `s₁.end + 1 day = s₂.start`, not overlapping.
2. **No uncovered date.** After sorting segments and missing ranges together by `startDate`, every gap between consecutive intervals is zero: `next.start = prev.end + 1 day`.
3. **Full span.** The first interval starts at `windowStart`; the last ends at `windowEnd`.
4. **Each segment is internally contiguous.** A segment with an internal hole is a modelling bug — the hole belongs in `missingRanges`.
5. **Every missing range carries a `MissingReason` and a non-empty range.** `reason: undefined` is not permitted, and `startDate = endDate` for a *missing* single day is legal but must still be explicit.
6. **Coverage reconciles.** `Σ coveragePercent × segment_length / window_length` plus missing-day share equals 100 %, within rounding. A reported 100 % coverage alongside missing ranges is a defect.

A window that fails any of these is **not persisted** — the recompute job fails and the previous window stays `active` with `reason = "recompute_failed"`. Persisting a partial partition would let a dashboard silently render a gap as coverage.

### Window-level rollup

```ts
interface PlantingWindow {
  windowStart: string;
  windowEnd: string;
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
  id: string;                 // UUIDv7 — identity of the model output, not of our fetch
  provider: string;           // bmkg | open-meteo | ecmwf
  model: string;              // ecmwf_ifs025 | ecmwf_ec46 | ecmwf_seas5 | …
  modelVersion?: string;
  product: string;            // forecast | ensemble | seasonal | archive
  initializedAt: string;      // ISO instant, UTC
  horizonEnd: string;         // ISO instant
  receivedAt: string;
}

interface IngestionRun {
  id: string;                 // UUIDv7 — identity of one *logical* ingest of one run
  forecastRunId: string;
  adapterVersion: string;     // weather-core adapter semver
  normalizerVersion: string;
  targetSelectorHash: string; // hash of the cells/variables requested
  ingestionVersion: string;   // sha256(adapterVersion, normalizerVersion, targetSelectorHash)
  status: "queued" | "running" | "partial" | "succeeded" | "failed";
  attempt: number;            // PHYSICAL execution counter, not identity
  startedAt: string;
  finishedAt?: string;
  recordCount: number;
  coveragePercent: number;
  error?: { code: string; message: string; payloadRef?: string };
}
```

### `attempt` is a counter, not a version

Two different things were previously collapsed into the uniqueness key:

| Event | Creates | Effect on `attempt` |
|---|---|---|
| BullMQ retries a failed job (network, 5xx, timeout) | nothing new | `attempt` increments **in place** |
| Same job reprocessed after the process died mid-flight | nothing new | `attempt` increments in place |
| A new `adapterVersion` or `normalizerVersion` ships | new `IngestionRun` | starts at 1 |
| The target cell/variable set changes | new `IngestionRun` | starts at 1 |

So: `attempt` records *how many times we tried the same logical ingest*. `ingestionVersion` records *which logical ingest it was*. Neither substitutes for the other, and a retry storm must never look like history.

### Uniqueness

- `ForecastRun` unique on `(provider, model, product, initializedAt)`. `modelVersion` participates in identity only where the provider publishes one that can change mid-run; otherwise it is descriptive metadata.
- `IngestionRun` unique on `(forecastRunId, ingestionVersion)`. **`attempt` is not in the key** — if it were, every transient retry would mint a row, the record count would multiply, and "how many times did we ingest this run" would have no answer.
- `WeatherRecord` supersession key includes `normalizerVersion`, so a reprocess replaces rows in place rather than accumulating parallel copies.

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
  inputRefs: DataInputRef[];        // discriminated — see below
  fieldSnapshot?: FieldSnapshot;    // required for SuitabilityRun / PlantingWindow
  inputSnapshotHash: string;        // sha256 over the canonical descriptor (below)
  computedAt: string;
  reproducible: boolean;            // false when a required input can no longer be replayed
  unreproducibleReason?: string;
  supersedesId?: string;
  supersededById?: string;
  status: "active" | "superseded" | "failed";
}
```

### `DataInputRef` — discriminated by kind

A baseline is not a run. An observation set is not a run. Forcing all three into `{ forecastRunId, ingestionRunId }` produced a type that could only be satisfied by writing `null` into required fields — which is exactly what happened before this correction.

```ts
// `purpose` separates WHY an input was consumed from WHAT it is. Verification
// truth is a purpose, not a data class: CHIRPS and IMERG are satellite_estimate,
// a later forecast run is weather_forecast. Classifying either as "forecast"
// because the word "verification" appeared would be a lie in the provenance record.
type InputPurpose = "input" | "verification_truth";

type DataInputRef =
  | { kind: "forecast";
      role: "short_range" | "subseasonal" | "seasonal" | "annual_outlook";
      purpose: InputPurpose;
      forecastRunIds: [string, ...string[]];
      ingestionRunIds: [string, ...string[]];
      recordSetHash: string }         // over the exact records consumed
  | { kind: "baseline";
      role: "climatology";
      purpose: InputPurpose;          // always "input" today; kept for symmetry
      baselineVersion: string;        // "ERA5:1991-2020:v1"
      baselineHash: string;           // over the stored monthly normals used
      cellKeys: [string, ...string[]] }
  | { kind: "observation";
      role: "field_observation";
      purpose: InputPurpose;
      observationIds: [string, ...string[]];  // user-entered measurements
      recordSetHash: string }
  | { kind: "dataset";
      role: "reanalysis" | "satellite_estimate";
      purpose: InputPurpose;          // "verification_truth" for CHIRPS/IMERG scoring
      datasetVersion: string;         // "ERA5:0.25deg:v1" | "CHIRPS:v3.0"
      recordSetHash: string };
```

### Role → `dataClass` mapping

Every role maps to exactly one class; the mapping is asserted at persist time, so a role can never disagree with the evidence it claims.

| `kind` | `role` | `dataClass` |
|---|---|---|
| `forecast` | `short_range` | `weather_forecast` |
| `forecast` | `subseasonal` | `subseasonal_forecast` |
| `forecast` | `seasonal` | `seasonal_forecast` |
| `forecast` | `annual_outlook` | `annual_outlook` |
| `baseline` | `climatology` | `climatology` |
| `observation` | `field_observation` | `field_observation` |
| `dataset` | `reanalysis` | `reanalysis` |
| `dataset` | `satellite_estimate` | `satellite_estimate` |

Rules:

1. `kind: "baseline"` carries no run ids and no `initializedAt` — climatology has no initialization. Any artifact that renders a climatology value and also names an `initializedAt` is mislabelled.
2. `purpose` is orthogonal to `role`. `{kind:"dataset", role:"satellite_estimate", purpose:"verification_truth"}` is CHIRPS used as truth; `{kind:"forecast", role:"seasonal", purpose:"verification_truth"}` is a later SEAS5 run used as truth. Neither is misclassified, and neither can be written as `role:"verification_truth"` because no such role exists.
3. Verification artifacts (`verify` jobs, skill scores) are **not** `PlantingWindow` inputs. They never appear in a recommendation's `inputRefs` with `purpose = "verification_truth"`; they live in the scoring tables. The purpose field exists so that a future backtest artifact can record them honestly without inventing a class.
4. `recordSetHash` = SHA-256 over the canonical JSON of the consumed records, each as `(cellKey, variable, validAt, ensembleMember|null, value, unit, dataClass)`, sorted. It answers "which numbers", not just "which run" — two runs can be fetched differently and still be the same run.

### `FieldSnapshot` — the agronomic inputs that are not weather

The previous hash covered cells, variables, and runs. It did **not** cover soil, irrigation, drainage, geometry, or the plot's own measurements — so two windows computed on different fields could share a hash, and a field edit would not change it. That breaks the invariant.

```ts
interface FieldSnapshot {
  fieldId: string;
  geometryHash: string;          // sha256 of geometry in canonical EWKB
  areaHa: number;                // derived, ST_Area(geom::geography)
  elevationM: number | null;
  soilType: string | null;
  soilPh: number | null;
  drainageClass: string | null;
  irrigationAvailable: boolean;
  irrigationSource: string | null;
  extractionPolicy: "centroid" | "area_weighted";
  resolvedCells: Array<{ provider: string; model: string; cellKey: string;
                         servedLat: number; servedLon: number; distanceKm: number }>;
  observationsUsed: Array<{ observationId: string; kind: string;
                            value: number; unit: string; observedAt: string }>;
  fieldSnapshotHash: string;     // sha256 over FieldSnapshotPayload — see below
}

// The hash input. `fieldSnapshotHash` is the OUTPUT of the hash, so it must not
// be inside its own preimage.
type FieldSnapshotPayload = Omit<FieldSnapshot, "fieldSnapshotHash">;

fieldSnapshotHash = sha256(canonicalJson(fieldSnapshotPayload as FieldSnapshotPayload));
```

`null` is preserved as `null`, never normalised to a default — the agronomy engine distinguishes "unknown" from "known to be neutral", and that distinction is what produces `insufficient_data` instead of a fabricated score.

The `Omit` is not cosmetic: writing "sha256 over every field above" made the definition self-referential — the hash would have to be computed from an object already containing it. The preimage is `FieldSnapshotPayload`, and the stored row is `FieldSnapshot`.

### Snapshot hash definition

`inputSnapshotHash` = SHA-256 of the canonical JSON of **exactly one** variant of `DerivationDescriptor`. `inputRefs` is the field name at every level — the earlier `dataInputRefs` alias is gone.

```ts
type DerivationDescriptor =
  | { artifact: "monthly_outlook";
      inputRefs: DataInputRef[];
      derivationVersion: string }
  | { artifact: "suitability_run";
      inputRefs: DataInputRef[];
      fieldSnapshotHash: string;
      profileVersionId: string;
      engineVersion: string;
      derivationVersion: string }
  | { artifact: "planting_window";
      inputRefs: DataInputRef[];
      fieldSnapshotHash: string;
      profileVersionId: string;
      engineVersion: string;
      derivationVersion: string }
  | { artifact: "ai_briefing";
      inputRefs: DataInputRef[];
      fieldSnapshotHash: string;
      sourceArtifactHashes: string[];   // sorted inputSnapshotHashes of the artifacts summarised
      promptVersion: string;
      modelId: string;
      derivationVersion: string };
```

`artifact` is part of the hash, so it must never be a shared literal. The previous example gave one descriptor for three artifact types with `"artifact": "planting_window"`, which would have made a `SuitabilityRun` and an `AiBriefing` hash identically to a window whenever their inputs matched — and, worse, would have collided silently, because nothing compares `artifact` outside the hash.

Per-variant field rationale:

| Variant | Why these fields |
|---|---|
| `monthly_outlook` | cell-based, no field state, no crop profile. `baselineVersion` already travels inside `inputRefs` (`kind:"baseline"`), so repeating it would be the same redundancy removed in 1.3. |
| `suitability_run` / `planting_window` | both consume field state and a crop profile. `suitability_run` is the aggregate over windows; `planting_window` is the per-window artifact. Distinct discriminators because they are distinct outputs of the same engine version, and a run must not hash-collide with a window. |
| `ai_briefing` | output also depends on the prompt and the model, which are not inputs to the engines. `promptVersion` + `modelId` are in the descriptor because changing either changes the narration for identical structured data. `sourceArtifactHashes` carries the hashes of the outlook/windows it summarised — without it, a change in `engineVersion` would produce different windows from identical forecast inputs and the briefing hash would not move, which the invariant forbids. There is deliberately **no separate `contextHash`**: the briefing's context *is* this input set, and a second hash over the same material would be a second thing to keep in sync. |

Each `inputRefs` entry contributes only its identity fields — `kind`, `role`, `purpose`, `forecastRunIds`/`ingestionRunIds`, `baselineVersion`/`datasetVersion`, `recordSetHash`/`baselineHash` — never the values themselves.

`fieldSnapshotHash` appears **instead of** the snapshot body. Including the full object would be equivalent only if canonicalisation were applied recursively and identically; hashing the snapshot once, under one documented rule, is the version that can actually be tested. Because `fieldSnapshotHash` covers every field of `FieldSnapshot` — including `extractionPolicy` and `resolvedCells` — repeating those two outside the hash was redundant and has been removed: it created a second place for them to drift from the snapshot they were supposed to describe.

Canonical form: sorted keys, fixed number formatting (no `-0`, no re-printed floats), UTF-8, no whitespace, and **no timestamps of the computation itself** — `computedAt` is deliberately outside the descriptor, otherwise no two computations could ever match.

**The invariant, restated precisely:** identical `inputSnapshotHash` ⇔ identical complete computation inputs. Two readings matter:

- Same hash, different output ⇒ **critical defect**: something that affects the result is missing from the descriptor.
- Different hash, same output ⇒ defect in the other direction: something irrelevant leaked in. Not a correctness bug, but it invalidates cache/supersession logic and must be fixed.

Conversely, **different field state must produce a different hash.** Editing a plot's soil type, drainage, irrigation flag, or geometry changes `fieldSnapshotHash`, hence `inputSnapshotHash`, hence the artifact is distinguishable from the one computed before the edit. If that fails, the hash is decorative.

### Reproducibility requirements

1. Every derived row records **every** input, not one. A 12-month outlook consumes EC46 + SEAS5 + a baseline at once; a window consumes weather **and** field state **and** a profile version.
2. Given `inputRefs` + `fieldSnapshot` + `inputSnapshotHash` + `derivationVersion`, re-running must yield byte-identical results.
3. If a required input can no longer be replayed — raw payload not retained, baseline rebuilt with a different dataset, field edited and history not versioned — the row stores `reproducible: false` **and** `unreproducibleReason`. Silent unreproducibility is not permitted.
4. `profileVersionId` is mandatory on windows: editing a crop profile must not retroactively change a stored recommendation.
5. Supersession is a linked list: `active → superseded`. Historical artifacts are never deleted by a recompute.

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
  computedAt: string;                  // when the artifact row was computed (stored)
  dataAvailability: "available" | "stale" | "pending";
  oldestInputInitializedAt?: string;   // min over non-climatology inputs, null if none
  staleInputRoles: string[];           // which roles are stale right now
  reason?: "inputs_stale" | "recompute_failed" | "superseded_pending";
}
```

`computedAt` is read from the stored row; everything else here is computed at read time from `inputRefs` plus current source freshness. `reason: "recompute_failed"` is the one value drawn from stored state — the artifact's own status — because a failed attempt is an event, not a function of the inputs.

### Derived freshness is computed, not stored

A derived artifact's `DerivedFreshness` is a **pure function of (stored `inputRefs`, current source freshness)** evaluated at read time. Nothing writes it, so no background job needs tenant write access to keep it current.

Consequences, and why this matters for privileges:

- `maintenance` never mutates a tenant-owned row to mark it stale. It only *detects* candidates and enqueues recompute; the read path computes staleness from what it finds.
- A failed recompute is the one stale state that **is** stored (`status = "failed"` on the attempt, previous artifact still `active`), because it is an event, not a function of inputs.
- A derived row that is old but whose inputs are all fresh is **not** stale. TTL on the artifact itself would be a proxy for staleness, and a wrong one.

### Artifact-specific policies

| Artifact | Freshness rule | Stale when |
|---|---|---|
| Forecast values (0–3 d) | `initializedAt` age | > 6 h |
| Forecast values (4–14 d) | `initializedAt` age | > 12 h |
| Subseasonal values | `initializedAt` age | > 48 h |
| Seasonal values | `initializedAt` age | > 35 d |
| Climatology | `baselineVersion` age | baseline > 13 months old |
| `MonthlyOutlook` | derived from inputs; `oldestInputInitializedAt` excludes climatology | any non-climatology input stale |
| `PlantingWindow` | derived from the segments' sources | any segment's source stale |
| `AiBriefing` | derived; invalidated by input identity, not by a clock | any `inputRefs` entry changed |

### Rules

1. Climatology contributes **nothing** to `oldestInputInitializedAt`. Treating "no initialization time" as infinitely old would mark every 12-month outlook permanently stale and train users to ignore the flag.
2. `dataAvailability` is computed per source, and a derived artifact reports the **set** of stale roles, not a boolean.
3. A failed recompute does not deactivate the previous artifact: it stays `active` with `reason = "recompute_failed"` until a successful replacement exists. This surfaces stored state rather than mutating it, which is why no sweep needs write access to tenant rows.
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

The API therefore carries **two parallel axes** for every month/day, and the value itself is a discriminated union:

```json
{
  "date": "2027-03-01",
  "forecast":    { "dataAvailability": "not_applicable", "reason": "beyond_horizon" },
  "climatology": { "dataAvailability": "available",
                   "baselineVersion": "ERA5:1991-2020:v1" },
  "value": {
    "dataClass": "climatology",
    "evaluationBasis": "climatology",
    "amount": 244.2,
    "unit": "mm",
    "baseline": { "baselineVersion": "ERA5:1991-2020:v1",
                  "periodFrom": "1991-01-01", "periodTo": "2020-12-31" },
    "spatialResolutionKm": 28,
    "servedValueIsInterpolated": true,
    "freshness": { "kind": "source", "dataAvailability": "available" },
    "attribution": "Copernicus / ECMWF"
  }
}
```

`dataClass` is the discriminant, and it is the **only** place the class is stated — there is no `displayedClass` or similar escape hatch. A month never renders as a forecast because the slot needed filling, and a climatology value cannot borrow a forecast's provenance shape by leaving `initializedAt` empty.

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
| `domain-model.md` | persist `EvidenceSegment`, `ForecastRun`, `IngestionRun`, `DerivationProvenance`, `FieldSnapshot`; no bare `runId`; `userId` denormalised onto tenant-owned derived tables |
| `data-flow.md` | construct segments from availability, never from convenience; report both axes; capture `FieldSnapshot` at compute time |
| `api-conventions.md` | expose `evaluationBasis`, `dataClass`, `dataAvailability`, per-source freshness; per-class **conditional** provenance through a discriminated union |
| `background-processing.md` | enqueue by `forecastRunId`; reprocessing bumps `normalizerVersion` (and therefore `ingestionVersion`); a retry bumps `attempt` only; group fan-out by owner |
| ADR-001 | `dataClass` is the canonical enum; `temporalClass` is deprecated |
| ADR-002 | derived artifacts must carry `inputRefs`, `inputSnapshotHash`, and be replayable; `BYPASSRLS` never writes tenant-owned rows |
