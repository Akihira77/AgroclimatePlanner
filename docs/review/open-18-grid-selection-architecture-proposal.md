# `OPEN-18` — grid cell selection semantics: architecture decision proposal

**Status:** proposal. **No source code, contract, migration, registry entry, test or
fixture is changed by this document, and nothing is decided.** `OPEN-18` remains open;
the two options below are for an owner decision.

**Scope:** resolve questions 6 and 7 of `OPEN-18`, raised by the measured
`ecmwf_ifs025` evidence in `docs/review/open-18-open-meteo-ifs025-evidence.md`.
Question 6 asks how a nearest-centre grid can be represented; question 7 asks whether
`cell_selection` belongs in ingest identity.

Evidence is tagged:

- **Verified** — read from this repository, or produced by a command in it.
- **Reported** — received from a provider or a source outside the repository.
- **Concern** — a risk or gap identified here, not a defect in shipped code.

Baseline: `70d758b`. Nothing here supersedes a measurement; §1.3 records one place
where the earlier report's conclusion needs a conditional correction.

---

## 1. Current behaviour and constraints

### 1.1 What `resolveGridCell` does today

| Rule | Implementation | Evidence |
|---|---|---|
| A cell owns `[node, node + step)` on both axes; the node is the south-west corner | `climate-data-foundation.md` §5.2.2 rule 3 | Verified |
| Index is a floor, not a truncation: `i = floorDiv(latµ − originLatµ, stepLatµ)`, same for `j` | `grid.ts:418-419` | Verified |
| `latRange` must sit inside `[-90, 90]`, and both bounds must be lattice points of the origin | `grid.ts:279-286` | Verified |
| A `global` longitude domain wraps the **input** into `[originLon, originLon + 360)`, then floors | `grid.ts:397-400` | Verified |
| The anchor is derived from the indices, never from the request; `cellKey` is `"<lat>,<lon>"` with the precision the origin and step require | `grid.ts:432-451` | Verified |
| One `GridSpec` per `(provider, model)`; a re-grid is a new `model` string | `grid.ts:521-563`, ADR-007 D1 | Verified |
| The spec is the only configuration a resolution is built from | `grid.ts:652-670`, ADR-007 D3 | Verified |
| The semantics version is a constant, `"grid-resolve/1"` | `grid.ts:595-608` | Verified |

Eighteen synthetic vectors pin this behaviour, and four literal hashes pin the preimage
(`grid.test.ts:132-167`, plus a fifth in `registry.test.ts`). The vectors are the
executable definition of the rule
above; changing the rule without changing them would leave the suite asserting a
different algorithm than the one shipped.

### 1.2 What the provider does

From the evidence report, all **Measured** on 2026-11-24:

| Property | Measured behaviour |
|---|---|
| Lattice | Global regular `0.25°`, nodes at multiples of `0.25` including `0`, `±90`, `−180` |
| Served coordinate | the **centre** of the selected cell, not a corner |
| Selection | the **nearest node**, ties toward `+∞`; 41/41 pairs |
| `resolveGridCell` against the same 41 pairs | **14/41** — the floor picks the lower node |
| `cell_selection` | request parameter; `land` (default) ≠ `nearest`; changed the served cell at 7 of 8 probed locations |
| `elevation` | a DEM value at the *requested* point; not a cell property |
| Request longitude `180` | served `179.75`; request `−180` serves `−180` |

The decisive mismatch is structural, not numerical: the provider's node **is** the cell
identity, and our node is the cell's **corner**.

### 1.3 Why the evidence report concluded "unrepresentable", and what that conclusion
actually covers

The report's §5 shows that keeping the v1 ownership rule and shifting the anchor lattice
by half a step requires `latRange = [-90.125, 89.875]`, which `grid.ts:279-281` refuses.
**Verified.** That is correct **for the v1 ownership rule**.

It is not a proof about every possible `GridSpec` semantics. If the ownership rule
itself becomes a declared input, the node set is exactly `{-90, …, 90}` and the node
range is exactly `[-90, 90]`, so no bound needs relaxing (§3.2, §4.2). The choice between
"shift the lattice" and "declare the rule" is the choice between the two options below.
Until that choice is made, the evidence report's §5 stands; if an ADR changes the
ownership rule, annotate that section rather than rewriting the finding.

### 1.4 Constraints any option must respect

1. `(provider, model)` stays the configuration key; a change that re-points stored cells
   still needs a new `model` string (ADR-007 D1, `OPEN-18` owner decision 2026-11-21).
2. No weakening of geographic validation. `latRange ⊆ [-90, 90]` stays; bounds stay
   lattice points.
3. `cellKey` stays `"<lat>,<lon>"`; `UNIQUE (provider, model, cell_key)` already carries
   the other two components (ADR-007 D3).
4. The node is never replaced by the served coordinate, and a served coordinate is
   never invented. Resolution still stops before the provider is called (§5.2.8).
5. `requireValidated`, `GridEvidence`, and the "grade C never configures" rule are
   untouched.
6. One algorithm constant, one key format, one registry. No second resolver beside the
   first.
7. A retry with the same effective configuration is idempotent; a change in effective
   configuration must not masquerade as the previous derivation.

---

## 2. Problem statement

Two independent defects were measured; they need separate fixes and separate decisions.

