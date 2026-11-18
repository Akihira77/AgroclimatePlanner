# Provenance Storage

`docs/architecture/provenance-contract.md` defines the contract;
`packages/contracts/src/*.ts` implements it and the golden vectors enforce it.
This document states **how each contract type is stored**, and the three places
where the answer is "not as a column".

The governing rule, which every decision below follows:

> If a field participates in a canonical-JSON hash preimage, it is stored as the
> document that was hashed. Shredding it into columns creates a second
> serialiser, and the hash would then be computed from a reconstruction rather
> than from the bytes that were hashed.

## 1. Where each contract type lives

| Contract type | Storage | Table(s) |
|---|---|---|
| `DataInputRef` (4 variants) | `input_refs jsonb` — array of documents | `monthly_outlooks`, `suitability_runs`, `planting_windows`, `ai_briefings` |
| `FieldSnapshot` / `FieldSnapshotPayload` | `field_snapshot jsonb` (whole) + `field_snapshot_hash text` beside it | `suitability_runs` (the only table that stores the body) |
| `fieldSnapshotHash` | `field_snapshot_hash text` | `suitability_runs`, `planting_windows`, `ai_briefings` |
| `EvidenceSegment[]` | `evidence_segments jsonb` — ordered array | `planting_windows` |
| `MissingRange[]` | `missing_ranges jsonb` | `planting_windows`, `monthly_outlooks` |
| `DerivationDescriptor` (4 variants) | **not stored as a document** — its constituent fields are columns, and `input_snapshot_hash` is the hash of the descriptor | every derived table |
| `DerivationProvenance` | columns: `input_refs`, `input_snapshot_hash`, `derivation_version`, `computed_at`, `reproducible`, `unreproducible_reason` | every derived table |
| `ForecastRun` | a row | `forecast_runs` |
| `IngestionRun` | a row | `ingestion_runs` |
| `DerivedFreshness` / `SourceFreshness` | **nowhere** — computed at read time | — |
| `recordSetHash` | `text` beside the data set it hashes | `climatology_normals` per row: none; see §6 |

### Why `DerivationDescriptor` is the exception

The descriptor *is* a hash preimage, so the rule above says store it whole. It is
the one type where the columns are the preimage, and that works because the
descriptor is a flat object of scalars and one embedded array:

| Descriptor field | Column |
|---|---|
| `artifact` | implied by the table |
| `inputRefs` | `input_refs` |
| `fieldSnapshotHash` | `field_snapshot_hash` |
| `profileVersionId` | `profile_version_id` |
| `engineVersion` | `engine_version` |
| `derivationVersion` | `derivation_version` |
| `promptVersion` | `prompt_version` |
| `modelId` | `model_id` |
| `sourceArtifactHashes` | `source_artifact_hashes text[]` |

Reconstructing the descriptor from those columns is lossless **because every one
of them is a scalar, a UUID, or an array of hex strings that the canonicaliser
sorts by the same rule** (`sourceArtifactHashes: { kind: "set", dedupe: true }`).
No timestamp and no free-form object is inside the descriptor, so no
representation can be lost in the round trip. `inputRefs` is stored as the
document precisely because it is a nested object with a timestamp inside it
(`initializedAt`).

That asymmetry is a rule, not a preference: **a field whose value has more than
one textual representation (any timestamp, any float, any enum written by a
provider) must live inside a JSONB document; a field with exactly one
representation may be a column.** The `timestamptz` columns that exist beside
documents (`computed_at`, `initialized_at`) are for querying and are never hashed.

## 2. `DataInputRef` — four variants, one array

```ts
type DataInputRef =
  | { kind: "forecast"; role: …; purpose: …; forecastRunIds; ingestionRunIds; recordSetHash }
  | { kind: "baseline"; role: "climatology"; purpose: …; baselineVersion; baselineHash; cellKeys }
  | { kind: "observation"; role: "field_observation"; purpose: …; observationIds; recordSetHash }
  | { kind: "dataset"; role: "reanalysis" | "satellite_estimate"; purpose: …; datasetVersion; recordSetHash };
```

Storage and query consequences:

| Property | Consequence |
|---|---|
| discriminated by `kind` | a JSONB array of mixed variants; `jsonb_typeof(input_refs) = 'array'` is the only DB-level check |
| canonical order is `(kind, role, purpose)` | **the array must be read as a set**. Two artifacts with the same refs in different insertion order have the same `inputSnapshotHash`, and the stored array reflects the producer's order, not a sorted one |
| `purpose` is orthogonal to `kind`/`role` | the same run can appear twice in one array with different purposes; `dedupe: false` for `inputRefs` is what makes that legal |
| nested id arrays sorted first | `forecastRunIds`, `ingestionRunIds`, `cellKeys`, `observationIds` are `set` + `dedupe`; a producer's emission order cannot affect the hash |
| `firstId: true` | a ref's identity for ordering is its first id, which is why the nested arrays are sorted *before* the parent |

**What the database does not enforce**: that every `forecastRunIds` entry exists
in `forecast_runs`, that every `baselineVersion` exists in
`climatology_normals`, or that the array contains at least one ref. A JSONB
column with foreign keys inside it cannot be constrained. Validation is
Zod-at-the-boundary, and a dangling reference is detected by the provenance audit
in Phase 5, not by `INSERT`.

## 3. `FieldSnapshot` — stored whole, on one table

`field_snapshot jsonb` + `field_snapshot_hash text` exist on `suitability_runs`
only. `planting_windows` and `ai_briefings` carry the **hash**, not the body.

Reason: the snapshot is a property of the field and its resolution at compute
time. Every window and briefing produced by one run shares the run's snapshot
verbatim; storing it three more times would multiply the storage of the largest
document in the model and create three copies that could diverge after a partial
recompute. Reading a window's snapshot is one join to its run.

Consequences:

1. **The body is immutable once written.** `suitability_runs` is append-and-
   supersede; a recompute is a new row with a new snapshot.
2. **`fieldSnapshotHash` is duplicated out of the document.** By contract the
   hash is *not* inside the payload (`FieldSnapshotPayload` omits it), so the
   stored document and the column are two separate things and the column is what
   can be indexed (`suitability_runs_hash_idx`). `hashFieldSnapshot` rejects a
   payload carrying `fieldSnapshotHash` at runtime, because a structural type
   cannot stop an untyped caller from passing the persisted `FieldSnapshot`.
3. **An edited field cannot retcon a stored run.** The snapshot holds
   `geometryHash`, `areaHa`, `soilPh`, `irrigationAvailable`, `resolvedCells`, and
   `observationsUsed`; the field row may since have changed, and the run still
   describes what it actually evaluated.
4. **`observationsUsed` embeds observation ids, not values.** The values are
   referenced through `field_observations`; if an observation is edited, the
   snapshot hash does not change — and that is a real limitation, recorded as
   `OPEN-29`. The alternative (embedding values) would make the snapshot immune to
   edits but would duplicate measurement data into a hash-preimage document.

## 4. `EvidenceSegment[]` and `MissingRange[]`

```ts
interface EvidenceSegment {
  startDate; endDate;            // ISO dates, Asia/Jakarta
  evaluationBasis;               // daily | weekly | monthly | climatology
  evidenceClass;                 // WeatherDataClass
  coveragePercent;               // 0..100
  provenance: SegmentProvenance; // forecast | climatology | observation, discriminated
}
```

| Aspect | Storage rule | Why |
|---|---|---|
| order | **`sequence`** — the canonicaliser neither sorts nor repairs | position is semantic: the partition invariant is over an ordered interval walk |
| dedupe | none | two identical segments are a domain error, and the canonicaliser is not the validator |
| dates | ISO strings **inside** the document | they are part of the hash preimage; the `date` columns on the row (`window_start`/`window_end`) are for querying |
| coverage | number, `0..100` | not a fraction; no rounding |
| `SegmentProvenance` | discriminated union inside the document | an entry cannot claim a run id it does not have |

**The partition invariant is not enforced by the database.** No overlap, no gap,
full span, internal contiguity, reason presence, coverage reconciliation — six
checks over interval algebra in a JSONB array. `provenance-contract.md` §4 states
the validator does not exist yet, and this model does not pretend a `CHECK` can
do it. Specified as a Phase 3 write-path blocker (`OPEN-26`), not a schema change.

`missing_ranges` is the complement and is a **set** (`orderBy: [startDate,
endDate]`, `dedupe: false`), not a sequence: nothing about a gap's position in the
array means anything. That difference between two arrays that look alike is
exactly why `canonicalArrayRules` is keyed by field name.