**P1 — the partition rule is not an input.** `GridSpec` encodes origin, spacing,
orientation, and ranges, but the rule that decides *which* node owns a coordinate is
hard-coded to the lower edge. A provider whose cell is centred on its node therefore
cannot be configured: the same lattice, read with the wrong ownership rule, mislabels
about two requests in three, in both directions (one provider cell under two keys; one
key spanning two provider cells).

**P2 — a request parameter participates in cell identity invisibly.** `cell_selection`
changes which cell is served for the same `(provider, model, coordinate)`. It appears
nowhere in `GridSpec`, the registry key, `gridSpecHash`, `ForecastRun`, `IngestionRun`,
or `WeatherRecord`. Two ingests that differ only in that parameter are, today,
indistinguishable by identity.

P1 is a resolver-contract question. P2 is a provenance and idempotency question. An
option that fixes one and not the other is incomplete.

---

## 3. Option A — an explicit selection mode on `GridSpec`

### 3.1 What changes

`GridSpecInput` and `GridSpec` gain one required field:

```ts
readonly cellSelection: "lower-edge" | "nearest-centre";
```

- `lower-edge` is today's rule: cell owns `[node, node + step)`; the node is the
  south-west corner.
- `nearest-centre` is the measured provider rule: cell owns
  `(node − step/2, node + step/2]`; the node is the cell's centre.

### 3.2 Where the field belongs — `GridSpec`, not the registry entry

**Decision proposed: on the spec.** The alternatives and why they fail:

| Placement | Consequence |
|---|---|
| **`GridSpec` (recommended)** | the spec remains the complete description of the partition; `resolveGridCell(spec, request)` stays a pure function of its two arguments; `gridSpecHash` alone reproduces a cell, which is what ADR-007 D3 claims |
| `GridRegistryEntry` | `resolveGridCell` takes a bare `GridSpec` and would not know the mode; `createSpatialResolution` would have to pass the entry's field into the resolver, creating two call paths, and `gridSpecHash` would stop pinning the behaviour that produced a key |
| `SpatialResolution` request argument | the mode is configuration, not a per-call request; a caller could then re-interpret one stored cell two ways |
| Adapter only | the resolver would still floor, so the adapter would have to pre-round coordinates — moving identity computation out of the resolver, which §5.2.1 exists to prevent |

The registry entry keeps exactly what it has: names, spec, declared evidence.

### 3.3 Resolver algorithm

```ts
// lower-edge (unchanged)
i = floorDiv(latµ - originLatµ, stepLatµ)
j = floorDiv(lonµ - originLonµ, stepLonµ)

// nearest-centre
i = floorDiv(2*(latµ - originLatµ) + stepLatµ, 2*stepLatµ)
j = floorDiv(2*(lonµ - originLonµ) + stepLonµ, 2*stepLonµ)
```

The doubled arithmetic avoids a half-step micro-degree, which is not representable for
every legal step: `0.25°` is `250000µ°` (halves cleanly), but a step of `1µ°` is not.
Ties resolve toward `+∞` on both axes, matching the measured `0.125 → 0.25`,
`−0.125 → 0.00`, `−33.875 → −33.75`. `floorDiv` already has the correct behaviour for
negative deltas; no `Math.round` may be used, because it is half-up toward `+∞` only for
positive values.

**Bounds.**

- `latRange` keeps its current meaning under `lower-edge` — the cell range, whose upper
  bound is the exclusive edge — and names the **node range** under `nearest-centre`,
  where both bounds are centres. A bounded `lonRange` follows the same split.
  `rowCount`/`colCount` are the number of **indexable rows and columns**: cells under
  `lower-edge`, nodes under `nearest-centre`. The spans therefore stay as they are for
  `lower-edge` and gain one for a bounded nearest-centre grid (`span/step + 1`), since
  both of its bounds are centres. `±90` stay legal, and a global latitude domain over
  `[-90, 90]` has 721 nodes. A `global` longitude domain keeps `colCount = 360/step`;
  the last node is `originLon + 359.75` on a `0.25°` grid.
- Request validation is unchanged: latitude must be inside `[-90, 90]` **and** inside
  `latRange`; longitude must be inside the domain. Consequence, stated rather than
  hidden: on a **bounded** nearest-centre grid, a coordinate in the outer half-cell
  beyond the last node is `out_of_grid` even though it lies inside that cell's outer
  edge. No known provider needs the outer half-cell, and accepting it would require
  bounds outside `[-90, 90]` at the poles — the relaxation §1.4 rule 2 forbids.
- `global` longitude needs one explicit sub-rule: after wrapping the input into
  `[originLon, originLon + 360)`, nearest-centre rounding of an input in the top
  half-cell yields index `colCount`, which is not a node. The measured `179.99 → 179.75`
  is consistent with clamping that result to `colCount − 1`, i.e. the last cell extends
  to `originLon + 360` rather than wrapping to the first node. **Proposed:** clamp.
  **Concern:** the clamp is inferred from that measurement and must be confirmed by one
  more, (`179.90` is the discriminating case: clamp → `179.75`, index-wrap → `−180`),
  before a golden vector pins it.
- The exact input `180` is still folded to `−180` by the existing input wrap, so the
  resolver would return `−180` while the provider returned `179.75`. That is the
  antimeridian question, not the selection mode, and §6 keeps it separate.

### 3.4 `cellKey` and `anchor`

The key format does not change. What changes is what the node **means**:
`lower-edge` → the cell's south-west corner; `nearest-centre` → the cell's centre.
`ResolvedGridCell.nodeLat/nodeLon` keep their name and their rule ("derived from the
indices, never the request"), and the doc comment gains the mode distinction.

This is the property that makes the eventual `ecmwf_ifs025` spec coherent: for a
nearest-centre grid, `cellKey` equals the provider's served coordinate exactly, so
`outlook_cells.cell_key` and `served_lat`/`served_lon` agree instead of describing a
corner and a centre of the same cell.

### 3.5 `gridSpecHash`

`cellSelection` must participate in the preimage. Two configurations that differ only
by mode produce different `cellKey` values for the same request; a hash that omitted
the field would claim they are the same configuration.

Two ways to add it:

| Approach | Cost | Risk |
|---|---|---|
| **Include unconditionally (recommended)** | all five literal fixtures change once: four in `grid.test.ts:132-167`, one in `registry.test.ts` | none today — no `gridSpecHash` is persisted anywhere, and the fixture comment already prescribes "replace a literal in the same commit that changes the preimage" |
| Omit when `lower-edge` | fixtures untouched | a required field becomes conditionally absent from its own preimage; a reader has to know the default to interpret hash equality. `lonRange`'s conditional inclusion is different: it is structurally absent on a `global` grid, not a defaulted value |

The first is recommended because the hash's stated job is to pin the whole reviewed
definition (ADR-007 D2). A one-time, reviewed regeneration of five literals is exactly
what those literals exist for.

**Concern.** `spatialResolutionKm` remains in the preimage (question 5 of §5.2.9.3).
That is independent of this proposal and stays open; a nearest-centre spec is not the
place to settle it.

### 3.6 `GRID_RESOLUTION_ALGORITHM_VERSION`

**Proposed: bump to `"grid-resolve/2"`.** The comment at `grid.ts:595-605` says to bump
when a change can move a request to a different cell or change how a result reproduces.
Strictly, no `grid-resolve/1` spec changes behaviour — the new branch is unreachable
without the new field. But the constant is global, not per-spec, and a stored `/1`
result must be readable as "produced by a codebase that had no centre mode". The cost is
zero: no resolution is persisted today (`SpatialResolution` is returned by two routes
and stored nowhere — Verified), and the version is not in `ingestionVersion`.

If the owner prefers the strict reading, keeping `"grid-resolve/1"` is defensible
because old resolutions remain reproducible. It must then be stated that the version
identifies the mapping *rule set*, not the set of supported modes.

### 3.7 `SpatialResolution`

**Proposed: add `cellSelection`.** The result currently says `anchor` without saying
whether that anchor is a corner or a centre — and that distinction is the entire defect
being fixed. `gridSpecHash` identifies the spec, but a client holding only a resolution
cannot dereference a hash. One string makes the result self-describing; omitting it
means every consumer that cares must also fetch the spec from the registry.

### 3.8 Golden vectors

Vectors 1–18 describe `lower-edge` behaviour and stay valid **byte for byte**, provided
`lower-edge` remains the semantics of the vectors' own specs. New vectors are additive:

| # | Grid | Input | Expected | Proves |
|---|---|---|---|---|
| 19 | `0,0` / `0.25,0.25` / global, nearest | `0.13, 0.13` | `0.25,0.25` | interior rounds up to the nearest centre |
| 20 | same | `0.12, 0.12` | `0.00,0.00` | the same lattice, the other side of the midpoint |
| 21 | same | `0.125, 0.125` | `0.25,0.25` | tie toward `+∞` |
| 22 | same | `-0.125, -0.125` | `0.00,0.00` | tie toward `+∞` from below; a `Math.round` shortcut is wrong for negatives in general |
| 23 | same | `-6.21, 106.79` | `-6.25,106.75` | negative latitude and longitude, floor on a negative index |
| 24 | `-90,-180` / `0.25,0.25` / global, nearest | `89.88, 179.99` | `90.00,179.75` | pole node and the longitude seam clamp |
| 25 | same | `-89.88, -179.99` | `-90.00,-180.00` | the opposite pole and the low seam |
| 26 | same | `0.0, 179.9` | `0.00,179.75` | **pending §11 decision 2**: clamp vs index-wrap |
| 27 | bounded `[10.5,12.5]²` / `0.25,0.25`, nearest | `12.6, 10.6` | `out_of_grid` | the outer half-cell is refused, not silently clamped in latitude |
| 28 | origin `0.123456` / `0.25,0.25` / bounded `(0.123456,10.123456)`×`(0,10)`, nearest | `0.2, 0.2` | `0.123456,0.123456` | precision: the node is exact, not the request |
| 29 | vector 19's lattice, `lower-edge` | `(0.13, 0.13)` | `0.00,0.00` | the same lattice and request under both modes produce adjacent nodes — the field is load-bearing |
| 30 | `0,0` / `0.25,0.25` / global, nearest | `0.0, 180.0` | **not pinned yet** | depends on the antimeridian decision (§6); do not add until it is made. Today's documented fold would answer `0.00,-180.00` |

Also required: a literal `gridSpecHash` fixture for a nearest-centre spec, so editing
the mode out of the preimage fails a test rather than silently agreeing.

**No vector may be added for the provider's `180 → 179.75` answer until §11 answers it.**
A golden vector is a decision, not a place to record an observation.

### 3.9 Registry validation

Unchanged. A nearest-centre spec can be registered as `synthetic` for tests and only a
person may declare it `validated`. `requireValidated` still refuses everything that is
not declared `validated`. Nothing about the mode may become an implicit evidence signal:
a nearest-centre spec is not "more real" than a lower-edge one.

### 3.10 Testing requirements

- The eighteen existing vectors pass unmodified, proving the default path did not move.
- Vectors 19–25 and 27–29 plus the nearest-centre hash fixture; 26 is added only after
  decision 2, and 30 only after decision 3.
- A regression table of the 41 recorded request→served pairs from the evidence report,
  asserted against an `ecmwf_ifs025`-shaped **synthetic** spec (provider string
  `synthetic`), proving 41/41 rather than 14/41. The table is a committed measurement
  extract, cited to the evidence report; it is not a network test.
- A test that `cellSelection` is in the hash preimage (two specs differing only by mode
  hash differently).
- A test that an unsupported mode string is rejected with a typed
  `GridConfigurationError`, like `unsupported_grid_orientation`.
- A test that a bounded nearest-centre grid rejects the outer half-cell.

Test count and file placement are the implementation task's to decide; this proposal
specifies the cases, not the layout.

### 3.11 Identity compatibility

`cellKey` format unchanged; `rowCount`/`colCount` unchanged for every existing spec;
hashes change only because the preimage gains a field (once); no persisted hash exists.
Nothing historical is re-interpreted.

---

## 4. Option B — redefine `cellKey` as the nearest node, globally

### 4.1 What changes

No new field. `resolveGridCell` always uses the nearest rule; the node is the cell
identity for every grid; the `[node, node + step)` ownership rule is deleted.

### 4.2 Bounds and poles

`latRange` becomes the node range in the only remaining mode, so `[-90, 90]` is still
legal and nodes exist at both poles. `defineGridSpec`'s validation is otherwise
unchanged: no bound moves and no lattice-point rule is relaxed; only the derived
`rowCount`/`colCount` change, because they now count nodes. The evidence report's
"unrepresentable" conclusion does **not** apply to this option, for the same reason as
§1.3.

### 4.3 Antimeridian

Identical to Option A: the input wrap still folds `180` onto `−180`, and the seam clamp
question is the same. Option B does not resolve it, and must not be presented as doing
so.

### 4.4 Hash and version

No preimage field is added, but `rowCount` changes meaning from cells to nodes, and it
is hashed: a `0.25°` global latitude domain goes from `720` rows to `721`, so **every**
literal fixture changes anyway. `GRID_RESOLUTION_ALGORITHM_VERSION` **must** bump to
`"grid-resolve/2"` — this is not optional here, because every spec's mapping changes.

### 4.5 Vectors and keys

The eighteen vectors are the executable definition of the current rule. Under Option B,
vectors 1, 4, 6, 9, 10, 12 and 15 change their expected `(i, j, key)` or their prose.
Vector 1's `(0.5, 0.5)` is exactly a tie and rounds to `1.00`; `0.999999 → 1.00` no
longer proves "just below a boundary"; vector 6's `-6.21` reaches `-6.20` instead of
`-6.25`; vector 12 inherits vector 1's input and changes with it. Vector 10's two inputs
stop agreeing: `−0.5` rounds to `0.0` while `359.5` rounds to `359.0` under the seam
clamp. The vector table in §5.2.7, the rules in §5.2.2, and the
worked examples in §5.2.9.3 all have to be rewritten, not extended.

`cellKey` keeps its format; every key's **meaning** changes. A key minted by a
lower-edge codebase and a key minted by a nearest-centre codebase look identical.

### 4.6 Compatibility

- No persisted cell identity can exist today through a code path (registry holds only
  `synthetic`; the `outlook_cells_provider_check` in
  `20261118030000_domain_tables/migration.sql:326-327` excludes `synthetic`, so even the
  synthetic pair cannot persist; the writers are `resolveCell` and the ingest persistence
  path, both through `upsertCell`). **Verified by reading the code and schema; no live database was
  inspected.** Hand-inserted rows in an environment would not be covered.
- Therefore re-keying has no migration cost in the repository — and no safety net
  either: the change is invisible in storage and visible only in behaviour. That is a
  reason for care, not a reason to prefer the option.
- Every future provider is forced into centre semantics. If a future provider's cell is
  genuinely lower-edge — unknown, because none is validated — it becomes
  unrepresentable, and the only remedy is another global re-definition.

---

## 5. Hash and identity policy (applies to the recommended option)

The three identities are distinct and must not be merged:

| Layer | What it identifies | Where it lives | Changes when |
|---|---|---|---|
| **Configuration** | one reviewed lattice + selection rule | `gridSpecHash` over `gridId`, origin, steps, ranges, domain, counts, `spatialResolutionKm`, `cellSelection` | any of those fields changes; a re-grid is a new `model` string |
| **Algorithm** | the mapping rule set that reads a configuration | `GRID_RESOLUTION_ALGORITHM_VERSION` | the index arithmetic, coordinate domain, wrapping, anchor derivation, or key format changes |
| **Provider binding** | which provider product a configuration describes | registry `(provider, model)` | the provider's product or grid changes |
| **Request configuration** | the provider parameters that change what a request returns | **new** `requestParametersHash`, inside `ingestionVersion` | a parameter that can change the served cell or value changes |
| **Ingestion** | one logical ingest of one run under one configuration | `ingestionVersion = sha256(adapterVersion, normalizerVersion, targetSelectorHash, requestParametersHash)` | any of its four components changes |
| **Record** | one value at one cell, variable, instant, member | `(forecastRunId, cellKey, variable, validAt, ensembleMember)` | a re-normalisation supersedes; it never duplicates |

Rules:

1. **`cellSelection` is configuration, not request configuration.** It decides what a
   `cellKey` means, so it is hashed in `gridSpecHash`. It is not a provider request
   parameter and must not appear in `requestParametersHash`.
2. **`cell_selection` is request configuration, not lattice configuration.** For a
   nearest-centre spec only `nearest` is compatible at all (see §5.1); the value is
   pinned, hashed into ingestion identity, and never into `gridSpecHash`.
3. **A new `model` string is required when the *configuration behind existing keys*
   changes** — origin, spacing, ranges, or selection mode. It is not required when only
   the algorithm version bumps: no cell has been persisted yet, and once they are, a
   bump marks a stored resolution as produced by an older rule set rather than
   redefining the grid. Existing `provider`/`model`/`gridId` strings are immutable:
   nothing is re-labelled in place.
4. **`spatialResolutionKm` stays open as question 5.** If it is later removed from the
   preimage, every hash changes once and every stored `gridSpecHash` (none today) would
   need re-derivation. Do not bundle that change with this one.
5. **`targetSelectorHash` keeps its meaning**: the sorted `(cellKey, variable)` set. It
   answers "which cells and variables", not "how the provider was asked".

### 5.1 Ingest identity for `cell_selection`

**What changes when the flag changes.** For the same requested coordinate the provider
serves a different cell; under a nearest-centre spec that means a different `cellKey`
for a user-facing resolution, and a different served coordinate for a node-keyed ingest.
Three consequences:

1. The cell a stored `cellKey` names is a function of the flag as well as of
   `(provider, model, cell_key)`. That is a new component in the identity of the cell's
   *meaning*.
2. Two ingests that differ only by the flag must not collide in `ingestionVersion`,
   or one will be treated as a retry of the other.
3. A change must not silently supersede values fetched from a different physical cell.

**Verdict per candidate location:**

| Location | Verdict | Reason |
|---|---|---|
| `GridSpec` / `gridSpecHash` | **no** | it is not a lattice property; `land`/`sea` are DEM lookups the resolver cannot model. Adding it would make two specs whose cells agree hash differently for a request-only reason |
| Adapter configuration + startup assertion | **yes, mandatory** | the adapter must send an explicit `cell_selection` (not rely on the default) and refuse to run against a nearest-centre spec with any value other than `nearest` |
| `ForecastRun` natural key | **no** | it identifies the provider's model output. The flag does not change the output; putting it there would mint a second `ForecastRun` for one initialization |
| `targetSelectorHash` | **no** | it names the requested `(cellKey, variable)` set. Folding a fetch parameter in would make the selector no longer reproducible from the selector rows |
| **`ingestionVersion` via a new `requestParametersHash`** | **yes, recommended** | this is the identity of one logical ingest. It already hashes adapter and normalizer versions precisely because a change in how values were fetched or produced must create a new ingest rather than a retry |
| `WeatherRecord` key | **no** | adding a component would duplicate every value when the flag changes; the row already stores `ingestion_run_id`, `requested_*`, `served_*`, and the ingestion row carries the parameter hash |
| `outlook_cells` column | **no** | a cell's meaning is pinned by its model binding. A per-row flag would either sit outside the unique key — so one key could be re-labelled in place, changing what it denotes — or join it, which duplicates what the model binding already is |

Alternatives to a new component, and why they are worse:

- **Fold the parameters into `adapterVersion`** (`"open-meteo-ifs@1+cell_selection=nearest"`).
  It works today with no migration, but gives one column two meanings: a code change and
  a configuration change become indistinguishable, and the string has no canonical form,
  so a whitespace difference mints a new ingest.
- **Fold them into `normalizerVersion`.** Wrong layer: the normalizer never sees the
  request.
- **Change nothing, rely on the stored served coordinate.** The drift guard
  (`resolveForecastCells`, `packages/database/src/weather.ts:248-254`) does catch a moved
  served coordinate for an existing key and raises `ProviderCoordinateDriftError` →
  terminal `provider_changed`. That is a real safety net and must stay. But it fails the
  whole ingest with a misleading cause, fires only after cells were minted, and cannot
  distinguish a provider re-grid from a local misconfiguration. It is a backstop, not
  the identity mechanism.

**Recommended mechanism.** A canonical `requestParametersHash`:

- Preimage: canonical JSON of the *effective* request parameters, defaults resolved —
  endpoint, `models`, `cell_selection`, `elevation` (present/absent), `timezone`,
  `forecast_days` and any other parameter that can change the served cell or the value.
  Variables are **not** in it; they are in `targetSelectorHash`.
- Stored on `app.ingestion_runs` beside `target_selector_hash`, with a
  `^[0-9a-f]{64}$` check, and part of `ingestionVersion`. That is a migration and a
  contract change — deliberately **out of scope** for the next task (§12) and scheduled
  after the resolver decision.
- Retained raw payloads need no new key: `raw_payload_ref` identifies bytes, and the
  ingestion row that points at them carries the parameter hash.
- The adapter pins `cell_selection=nearest` explicitly; a nearest-centre spec plus any
  other value is a startup failure, not a silent fallback. `land` and `sea` cannot be
  modelled by a nearest-centre spec and must be refused rather than approximated.

### 5.2 Idempotency and supersession, after the change

| Event | Expected effect |
|---|---|
| Retry, same effective parameters | same `requestParametersHash` → same `ingestionVersion` → same `IngestionRun`, `attempt` increments, no new rows |
| Adapter code change, same parameters | new `adapterVersion` → new `IngestionRun`; records supersede |
| `cell_selection` changed on an existing binding | new `requestParametersHash` → new `IngestionRun`; **and** the cell drift guard refuses the write for every already-served cell → `provider_changed`. The two signals together say "configuration changed", not "the provider re-gridded" |
| Provider re-grids | served coordinates move under the same key → drift guard fires → `provider_changed`; a new `model` string is required to continue |
| `elevation` override added | new `requestParametersHash` → new ingest. Precipitation was measured unchanged, but temperature is downscaled and would not be; never assume variables are inert |

**Concern.** Under a nearest-centre binding, a flag change cannot be made safe by
`ingestionVersion` alone, because `WeatherRecord`'s live key does not include the
ingestion. The drift guard is the only thing that stops the supersession, and it only
protects cells whose `served_*` is already written. A cell minted by `resolveCell` (with
`served_*` NULL) holds no values, so nothing is overwritten, but a user who resolved it
under the old flag was shown a mapping that the later ingest does not honour — a
resolution-history inconsistency, not data loss. The case that does hold values is the
one whose first ingest happened under the old flag, and that is exactly the case the
guard covers. The
proposal therefore depends on the guard staying in place; removing it, or writing
records before resolving cells, would reopen the hole.

---

## 6. Antimeridian and longitude policy

### 6.1 Measured

| Request | Served | Value |
|---|---|---|
| `0.0, 179.99` | `0.0, 179.75` | 3.9 |
| `0.0, 180.0` | `0.0, 179.75` | 3.9 |
| `0.0, -180.0` | `0.0, -180.0` | 6.9 |
| `0.0, -179.99` | `0.0, -180.0` | 6.9 |

### 6.2 The generic contract

`§5.2.9.3` documents that on a `global` grid with `originLon = -180`, the input `180`
folds to `-180` and lands in the same column as `-180`. **Verified** — `grid.ts:397-400`.
That rule is deliberate: `180` and `-180` are one meridian, and a global grid must not
invent two cells for one position.

### 6.3 Analysis

- The provider returns **two different cells with different values** for the two
  representations of one meridian. That contradicts the premise behind the folding rule,
  but it does not follow that the generic rule is wrong: it is a statement about
  equivalent coordinates, and the provider's answer is a statement about its own
  indexing.
- The behaviour is **not** a general longitude concern. Global wrapping, bounded
  rejection, and the exclusive upper edge all behave as documented; the anomaly is
  confined to the seam at `originLon + 360`.
- A **non-wrapping nearest rule** fits the measurements: on the node set
  `{-180, …, 179.75}`, `179.99` is `0.24` from `179.75` but only `0.01` from the seam
  position, and the seam position is the same meridian as node `−180` — so a nearest
  rule that crosses the seam would choose `−180`, and the provider chose `179.75`. Only
  `179.99` and `180` discriminate between the two rules; `−179.99` and `−180` agree under
  both. **Concern:** this is a hypothesis consistent with two discriminating coordinates,
  not a documented provider rule, and it predicts `179.90 → 179.75`. It must not be
  written down as fact until measured; the evidence report's §3.7 rightly refused to
  explain it.
- If the clamp rule of §3.3 is adopted, the resolver reproduces `179.99 → 179.75`, but
  still folds the exact input `180` to `-180`. So one coordinate in the whole domain
  would disagree with the provider's answer under any variant that keeps the documented
  folding rule.

**Verdict:** this is a **provider-specific exception** for the exact input `180`, and a
**generic seam rule** for the top half-cell. They must be decided separately:

1. Does a `global` nearest-centre grid clamp the top index (adopt/no)? Proposed in §3.3
   because the alternative (index wrap to the first node) diverges from both measured
   points at the seam.
2. Does the resolver keep folding the exact input `180` to `-180` (the documented rule),
   or does it adopt a provider exception? **Do not invent an explanation.** Both answers
   are defensible: keep the generic rule and accept one disagreeing coordinate, or add a
   provider-specific rule and accept that the generic contract now has an exception.

**What must be pinned by golden vectors:** the resolver's own answer for `180` under
`originLon = -180` (vector 30, once decided), and the seam clamp (vector 26, once the
`179.90` measurement confirms it). The provider's answers stay in the evidence report as
measurements and are not encoded as expectations.

Different provider responses **can** legitimately map to distinct cell identities:
`179.75` and `-180` are adjacent nodes and distinct keys, so storage has no collision.
What is unresolved is only the *request→cell* answer for the meridian itself.

---

## 7. Decision matrix and recommended option

| Dimension | Option A — explicit mode | Option B — node redefinition |
|---|---|---|
| Correctness against the measured provider | **Direct**: the mode states the measured rule; 41/41 reproducible | **Direct** for this provider; no worse |
| Generality across providers | **Strong**: a per-model rule, which is the architecture's premise (`ADR-001` D8, `OPEN-18` owner decision). Lower-edge and nearest-centre can coexist | **Weak**: one universal rule for all providers; a genuinely lower-edge provider becomes unrepresentable, and the remedy is another redefinition |
| Backward compatibility (code) | Additive required field; every `defineGridSpec` call site must add it — intentional, compile-time | `resolveGridCell` behaviour changes silently; no compile error anywhere |
| Backward compatibility (identity) | Existing keys and vectors unchanged; hashes change once, because the preimage gains a field | Every key's meaning changes, and every hash changes too because `rowCount` moves; no stored hash or key can be trusted without version annotation |
| Historical data safety | Strong: no old key is re-interpreted | Acceptable only because no cell row can exist today; hand-inserted rows in any environment become unverifiable |
| Implementation complexity | Medium: one branch, one field, bound/count rules for a second mode, hash regeneration | Low code, high documentation: every rule, vector and worked example in §5.2 must be rewritten |
| Testing complexity | Medium: 18 vectors unchanged, ~11 new cases, one fixture | High: 7 existing vectors change meaning, and the suite stops being a regression net for the old rule because there is no old rule left to test |
| Migration impact | None (no persisted identity); ingestion identity work is separate and needed either way | None in schema; a re-keying event with no database record of it |
| Long-term maintainability | Two documented rules, selected by a required field; the field is visible in the hash and the result | One rule; but the same field will be needed the first time a provider disagrees |
| Reversibility | High: the mode defaults to today's behaviour; removing it later is a contract change but old specs stay interpretable | Low: reverting means re-interpreting every key a second time |

**Recommendation: Option A.** Option B is a smaller diff in `grid.ts` and a larger,
less reversible change everywhere else. A universal rounding rule is precisely what the
2026-11-21 owner decision refused ("a universal `floor(lat / resolution)` is refused
because it assumes a zero origin, square cells, and one axis orientation"), and
`ADR-001` D8 says the rounding rule is **per model**. Option A keeps that premise,
keeps the 18 vectors as a regression net for the default path, and makes the selection
rule a reviewed, hashed input rather than an ambient code behaviour. Option B's only
genuine advantage — one rule instead of two — is theoretical: no second rule is
currently expressible, so B removes a capability before any provider needs it and
without evidence that no provider does.

The recommendation is **not** a decision. The owner may reasonably prefer B's
uniformity, and the cost of adopting A is a required field on every spec plus five
regenerated hash literals.

---

## 8. Historical compatibility strategy

Under Option A:

| Artifact | Effect |
|---|---|
| `cellKey` format | unchanged |
| Existing `outlook_cells` rows | none can exist through a code path today (registry has only `synthetic`; the provider `CHECK` excludes `synthetic`; the only writers are `resolveCell` and the ingest persistence path, both through `upsertCell`). **No live database was inspected** — an environment with hand-inserted rows must be inventoried before rollout |
| `weather_records.cell_key` | unchanged shape; no row can exist for a provider grid today |
| 18 golden vectors | unchanged and still valid; they describe the default mode |
| 5 literal hashes | change once, in the same commit as the preimage change, per the fixture's own regeneration note |
| `SpatialResolution` results | not persisted; no stored value to reinterpret |
| `GRID_RESOLUTION_ALGORITHM_VERSION` | bumps to `grid-resolve/2` (or stays, if the owner prefers the strict reading; §3.6) |
| Existing specs | gain `cellSelection: "lower-edge"`, which is their current behaviour |
| `gridId`s | unchanged; a nearest-centre spec under a new `gridId` is a new configuration |

If an environment does contain rows, the compatibility claim narrows to: their keys are
still lattice nodes and remain resolvable, but their meaning is only "lower-edge" if
they were minted by a `lower-edge` spec. There is no way to tell from the key alone,
which is exactly why the mode belongs in the pinned configuration.

---

## 9. Migration and rollout strategy

Nothing ships until the owner accepts one option. Then, in order:

1. **ADR-008 (or an ADR-007 amendment) records the decision** — placement, algorithm,
   hash preimage, version, `SpatialResolution`, seam rule, antimeridian rule. No code
   before the ADR is accepted.
2. **Contract change, one commit:** add the field, the branch, the typed rejection of an
   unknown mode, the bound/count rules, the result field, the version bump; regenerate
   the five literals; add vectors 19–25, 27–29 and the nearest-centre hash fixture
   (26 and 30 wait for decisions 2 and 3). Update
   `CONTRACTS_VERSION` and the package version (`0.2.0` → `0.3.0`) because a required
   field is a breaking type change.
3. **Documentation, same or adjacent commit:** §5.2.2 rules, §5.2.3 algorithm, §5.2.7
   vector table, §5.2.9.2 result table, §5.2.9.3 seam rule and the antimeridian question,
   ADR-007's "current state" bullet, `OPEN-18`, `IMPLEMENTATION_STATUS`.
4. **Then, separately, provider configuration.** Not part of this rollout: the
   `ecmwf_ifs025` spec still needs the Grade A gap answered (the identifier is not
   documented), the antimeridian decision, and the `spatialResolutionKm` question.
   Registering it as `validated` is a review decision, not a code change.
5. **Then, separately, ingestion identity:** `requestParametersHash` in contracts, the
   `ingestion_runs` column and check, `ingestionVersion` preimage, `provenance-contract`
   §3, `background-processing`, `tables-climate`, `tables-catalog`, migration and tests.
6. **Then, separately, adapter and production ingestion.** Not authorised by this
   proposal.

Rollback: step 2 is a compile-time change and no data is written, so reverting restores
the previous behaviour exactly. Steps 5–6 write data and need their own rollback
analysis. There is no data migration for step 2, and none is possible: identity is
computed, not stored, for the configurations that exist today.

---

## 10. Test strategy (summary)

| Layer | Cases |
|---|---|
| Contract, existing | the 18 vectors unchanged; the 5 literal hashes regenerated exactly once, in the preimage commit |
| Contract, new mode | vectors 19–25 and 27–29: interior both sides of a midpoint, tie up and tie down, negative coordinates, pole nodes, longitude seam clamp (pending §11's discriminating measurement), bounded outer half-cell rejection, precision with a fractional origin, and the same-grid-two-modes comparison |
| Contract, hash | a nearest-centre literal; two specs differing only by mode hash differently; an unknown mode string is a typed configuration error |
| Contract, evidence | the 41 recorded request→served pairs reproduce 41/41 against a nearest-centre synthetic spec, with the evidence report cited. None of the 41 is within `179°` of the antimeridian, so this table does not pre-judge §6 |
| Registry | a nearest-centre `synthetic` entry resolves and `requireValidated` still refuses it; duplicate `(provider, model)` still fails |
| Ingest (later task) | same effective parameters → same `ingestionVersion`; changed parameter → different version; adapter refuses `nearest`-incompatible flags; drift guard still terminal |

No test in this list asserts a network response.

---

## 11. Remaining owner decisions

In dependency order. None is made here.

1. **Option A or Option B** (§7). Everything else depends on it.
2. **Seam rule** for a `global` nearest-centre grid: clamp the top index to the last
   node (proposed; supported by `179.99`) or wrap it to the first node. The exact `180`
   folds before rounding and is decision 3, not evidence for this one. A single
   measurement at `179.90` settles which rule the provider uses.
3. **Antimeridian at exactly `180`** (§6.3): keep the documented fold to the origin
   column, accepting one coordinate that disagrees with the provider, or introduce a
   provider-specific exception. Do not choose a cause for the provider's behaviour.
4. **Hash preimage timing**: include `cellSelection` unconditionally and regenerate the
   five literals (recommended), or keep the old hashes with a conditional preimage.
5. **Algorithm version**: bump to `grid-resolve/2` (recommended) or keep `/1` on the
   strict "no existing mapping changed" reading.
6. **`spatialResolutionKm` in the preimage** — the existing question 5. Still open; must
   be settled before any provider spec is registered, and must not be bundled with this
   change.
7. **`requestParametersHash`**: accept a new `ingestion_runs` column and an
   `ingestionVersion` preimage change, or fold the parameters into `adapterVersion`.
   The former is recommended; the latter is cheaper today and ambiguous forever.
8. **A mode change ever becoming supported**: if it is, it needs a new `model` string
   and an explicit exception to "provider's own name, no local aliasing". Until then,
   pin `nearest` and refuse anything else.
9. **Grade A for `ecmwf_ifs025`** (unchanged by this proposal): a source naming the
   identifier and stating origin/construction, or an owner decision that measured
   grade B carries the geometry.

---

## 12. Implementation boundaries for the next task

Authorised only after decisions 1–5 above are recorded.

**In scope:**

- `packages/contracts/src/grid.ts`: the field, the branch, the bound/count rules, the
  result field, the version bump, typed rejection of an unknown mode.
- `packages/contracts/src/grid.test.ts`: new vectors, the nearest-centre hash fixture,
  regenerated literals (explicitly reviewed).
- `packages/weather-core/src/grids/registry.test.ts`: its own hash literal, if affected.
- `docs/architecture/climate-data-foundation.md` §5.2, `docs/adr/` (new ADR or an
  ADR-007 amendment), `docs/data-model/open-decisions.md` `OPEN-18`,
  `docs/IMPLEMENTATION_STATUS.md`.

**Out of scope, explicitly:**

- Registering any provider grid, adding a `validated` entry, or computing a
  `gridSpecHash` for `ecmwf_ifs025`.
- Any migration, grant, RLS or tenant-isolation change.
- `requestParametersHash`, `ingestionVersion`, `IngestionRun`, adapter changes, or
  production ingestion.
- Changing `requireValidated`, `GridEvidence`, the `synthetic` registry entry's
  provider/model strings, `cellKey`'s format, or any of the 18 existing vectors'
  expectations.
- Deciding `OPEN-03` (licensing) or any other open decision.
- Resolving `OPEN-18` itself. The resolver decision is one of its blockers, not the
  last one.

**Acceptance for that task:** the 18 vectors pass unmodified; the new vectors and hash
fixture pass; `typecheck`, `lint`, `build`, `prettier --check .` clean; `contracts` and
`weather-core` suites green; the diff touches no runtime behaviour for `lower-edge`
specs; and no real provider name appears in a registry entry.