`evidenceSegments` and `missing_ranges` are never joined to `weather_records`.
The segment names run ids and a baseline version; the values it summarises are
reachable through `input_refs`, which is the coarser and correct granularity.

## 5. Hash columns

```sql
input_snapshot_hash text NOT NULL CHECK (input_snapshot_hash ~ '^[0-9a-f]{64}$')
```

| Column | Preimage | Where |
|---|---|---|
| `input_snapshot_hash` | `canonicalJson(DerivationDescriptor)` — exactly one of the four variants | every derived table |
| `field_snapshot_hash` | `SHA256(canonicalJson(FieldSnapshotPayload))` — payload excludes the hash | 3 tables |
| `ingestion_version` | `sha256(adapter_version, normalizer_version, target_selector_hash)` | `ingestion_runs` |
| `target_selector_hash` | hash of the requested cells/variables | `ingestion_runs` |
| `geometryHash` | SHA-256 of the stored EWKB representation, **without geometry normalization** | inside `field_snapshot` |
| `recordSetHash` | hash over the record set a ref consumed | inside `input_refs` |
| `baselineHash` | hash over the stored normals for the exact `cellKeys` consumed | inside `input_refs` |

- `text` + lowercase hex, never `bytea` (`physical-model.md` §6).
- `CHECK` on shape only. The database cannot verify a hash it did not compute,
  and a trigger that recomputed one would need the canonicaliser — a TypeScript
  implementation with golden vectors — inside PostgreSQL. That duplication is
  refused deliberately; the hash is trusted because it was produced by the one
  implementation, and verified by replay in the audit.
- **`baselineHash` depends on a subset, not a table.** It is computed over the
  normals for the cells a derivation actually consumed, so it cannot live as a
  column on `climatology_normals` — a per-row hash would be a hash of the wrong
  thing.

## 6. `recordSetHash` and where it is absent

`recordSetHash` appears inside `input_refs` (forecast, observation, dataset
variants) but has **no column** in `weather_records`. A record set is defined by
what a derivation consumed — a cell subset, a variable set, a validity range —
which is a query result, not a table. Storing it would require materialising
"the set" as an object, and the model deliberately does not own that concept.

The consequence is honest and worth stating: **you cannot look up a `weather_records`
row from a `recordSetHash`, and you cannot recompute the hash from the table
without reconstructing the exact query.** The reproducibility path is
`forecastRunIds` + `ingestionRunIds` + `cellKeys` + the descriptor's validity
range, and the hash is the check at the end of that reconstruction.

## 7. `reproducible` — a stored claim with a stored reason

| Table | Default | Rationale |
|---|---|---|
| `suitability_runs` | `true` | deterministic engine, stored snapshot, stored inputs |
| `planting_windows` | `true` | same |
| `ai_briefings` | **`false`** | a model call is not replayable by construction |

Enforced by `reproducible OR unreproducible_reason IS NOT NULL` on all three.
The default is `true` for the deterministic artifacts because claiming
unreproducibility when everything was stored would be a false disclaimer, and
defaulting to `false` would let a missing `raw_payload_ref` hide behind it.

Known causes that force `false` on a deterministic artifact: provider payload not
retained (a licensing decision, `OPEN-05`), or a field edited in a way the
snapshot cannot reconstruct. Both are recorded on the row, not inferred later.

## 8. What is deliberately not stored

| Not stored | Where the value comes from instead |
|---|---|
| freshness (`DerivedFreshness`, `SourceFreshness`) | computed at read time from `initialized_at` / `baseline_version` age; storing it would create a second source of truth a job can leave stale (`provenance-contract.md` §5) |
| `dataAvailability` | computed per source at read time; a derived artifact reports the **set** of stale roles, not a stored boolean |
| a `context_hash` for briefings | the context *is* the input set; a second hash over the same material is a second thing to keep in sync |
| `temporalClass` | deprecated by ADR-001 D9; must not appear in any document, column, or type |
| a `verified` / `accuracy` column | verification truth is `OPEN-12` and has no table at all |
| a `confidence` percentage | nothing in the contract produces one; `grade` A–D is evidence quality and may never be rendered as a probability |
