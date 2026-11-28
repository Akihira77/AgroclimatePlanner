# ADR-008 — Explicit Grid Cell Selection Semantics

- Status: **Accepted** — accepted 2026-11-28 by project owner (**Akihira77**).
  `nearest-centre` cell selection and `unvalidatedGridRegistry` (`ecmwf_ifs025`) are
  implemented; `ecmwf_ifs025` remains `unvalidated` and barred from validated production
  claims until grade A+B multi-coordinate evidence completes (`OPEN-18`).
- Date: 2026-11-24 (accepted 2026-11-28)
- Deciders: project owner (**Akihira77**); analysis prepared by the orchestrator.
- Depends on: `ADR-001` D8 (a fixed, documented rounding rule **per model**);
  `ADR-007` D1–D3 (registry identity, hash-as-pin, resolution result); the `OPEN-18`
  owner decision of 2026-11-21 (generic resolver approved; a re-grid is a new `model`
  string).
- Amends, if accepted: `climate-data-foundation.md` §5.2.2 rule 3, §5.2.3, §5.2.9.2,
  §5.2.9.3; `open-decisions.md` `OPEN-18` questions 6 and 7.
- Supersedes: none.
- Baseline: commit `4210167`. Evidence: `docs/review/open-18-open-meteo-ifs025-evidence.md`
  (2026-11-24) and `docs/review/open-18-grid-selection-architecture-proposal.md`
  (2026-11-24, corrected in `4210167`).

Evidence tags used here, in addition to the repository's `Verified` / `Reported` /
`Concern`:

| Tag | Meaning |
|---|---|
| **VERIFIED** | read from this repository, or recomputed in this session from committed inputs |
| **REPORTED** | documented by a prior investigation, not independently reproduced from repository content |
| **UNVERIFIED** | the repository does not contain enough evidence to decide |
| **CONCERN** | a contradiction, or a risk that must not be silently resolved |

"Recomputed in this session" means: the arithmetic was re-run against the published
tables and the resolver's own `floorDiv`, not that the raw provider corpus was re-fetched.
The corpus is not in the repository and was not re-measured.

---

## 1. Context

### 1.1 The contract as implemented (VERIFIED)

| Fact | Where |
|---|---|
| A cell owns `[node, node + step)` on both axes; the node is the south-west corner | `climate-data-foundation.md` §5.2.3; `grid.ts` doc comment |
| `i = floorDiv(latµ − originLatµ, stepLatµ)`, same for `j`; `floorDiv` is mathematical floor over integers | `grid.ts:159-162`, `grid.ts:418-419` |
| `floorDiv` exists specifically so a float boundary never decides a cell | `grid.ts:154-158` |
| `latRange ⊆ [−90, 90]`, both bounds lattice points of the origin | `grid.ts:279-286` |
| `rowCount = (latMax − latMin) / stepLat`; `colCount` likewise, or `360 / stepLon` on a `global` domain | `grid.ts:287-321` |
| A `global` domain wraps the **input** into `[originLon, originLon + 360)`, then floors | `grid.ts:396-400` |
| A `bounded` domain rejects a longitude outside `lonRange`, and the upper bound is therefore exclusive | `grid.ts:401-410`, `climate-data-foundation.md:940-943` |
| The node is derived from the indices, never from the request; `cellKey` is `"<lat>,<lon>"` | `grid.ts:432-452` |
| The hash preimage is flat and covers `gridId`, origin, steps, `latRange`, `lonDomain`, `lonRange`, `rowCount`, `colCount`, `spatialResolutionKm`, `cellAnchor` | `grid.ts:164-218` |
| `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"` | `grid.ts:606` |
| `SpatialResolution` carries provider, model, gridId, hash, version, evidence, requested, anchor, i, j, key | `grid.ts:618-636` |
| One spec per `(provider, model)`; a duplicate pair raises `duplicate_grid_spec`; an unknown pair raises `unknown_model` | `grid.ts:530-593` |
| `requireValidated` refuses anything not declared `validated` | `grid.ts:582-591` |
| The registry instance holds exactly one entry, provider/model `synthetic`, evidence `synthetic` | `weather-core/src/grids/registry.ts`, `.../synthetic.ts` |
| `ingestionVersion = sha256(adapterVersion, normalizerVersion, targetSelectorHash)` | `packages/contracts/src/climate.ts:74-92`; `provenance-contract.md:150-153` |
| `IngestionRun` is unique on `(forecast_run_id, ingestion_version)`; `attempt` is not in the key | migration `20261118030000_domain_tables:398`; `provenance-contract.md:180` |
| `WeatherRecord`'s live key is `(forecast_run_id, cell_key, variable, valid_at, ensemble_member)` | `tables-climate.md:246` |
| A moved served coordinate under an existing `cellKey` raises `ProviderCoordinateDriftError` → terminal `provider_changed` | `packages/database/src/weather.ts:195-254` |
| `outlook_cells` accepts only `provider IN ('bmkg', 'open-meteo', 'ecmwf')` | migration `20261118030000_domain_tables:326-327` |
| `gridSpecHash` is never persisted: no column, no table, no `SELECT` | searched all `*.sql`, `*.prisma`, non-test `*.ts` |
| Eighteen synthetic golden vectors and five literal hash fixtures pin the above | `grid.test.ts:98-205`, `:207-357`; `registry.test.ts:26` |

### 1.2 What the provider does, as measured (REPORTED, grade B)

From `open-18-open-meteo-ifs025-evidence.md` (`api.open-meteo.com/v1/forecast`,
`models=ecmwf_ifs025`, 2026-11-24). Every row below is **grade B (measured)**: it is what
the endpoint returned, not a provider statement of its grid.

| Property | Result |
|---|---|
| Lattice | global regular `0.25°`; nodes at multiples of `0.25`, including `0`, `±90`, `−180 … 179.75` |
| Construction | regular, not reduced (spacing measured at several latitudes) |
| Endpoint | snaps: identical served coordinate **and** identical value across one cell |
| Selection | nearest node, ties toward `+∞`; 41/41 vs 14/41 for the floor rule |
| Served coordinate | the centre of the selected cell, i.e. a node |
| Provider request parameter `cell_selection` | default `land` is not `nearest`; changed the cell at 7 of 8 probed sites. **Not** the resolver field `GridSpec.cellSelection` — see §6.6 and §9.2 |
| `elevation` | the DEM value at the **requested** point; six values for one served cell; not a cell property |
| `180` vs `−180` | different cells with different values (`179.75` vs `−180`) |
| Request domain | latitude outside `[−90, 90]` and longitude outside `[−180, 180]` return `400` |

**Two identifiers, one word of overlap.** `GridSpec.cellSelection` is the resolver's
ownership rule (`lower-edge` / `nearest-centre`) and is a proposed *spec* field that
participates in `gridSpecHash`. The provider's `cell_selection` is a *request parameter*
(`nearest` / `land` / `sea`) and belongs in the proposed `requestParametersHash` for
workflows that create an `IngestionRun`; a climatology baseline creates none and stores
the same pinned parameters in `climatology_baselines.source_reference` instead (§9.5). The
measured product uses both words; neither identifier may be read as the other, and the
correspondence between their values is a provider-specific claim (§6.6).

### 1.3 Evidence quality

| Finding | Tag | Note |
|---|---|---|
| The 41 published request→served pairs reproduce **41/41** under `floorDiv(2·δ + step, 2·step)` and **14/41** under the floor rule | REPORTED dataset / **VERIFIED arithmetic** | The dataset is not committed; the arithmetic was re-run this session against its published extract and matches the report exactly |
| 172 requests, 164 served coordinates | UNVERIFIED | Only the aggregate and a few tables are in the repository; the raw corpus is outside it |
| "7 of 8 sites changed cell" | REPORTED | The document lists **5** of the 8; the claim cannot be fully reproduced from repository content |
| Lattice step, congruence class, global extent, regular construction | REPORTED | Measured under the §5.2.6 protocol steps 1–4; the origin is established only up to its congruence class — the repository's own rule (§5.2.6) |
| Poles serve `±90` | REPORTED | `89.88 → 90.00`, `−89.88 → −90.00` |
| Antimeridian behaviour | REPORTED / **CONCERN** | Four coordinates; no explanation offered and none adopted here |
| `ecmwf_ifs025` names the documented "IFS 0.25 Open-Data" row | UNVERIFIED (grade C) | The identifier appears on neither documentation page |
| `spatialResolutionKm = 25` | UNVERIFIED (grade C) | The provider says "~25 km"; the field is nominal |

**Consequence.** This ADR can decide the *contract shape* on measured **grade B**
geometry, because the lattice is measured. It cannot make `ecmwf_ifs025` a `validated`
registry entry: the grade A requirement is only partially met (the provider documents
spacing and the global extent, not this product identifier), and the identifier→product
mapping is still **grade C**, so §5.2.6's grade A + B condition is not satisfied. Those
are different gates and this ADR does not merge them.

**This ADR does not upgrade the provider evidence grade.** Geometry remains grade B, the
identifier remains grade C, and no row of the evidence report is reclassified here. A
`validated` registry entry stays blocked independently of D1–D10 and of any approval this
ADR may receive.

### 1.4 Two documentation defects found during validation (CONCERN)

Both are arithmetic contradictions, not new findings. Neither is rewritten in place;
each source document receives a dated erratum pointing here.

1. **Evidence report §5** describes the provider cell as `(n − 0.125, n + 0.125]`. That
   contradicts its own §3.4, where `0.125 → 0.25` and `−0.125 → 0.00`. With ties toward
   `+∞` the cell is `[n − 0.125, n + 0.125)`; the formula is `floorDiv(2·δ + step, 2·step)`.
2. **Proposal §4.5** claims Option B changes vectors 1, 4, 6, 9, 10, 12 and 15 and that
   vector 10's two inputs stop agreeing. Vector 10 is unaffected: longitude is wrapped
   into `[originLon, originLon + 360)` **before** rounding, so `−0.5` becomes `359.5` and
   both inputs still resolve to one cell. Recomputing every vector's inputs puts the
   Option B changes at **1, 4, 6, 8, 9, 12, 13 and 15**.

Neither defect changes a measurement or an option's ranking; both would have propagated
into the contract if left unstated.

---

## 2. Problem statement

**P1 — the partition rule is not an input.** `GridSpec` fixes origin, spacing, ranges,
domain, and orientation, but the rule that decides *which* node owns a coordinate is
hard-coded to the lower edge. A provider whose cell is centred on its node cannot be
configured: the same lattice, read with the wrong ownership rule, mismatched 27 of 41
measured requests, in both directions (one provider cell under two keys; one key over two
provider cells). `UNIQUE (provider, model, cell_key)` detects neither.

**P2 — a provider request parameter changes cell identity invisibly.** The provider
parameter `cell_selection` (`nearest` / `land` / `sea`) moves the served cell for a fixed
`(provider, model, coordinate)` and appears in no forecast identity: not in `GridSpec`,
`gridSpecHash`, `ForecastRun`, `IngestionRun`, or `WeatherRecord`. It is not
`GridSpec.cellSelection`, which is the resolver field of P1 (§6.6). A climatology baseline
is the exception where it *is* recorded, inside `source_reference` (§9.5); the gap is the
forecast/seasonal path, which has no equivalent.

**P3 — the seam rule is implied, not decided.** Reproducing the measured provider
requires a top-of-axis clamp for a nearest-centre grid, and the exact input `180` still
folds to `−180` under the documented wrapping rule. Both are consequences of the
ownership rule, not of the antimeridian alone.

**P4 — evidence is grade B, not grade A.** The lattice is measured; the provider
identifier remains inferred. Configuration of a provider row stays blocked on a
different gate.

---

## 3. Decision drivers

1. **A per-model rule is the existing architecture.** `ADR-001` D8 says a fixed,
   documented rounding rule **per model**; the 2026-11-21 owner decision refuses a
   universal `floor(lat / resolution)`.
2. **Existing keys must stay interpretable.** `cellKey` is `text`; nothing validates its
   content, so a silent redefinition is undetectable downstream.
3. **The hash must pin the reviewed definition.** ADR-007 D2: a hash that omits an input
   that changes cell identity claims two different configurations are one.
4. **No silent overwrite.** A retry with the same effective configuration is idempotent;
   a changed configuration must not look like a retry.
5. **The suite must stay a regression net.** Eighteen vectors encode today's rule; an
   option that invalidates them also destroys the only executable statement of the old
   behaviour.
6. **No invented provider behaviour.** Where measurement is silent (the exact `180`, the
   outer half-cell of a bounded grid), the ADR records alternatives and the measurement
   that would settle them.
7. **Change now is cheap.** No `gridSpecHash` and no resolved cell can exist through a
   code path today (§11), so the cost of a contract change is a one-time review, not a
   data migration.
8. **Conservatism about unrelated open questions.** `spatialResolutionKm` (question 5),
   `|lon| > 180` validation (question 1), `[0, 360)` modelling (question 3), and the
   `lonRange` bound (question 4) stay separate.

---

## 4. Considered alternatives

### 4.1 Option A — a declared selection mode on `GridSpec` (recommended)

`cellSelection: "lower-edge" | "nearest-centre"`, required, hashed, read by
`resolveGridCell` from the spec. `lower-edge` is today's behaviour.

### 4.2 Option B — redefine the node as the cell universally

No new field; the nearest rule replaces the floor rule for every grid.

### 4.3 Option C — shift the anchor lattice by half a step

`originLat = −90.125`, `latRange = [−90.125, 89.875]`. **Rejected:** `defineGridSpec`
refuses a `latRange` outside `[−90, 90]` (`grid.ts:279-281`); relaxing it would put the
grid outside the geographic domain, and `±90` would stop being nodes, so the measured
pole rows could not be expressed. It also re-anchors every grid, including ones that are
correct today.

### 4.4 Option D — pre-round in the adapter

**Rejected:** it moves identity computation out of the resolver, which §5.2.1 exists to
prevent; the adapter and the resolver would then hold two implementations of one rule,
and a `cellKey` would no longer be reproducible from `(spec, coordinate)`.

### 4.5 Option E — do nothing

**Rejected as a permanent answer:** a nearest-centre product can then never be
configured, and P2 stays open. It remains the correct answer *until* an owner decides,
which is why `OPEN-18` is not closed by this ADR.

### 4.6 A versus B (VERIFIED counts)

| Dimension | A — declared mode | B — universal nearest |
|---|---|---|
| Backward compatibility (keys) | `lower-edge` keys unchanged | every key's meaning changes |
| Backward compatibility (vectors) | **0 of 18** vectors change | **8 of 18** change: 1, 4, 6, 8, 9, 12, 13, 15 |
| Hash impact | one field added; five literals regenerated once | every hash changes anyway: `rowCount` becomes nodes, e.g. a `1°` global latitude axis 180 → 181 |
| Resolver versioning | bump recommended, not forced by an existing mapping | bump mandatory |
| Provider-specific semantics | per `(provider, model)`, as the architecture says | one universal rule |
| Persisted records | none affected; no key re-interpreted | none today; a key minted before cannot be distinguished after |
| Ingestion idempotency | unchanged; P2 handled separately | unchanged; P2 still open |
| Uniqueness constraints | unchanged | unchanged, and still unable to detect a wrong key |
| Testability | old rule stays testable | the old rule stops existing, so it cannot be a regression net |
| Future provider extensibility | a genuinely lower-edge provider stays expressible | it becomes unrepresentable; the remedy is another redefinition |
| Migration/operational cost | none | none in schema; a silent re-keying event |
| Reversibility | removing the field later is a breaking type change, but old specs stay interpretable | reverting re-interprets every key a second time |

**Recommendation: A**, because drivers 1, 2, 4 and 5 all point the same way and B's only
advantage — one rule instead of two — removes a capability that no evidence shows is
unnecessary, in exchange for invalidating 8 vectors and every hash. B remains a
defensible choice for an owner who wants uniformity; this ADR does not decide it.

---

## 5. Decision (proposed)

All items are recommendations. "Status" is the decision's state, not its priority.

| # | Decision | Status |
|---|---|---|
| **D1** | `GridSpecInput` and `GridSpec` gain a **required** `cellSelection: "lower-edge" \| "nearest-centre"`, stored on the spec (not on the registry entry, not in the request). An unknown value raises a typed `GridConfigurationError` (`unsupported_cell_selection`). | Recommended |
| **D2** | `nearest-centre`: `index = floorDiv(2·δ + step, 2·step)`; the cell owns `[node − step/2, node + step/2)`; ties resolve to the higher node. `lower-edge` is unchanged. | Recommended |
| **D3** | In `nearest-centre` mode, `latRange`/`lonRange` name the **node** range and `rowCount`/`colCount` count indexable rows/columns (nodes). A bounded nearest-centre span gains one (`span/step + 1`). On a `global` domain, an index equal to `colCount` clamps to `colCount − 1`. Request validation stays on the node range. | Recommended |
| **D4** | `cellSelection` participates in `gridSpecHash` **unconditionally**; the five literal fixtures are regenerated once, in the same commit as the preimage change. | Recommended |
| **D5** | `GRID_RESOLUTION_ALGORITHM_VERSION` becomes `"grid-resolve/2"`. | Recommended (a strict `/1` reading is defensible; see §8) |
| **D6** | `SpatialResolution` gains `cellSelection`, so a result says whether its anchor is a corner or a centre. | Recommended; low risk, may be deferred |
| **D7** | **Workflows that create an `IngestionRun` only.** Ingest identity gains a `requestParametersHash` inside `ingestionVersion`; every such adapter must pin the provider's `cell_selection=nearest` explicitly and refuse `land`/`sea` on a nearest-centre spec. A climatology baseline creates no `IngestionRun` and keeps its existing `source_reference` identity unchanged (§9.5); D7 adds no hash and no migration there. | Recommended; separate task (§9) |
| **D8** | The exact input `180` keeps the documented fold to the `originLon` column. The measured provider divergence is documented, not encoded in the resolver. | Recommended; owner may prefer an exception |
| **D9** | `spatialResolutionKm` stays in the preimage; its own question is not bundled with this ADR. | Unchanged |
| **D10** | Changing the selection mode on an existing `(provider, model)` requires a new `model` string, like any configuration change that alters identity. | Recommended |

**Two fields, deliberately separate.** `GridSpec.cellSelection` (D1) is the resolver's
ownership rule and lives inside `GridSpec` and its `gridSpecHash`. The Open-Meteo request
parameter `cell_selection` (D7) is a provider fetch option and lives inside
`requestParametersHash` **only where an `IngestionRun` exists**; a climatology baseline
stores the pinned parameters in `source_reference` (§9.5). D1 and D7 look alike and are
not exchangeable; §6.6 states the mapping and its provider-specific limit.

If accepted, this is a **breaking contract change**: `CONTRACTS_VERSION` and the package
version move (`0.2.0 → 0.3.0`). It is not implemented by this document.

---

## 6. Detailed contract semantics (proposed)

### 6.1 The field

```ts
export interface GridSpecInput {
  // …
  readonly cellSelection: string; // validated, like `orientation`
}
export interface GridSpec {
  // …
  readonly cellSelection: CellSelection;
}
export type CellSelection = "lower-edge" | "nearest-centre";
```

- It is **required**. A default would be worse than the field: a spec that silently means
  `lower-edge` is exactly what today's untyped `orientation: string` avoided by being an
  explicit input, and an implicit default is a value a reader must know to interpret a
  hash.
- It belongs on the **spec**, because `resolveGridCell(spec, request)` is public and takes
  only those two arguments. On `GridRegistryEntry` the resolver could not see it without a
  second call path; in the request a caller could re-read one stored cell two ways.
- It is **not** provider-wide. `ADR-001` D8 and the 2026-11-21 owner decision make the
  rule per model; two models of one provider may differ.

### 6.2 Resolver

```ts
// lower-edge (current behaviour, unchanged)
i = floorDiv(latµ - originLatµ, stepLatµ)

// nearest-centre
i = floorDiv(2 * (latµ - originLatµ) + stepLatµ, 2 * stepLatµ)
```

The doubled form avoids a half-step micro-degree, which is not representable for every
legal step (`0.25°` = `250000µ°` halves cleanly; `1µ°` does not). Solving
`floor((2δ + step) / (2·step)) = 0` gives `−step/2 ≤ δ < step/2`, i.e. the cell owns
`[node − step/2, node + step/2)`: the lower midpoint belongs to this node, the upper
midpoint to the next. `Math.round` must not be used — it rounds halves by numeric value,
which is the wrong rule for negative deltas.

Worked check on a `0.25°` lattice at node `0` (VERIFIED by evaluating `floorDiv`):

| Input | Index | Node | Why |
|---|---|---|---|
| `0.124999` | `0` | `0.00` | below the upper midpoint |
| `0.125000` | `1` | `0.25` | upper midpoint belongs to the next node |
| `−0.125000` | `0` | `0.00` | lower midpoint belongs to this node |
| `−0.125001` | `−1` | `−0.25` | below the lower midpoint |

### 6.3 Bounds and counts

- `latRange` keeps its `lower-edge` meaning (cell range, upper bound exclusive) and gains
  a second, declared meaning under `nearest-centre` (node range, both bounds centres).
  Two meanings in one field is a cost; the alternative was a second field, which would
  duplicate a range and create two ways to describe one grid.
- `rowCount`/`colCount` count **indexable** rows and columns: cells under `lower-edge`,
  nodes under `nearest-centre`. A bounded nearest-centre span is therefore `span/step + 1`.
  A `global` longitude domain stays `360/step` — its node set is `originLon … originLon +
  360 − step`.
- `±90` remain legal: they are nodes, and `rowCount` for a `0.25°` latitude axis over
  `[−90, 90]` is 721. For the measured IFS lattice this yields `rowCount = 721`,
  `colCount = 1440`, which is exactly the node set observed.
- Request validation is unchanged: latitude inside `[−90, 90]` **and** inside `latRange`;
  longitude inside the domain. On a bounded nearest-centre grid this rejects the outer
  half-cell beyond the first/last node even though that half-cell belongs to the node
  (see §12.6).

### 6.4 Key and precision

`cellKey` format does not change. What changes is what a node **means**: a corner under
`lower-edge`, a centre under `nearest-centre`. `decimals` still covers the origin and the
step, so a fractional origin stays exact. The anchor is still derived from the indices,
never from the request.

For a nearest-centre grid the key equals the provider's served coordinate, so
`outlook_cells.cell_key` and `served_lat`/`served_lon` agree instead of naming a corner
and a centre of the same cell.

### 6.5 Compatibility of the field with existing call sites

Ten call sites construct a spec: `synthetic.ts:26`; `grid.ts:346` (`assertGridSpecIntegrity`)
and `grid.ts:549` (`createGridRegistry`); six in `grid.test.ts` (`:36`, `:167`, `:181`,
`:202`, `:203`, `:363`); one in `registry.test.ts:47`. Making the field required is a
compile-time break, deliberately: no spec can acquire a silent default.

### 6.6 `GridSpec.cellSelection` versus the provider's `cell_selection`

Two identifiers, two layers, one shared word. Reading one as the other is the defect this
subsection exists to prevent.

| | `GridSpec.cellSelection` | Provider request `cell_selection` |
|---|---|---|
| Layer | resolver contract | provider fetch option |
| Values | `"lower-edge"` \| `"nearest-centre"` | `nearest` \| `land` \| `sea` (Open-Meteo) |
| Answers | which node owns a coordinate | which selection rule the endpoint applies |
| Lives in | `GridSpec`, therefore `gridSpecHash` (§7) | `requestParametersHash` inside `ingestionVersion` when the workflow opens an `IngestionRun` (§9.3); `climatology_baselines.source_reference` when it does not (§9.5) |
| Scope | one `(provider, model)` binding, per `ADR-001` D8 | one logical ingest of one run (forecast/seasonal); one immutable baseline version (climatology) |
| Changes when | the reviewed lattice definition changes | the fetch configuration changes |
| Absent today | the field does not exist; `lower-edge` is implicit | no forecast/seasonal adapter sends it, so the provider default applies; the archive adapter pins `cell_selection=nearest` and records it in `source_reference` (`open-meteo-archive.ts:149`, `:163-171`); only the baseline path stores the value, and only inside that string |

**The mapping is a provider-specific contract, not a translation table.** For the
measured Open-Meteo product, resolver mode `nearest-centre` is expected to correspond to
request value `nearest`: the evidence report measured 41/41 request→served pairs under
that combination. "Expected" is the strongest claim this ADR can make, and the
correspondence is **not verified at the contract level** — no test, fixture, or committed
run establishes it, because no nearest-centre spec exists yet. The adapter must therefore
send `cell_selection=nearest` explicitly and validate the pairing for each `(provider,
model)` before the first ingest; a future provider whose `nearest` means something else
must not inherit this row.

**One provider, two products, two bindings.** The archive adapter's pinned
`cell_selection=nearest` is a request-time choice for `open-meteo/era5` on the archive
endpoint (`open-meteo-archive.ts:149`). It says nothing about `open-meteo/ecmwf_ifs025` on
the forecast endpoint: ERA5 reanalysis and IFS 0.25 are separate `(provider, model)`
bindings, made by different endpoints, each with its own evidence grade. The existence of
a pinned `nearest` in the archive adapter is therefore **not** evidence that a production
`ecmwf_ifs025` registry entry is valid, and `nearest` on one product does not transfer to
the other. §9.5 states what the archive path actually proves.

**`land` and `sea` are not representable.** They select by a 90 m DEM search the resolver
cannot model, so a nearest-centre `GridSpec` cannot stand in for them. Approximating
either would change values without changing identity (§9.3). No generic rule assigns them
to `nearest-centre`, and no other provider gets a mapping here without its own grade A and
grade B evidence.

---

## 7. Grid identity and hashing

`GridSpec.cellSelection` belongs **inside `GridSpec` and therefore inside
`gridSpecHash`**. It is a property of the reviewed lattice definition, not of a request —
the provider's request parameter `cell_selection` is the opposite case and is excluded
here by §9.2.

- **Include `cellSelection` unconditionally.** Two configurations that differ only by mode
  produce different keys for the same coordinate; a hash that omitted the field would
  claim they are one configuration.
- **Canonical representation:** the literal string values `"lower-edge"` /
  `"nearest-centre"` in the flat preimage object, serialised by the existing
  `canonicalJson`. No version string, no boolean, no integer encoding: a boolean would
  have to be re-interpreted the first time a third mode appears.
- **Cost:** five literal fixtures change once — four in `grid.test.ts:126-131`, one in
  `registry.test.ts:26`. The fixture comment already prescribes exactly this
  (`grid.test.ts:100-124`). No `gridSpecHash` is persisted, so no stored value is
  invalidated.
- **Rejected: omit the field when `lower-edge`.** It leaves the fixtures untouched, but a
  required field would then be conditionally absent from its own preimage, and hash
  equality would depend on knowing the default. That is not the same as `lonRange`'s
  conditional presence, which is structural (a `global` grid has no range), not a
  defaulted value.
- `rowCount`/`colCount` are already hashed, so the node counts of a nearest-centre spec
  are pinned without a second mechanism.
- **A mode change on existing keys requires a new `model` string** (D10): the hash pins
  the configuration, and the `(provider, model)` binding is what selects it.

---

## 8. Resolver versioning

**Recommended: `"grid-resolve/2"`.** The constant is global, not per spec, and a stored
`/1` result must read as "produced by a codebase with no centre mode". Strictly, no
`grid-resolve/1` spec changes behaviour — the new branch is unreachable without the new
field — so an owner may keep `/1` on the reading "the version names the set of rules that
can change a mapping, and no existing mapping changed". If `/1` is kept, that reading
must be written down, because the constant's own comment (`grid.ts:595-605`) says to bump
when a change can move a request to a different cell.

**Coexistence.** Both modes coexist inside one version *if* the version is bumped: a
resolution carries `gridSpecHash`, and the spec it names carries `cellSelection`. If the
version stays `/1`, a `/1` resolution no longer identifies one rule set.

**Re-keying.** None, and none is possible today: no cell row can exist (§11), no
`gridSpecHash` is stored, and `SpatialResolution` is built at two call sites
(`apps/api/src/climate/climate.service.ts:73`, `apps/api/src/field/field.service.ts:165`)
and persisted nowhere.

**Not in the hash, not in `ingestionVersion`.** The version describes the algorithm; the
hash describes a configuration; `ingestionVersion` describes one logical ingest.

---

## 9. Ingestion identity

### 9.1 The layers (VERIFIED)

Two workflows reach a provider. Only one of them has an `IngestionRun`; the identity layers
below say which mechanism covers which.

| Layer | Identifies | Where | Changes when | Applies to |
|---|---|---|---|---|
| Configuration | one reviewed lattice + resolver selection rule (`cellSelection`) | `gridSpecHash` | any preimage field changes | both |
| Algorithm | the mapping rule set | `GRID_RESOLUTION_ALGORITHM_VERSION` | index arithmetic, domain, wrapping, anchor derivation, or key format changes | both |
| Provider binding | which product a configuration describes | registry `(provider, model)` | the product or grid changes | both |
| Request configuration | provider parameters that change what a request returns, including the provider's `cell_selection` | **new** `requestParametersHash`, inside `ingestionVersion` | such a parameter changes | forecast/seasonal (`IngestionRun`) |
| Ingestion | one logical ingest of one run | `ingestionVersion` | any component changes | forecast/seasonal (`IngestionRun`) |
| Baseline source | one immutable baseline's dataset, provider/model, route reference, period and algorithm revision | `climatology_baselines` columns, including `source_reference` | any of those differs under the same `baseline_version` → conflict, not an update | climatology (no `IngestionRun`) |
| Record | one value at one cell/variable/instant/member | `(forecastRunId, cellKey, variable, validAt, ensembleMember)` | a re-normalisation supersedes; never duplicates | forecast/seasonal |
| Baseline normal | one monthly normal for one cell in one version | `(baseline_version, outlook_cell_id, month)` | never overwritten; a change needs a new `baseline_version` | climatology |

### 9.2 Where the provider request parameter `cell_selection` does **not** belong

This table is about the **provider request parameter** — `nearest` / `land` / `sea` — not
about `GridSpec.cellSelection`, which is the resolver field and *is* hashed (§7). The two
are mapped in §6.6. It answers for both workflows: the parameter never goes into a lattice
identity. Only the *storage* differs — `requestParametersHash` where an `IngestionRun`
exists, `climatology_baselines.source_reference` where none does (§9.5).

| Location | Verdict | Reason |
|---|---|---|
| `GridSpec` / `gridSpecHash` | No — for the request flag | It is not a lattice property. It must not be folded into the spec: two grids whose cells agree would hash differently for a request-only reason. `GridSpec.cellSelection` is the reverse case — a spec field that belongs in the hash |
| `ForecastRun` natural key | No | it identifies the provider's model output; the flag does not change the output |
| `targetSelectorHash` | No | it names the requested `(cellKey, variable)` set; folding a fetch parameter in makes the selector unreproducible from the selector rows |
| `WeatherRecord` key | No | a new component duplicates every value when the flag changes; the row already stores `ingestion_run_id`, requested/served coordinates |
| `outlook_cells` column | No | a cell's meaning is pinned by its model binding; a per-row flag would either sit outside the unique key (re-labelling in place) or duplicate the binding |
| `ingestionVersion` for a climatology job | No — and it does not exist | the handler opens no `IngestionRun` (`apps/worker/src/ingest/climatology.ts:218`) and settlement refuses one (`:344-348`); inventing a run to carry a hash would fabricate an ingestion that never happened |
| A second hash column beside `climatology_baselines.source_reference` | No | the pinned parameters are already inside that string (`open-meteo-archive.ts:163-171`), and the version row compares it as identity (`packages/database/src/climatology.ts:325-333`). A second value would be a duplicate with no second reader |
| `adapterVersion` string | No (rejected) | one column would then carry two meanings — a code change and a configuration change — with no canonical form |

### 9.3 Recommended mechanism — workflows that create an `IngestionRun`

Scope: forecast and seasonal ingestion, i.e. the handlers whose `opensIngestionRun` is
true. Climatology is out of scope and has its own mechanism (§9.5); this subsection does
not propose a hash for it.

- **`requestParametersHash`**: canonical JSON of the *effective* request parameters with
  defaults resolved — endpoint, `models`, `cell_selection`, `elevation` presence/value,
  `timezone`, `forecast_days`, and any future parameter that can change the served cell or
  the value. Variables are excluded; they are in `targetSelectorHash`.
- **Inside `ingestionVersion`**, which becomes `sha256(adapterVersion, normalizerVersion,
  targetSelectorHash, requestParametersHash)`.
- **Stored** on `app.ingestion_runs` beside `target_selector_hash`, with
  `^[0-9a-f]{64}$`. That is a migration and a contract change: a separate task (§11), and
  it must not be bundled with the resolver change.
- **Adapter obligation:** send an explicit provider `cell_selection`, never rely on the
  provider default; on a `nearest-centre` spec send `nearest` and refuse any other value.
  The pairing `nearest-centre ↔ nearest` is expected for the measured Open-Meteo product
  and remains a **provider-specific contract to validate per `(provider, model)`** (§6.6);
  it is not a generic rule. `land` and `sea` cannot be modelled by a nearest-centre spec
  and must be refused rather than approximated.

### 9.4 Idempotency and supersession after the change (forecast/seasonal)

If `requestParametersHash` enters `ingestionVersion`, these are the expected effects for a
workflow that opens an `IngestionRun`. Nothing here changes a climatology baseline, which
is append-only by `baseline_version` and never supersedes a row (§9.5).

| Event | Expected effect |
|---|---|
| Retry, same effective parameters | same hash → same `ingestionVersion` → same `IngestionRun`; `attempt` increments; no new rows |
| Adapter code change | new `adapterVersion` → new `IngestionRun`; records supersede |
| Provider `cell_selection` changed on an existing binding | new `requestParametersHash` → new ingest; **and** the drift guard refuses a moved served coordinate for every already-served key → terminal `provider_changed`. The two signals together say "configuration changed", not "the provider re-gridded" |
| Provider re-grids | served coordinate moves under the same key → drift guard → `provider_changed`; continuing needs a new `model` string |
| `elevation` override added | new hash → new ingest. Precipitation was measured unaffected; temperature is downscaled and would not be — never assume variables are inert |

**CONCERN.** `ingestionVersion` alone cannot prevent supersession, because
`WeatherRecord`'s live key does not include the ingestion. The drift guard
(`weather.ts:248-254`) is the mechanism that does; a cell whose `served_*` is still `NULL`
holds no values, so nothing is overwritten there, but a user who resolved it under the old
flag was shown a mapping the later ingest does not honour. That is a resolution-history
inconsistency, not data loss. Removing the guard, or writing records before resolving
cells, would reopen the hole.

### 9.5 Climatology baselines: `source_reference`, not `ingestionVersion` (VERIFIED)

A climatology build is a **baseline**, not a forecast. The handler declares
`opensIngestionRun: false` (`apps/worker/src/ingest/climatology.ts:218`), and settlement
refuses any job that carries an `ingestion_run_id` (`:344-348`). There is therefore no
`IngestionRun` for `requestParametersHash` to enter, and D7 proposes nothing for this
path: **no hash change, no schema change, no migration, no duplicate identity column.**

**The existing mechanism, read from the code** (`db` = `packages/database/src/climatology.ts`,
`worker` = `apps/worker/src/ingest/climatology.ts`):

| Step | Where | What it pins |
|---|---|---|
| The adapter pins the parameters | `open-meteo-archive.ts:142-150` | `daily`, `models=era5`, `precipitation_unit=mm`, `cell_selection=nearest`, `timezone=UTC` on every request |
| A coordinate-free reference is built from the same parameters | `open-meteo-archive.ts:163-171` | the route plus the pinned parameters, without coordinates or dates |
| The payload carries it per cell | `open-meteo-archive.ts:313` | `sourceReference` alongside `requested*`/`served*` |
| The handler takes one reference for the version | `worker:294-296` | every cell comes from the same pinned route, so one string describes the version |
| Persistence writes the version row once | `db:281-300` | insert, `ON CONFLICT (baseline_version) DO NOTHING` |
| Then it compares identity under a row lock | `db:304-333` | `baseline_dataset`, `provider`, `model`, `source_reference`, `period_from`, `period_to`, `algorithm_version` |
| A mismatch is terminal | `db:107-117`; caught at `worker:409-411` | `ClimatologySourceConflictError` → `baseline_source_conflict` |

So a changed `cell_selection`, model, unit, timezone or route under an existing
`baseline_version` already fails loudly. The value is inside `source_reference`, which is
compared as identity — the requirement D7 satisfies for forecasts is already satisfied
here by a different, narrower field. That is why this ADR adds nothing to it.

**Deliberately not identity.** `adapter_version` and `attribution` are stored and compared
nowhere (`db:265-271`): a patch release that changes neither the source nor a value must
not force a version bump. That is the same principle as D7's exclusion of variables,
applied to a different row.

**Baseline limits, recorded as concerns, not redesigned here:**

1. **Two parallel URL builders.** `buildArchiveDailyUrl` (`open-meteo-archive.ts:139-152`)
   and `buildArchiveSourceReference` (`:163-171`) list the parameters independently, and no
   test asserts the two parameter sets agree. A parameter added to the request but not to
   the reference would be invisible to baseline identity — and to
   `ClimatologySourceConflictError`. This is a real coupling risk, not a defect in current
   behaviour: today the two sets differ only by coordinates and dates.
2. **One reference per version.** `source_reference` is a single string on the version row,
   so a baseline assembled from two different routes cannot be expressed. The handler
   assumes one pinned route (`worker:294-296`); that assumption is documented, not
   enforced.
3. **Comparison happens only on re-presentation.** Identity is checked when the *same*
   `baseline_version` is built again. A differing source that also ships a new
   `baseline_version` is a new version by design and is never compared with the old one —
   the version-bump rule, not a gap.
4. **The gate is still `validated`.** The handler resolves cells through
   `registry.requireValidated` (`worker:240-243`), and the shipped registry has no
   `open-meteo/era5` entry, so a production baseline job terminates `grid_not_validated`
   today. A pinned `nearest` in the archive adapter does not change that.

**ERA5 is not `ecmwf_ifs025`.** The archive adapter's `nearest` is evidence for one
binding — `open-meteo/era5` on `archive-api.open-meteo.com`, reanalysis, daily
precipitation — and for nothing else. It does not validate `open-meteo/ecmwf_ifs025`, does
not satisfy §5.2.6's grade A + B for the forecast product, and does not promote any
registry row. Each `(provider, model)` still carries its own evidence, and §9.5 does not
merge the two archive and forecast contracts (§6.6).

---

## 10. Backward compatibility

| Artifact | Effect under the recommended decision set |
|---|---|
| `cellKey` format | unchanged |
| Existing specifications | gain `cellSelection: "lower-edge"`, which is their current behaviour |
| Golden vectors 1–18 | unchanged and still valid |
| Five literal hashes | change once, in the preimage commit |
| Resolved cells | not persisted; nothing to reinterpret |
| `gridSpecHash` values | none stored anywhere |
| `GRID_RESOLUTION_ALGORITHM_VERSION` | bumps to `/2` (or stays `/1` under §8's strict reading) |
| `SpatialResolution` | gains one field; additive |
| `CONTRACTS_VERSION` | `0.2.0 → 0.3.0` (a required field is a breaking type change) |

Nothing historical is re-interpreted. That is the property Option B cannot offer.

---

## 11. Migration implications

- **Schema: none for the resolver change.** No column stores a grid or a resolution.
- **Data: none.** No cell row can exist through a code path today (VERIFIED by reading
  code and schema, **not** by querying a database — no live database was inspected):
  the registry holds only provider `synthetic`, `outlook_cells_provider_check` accepts
  only `bmkg | open-meteo | ecmwf`, and the only writers (`upsertCell`, reached from
  `field.service.resolveCell` and the ingest paths) go through the registry. The field
  route is consequently unsatisfiable in production today — it can only resolve the
  synthetic pair, whose insert the `CHECK` rejects. That is a pre-existing gap, not one
  this ADR creates.
- **If an environment does hold rows**, they were inserted outside these paths. Their keys
  are still lattice nodes and still resolvable, but their meaning is only "lower-edge" if
  a `lower-edge` spec minted them; the key alone cannot say. Inventory any such
  environment before rollout.
- **Grants, RLS, tenant isolation: untouched.** No new table, no new column, no policy.
- **`requestParametersHash` (§9.3) does require a migration** — one column, one `CHECK`,
  and a rewritten `ingestionVersion` preimage. It is scheduled after the resolver
  decision, not with it. **Forecast/seasonal only:** the climatology path opens no
  `IngestionRun`, and its pinned parameters are already inside
  `climatology_baselines.source_reference` (§9.5), so it needs no column and no migration.

---

## 12. Antimeridian and polar boundary policy

### 12.1 Measured (REPORTED)

| Request | Served | Value |
|---|---|---|
| `0.0, 179.99` | `0.0, 179.75` | 3.9 |
| `0.0, 180.0` | `0.0, 179.75` | 3.9 |
| `0.0, −180.0` | `0.0, −180.0` | 6.9 |
| `0.0, −179.99` | `0.0, −180.0` | 6.9 |

### 12.2 The generic rules that stay

`climate-data-foundation.md` §5.2.9.3 documents, and `grid.ts:396-410` implements:
longitude wraps only on a `global` domain, only around the grid's own origin; `180` and
`−180` are one meridian and fold onto one cell; latitude never wraps; a bounded upper
bound is exclusive. This ADR does not reopen those rules.

### 12.3 What the mode forces

On a `global` nearest-centre grid, an input in the top half-step of the window
(`originLon + 360 − step/2 … originLon + 360`) rounds to index `colCount`, which is not a
node. The measurement at `179.99` is consistent only with **clamping** to
`colCount − 1`; wrapping the index to the first node would answer `−180`, which the
provider does not do for that input.

**A hypothesis that explains all four points (CONCERN — not adopted as fact):** the
provider applies no longitude normalization and selects the nearest existing node on
`−180 … 179.75`, clamping to that finite set. It predicts `179.90 → 179.75` and
`179.875 → 179.75`, and it explains `180 → 179.75` without an exception. It is
consistent with the four measurements; it is not a documented provider rule and must not
be written down as one.

### 12.4 The exact input `180`

Keeping the fold means the resolver answers `−180` while the provider answers `179.75`.
Adopting an exception means the generic contract gains a special case, and the two
representations of one meridian resolve to two adjacent cells.

**Recommended: keep the fold** (D8). Reasons: the fold is an approved, documented
statement about coordinate equivalence; changing it would affect every global grid; the
divergence is one coordinate out of the domain and cannot arise from a field centroid in
the product's operating area; and both answers name cells the provider actually serves, so
storage stays honest (`179.75` and `−180` are distinct keys, no collision).

### 12.5 Polar behaviour

- Nodes exist at `±90` (REPORTED, twice measured) and a nearest-centre latitude range
  `[−90, 90]` has 721 nodes. `89.88 → 90.00` is the same rule as any interior midpoint.
- Request `90.0` is legal and maps to the last node; `90.01` stays `out_of_grid` under the
  existing `[−90, 90]` bound. No clamp is needed on latitude, because its extremes are
  nodes and the geographic domain ends there.
- The outer half-cell problem therefore exists only on a **bounded regional** grid, not at
  the poles (§12.6).

### 12.6 The outer half-cell on a bounded nearest-centre grid

With `latRange = [10.5, 12.5]` at `0.25°`, a request at `12.6` is inside node `12.5`'s
cell but outside the declared node range. **Recommended: reject** (`out_of_grid`). It
keeps one meaning for `latRange`, adds no second validation window, and no measured
provider needs the outer half-cell. **CONCERN:** the alternative — validating against the
cell extent `[latMin − step/2, latMax + step/2)` — is more faithful to the partition and
is what a future regional provider may require. It must not be added silently; it is
recorded as the bounded outer half-cell row in §16.1.

### 12.7 Measurements that would settle the open parts

| Measurement | Settles |
|---|---|
| `0.0, 179.90` | whether the clamp is a region rule or an epsilon around `180` (the two remaining explanations of `179.99`) |
| `0.0, 179.875` and `0.0, 179.8749` | the boundary of the last cell, i.e. that the clamp starts at the half-step, not at `179.8751` |
| `0.0, 180.01` | confirms the input domain is closed at `180` (no normalization beyond it) |
| `0.0, 179.75` | confirms the last node itself is served by a request on it |
| `-0.0, -179.875` | the tie at the lower seam, if the tie rule is to be pinned there too |

None is a network test to be committed; each is a recorded measurement for the evidence
report.

---

## 13. Golden vector requirements

Existing vectors 1–18 stay **byte for byte**. New vectors are additive and must not be
added before their decision exists.

| # | Grid | Input | Expected | Proves |
|---|---|---|---|---|
| 19 | `0,0` / `0.25,0.25` / global, nearest | `0.13, 0.13` | `0.25,0.25` | interior rounds to the nearest centre |
| 20 | same | `0.12, 0.12` | `0.00,0.00` | the same lattice, the other side of the midpoint |
| 21 | same | `0.125, 0.125` | `0.25,0.25` | upper midpoint belongs to the next node |
| 22 | same | `−0.125, −0.125` | `0.00,0.00` | lower midpoint belongs to this node |
| 23 | same | `−6.21, 106.79` | `−6.25,106.75` | negative coordinates, floor on a negative index |
| 24 | `−90,−180` / `0.25,0.25` / global, nearest | `89.88, 179.99` | `90.00,179.75` | pole node **and** the top-of-window clamp |
| 25 | same | `−89.88, −179.99` | `−90.00,−180.00` | the opposite pole and the low end |
| 26 | bounded `[10.5,12.5]²` / `0.25,0.25`, nearest | `12.6, 10.6` | `out_of_grid` | the outer half-cell is refused, not clamped |
| 27 | origin `0.123456` / `0.25,0.25` / bounded, nearest | `0.2, 0.2` | `0.123456,0.123456` | precision: the node is exact, not the request |
| 28 | vector 19's lattice, `lower-edge` | `0.13, 0.13` | `0.00,0.00` | the field is load-bearing: same lattice, adjacent nodes |
| 29 | `0,0` / `0.25,0.25` / global, nearest | `0.0, 180.0` | **not pinned** | depends on the exact-`180` row in §16.1; today's fold answers `0.00,−180.00` |

Also required:

- a literal `gridSpecHash` fixture for a nearest-centre spec, so removing the field from
  the preimage fails a test;
- a test that two specs differing only by mode hash differently;
- a typed rejection for an unknown `cellSelection` string;
- the **41 measured request→served pairs** as a committed extract, asserted against a
  nearest-centre synthetic spec (provider string `synthetic`), reproducing 41/41 where the
  floor rule gives 14/41. It is a recorded measurement, cited to the evidence report, not a
  network test. None of the 41 is within `179°` of the antimeridian, so it does not
  pre-judge §12.

No vector pins `179.90` as an expectation: it is a measurement to obtain, not a decision.

---

## 14. Security and data integrity implications

- **Identity confusion is the threat.** If a cell key names a different physical cell than
  the values it holds, every downstream join, aggregation, and provenance claim is wrong
  while looking consistent. The measured failure mode (27 of 41 requests) is exactly that;
  neither `UNIQUE (provider, model, cell_key)` nor `text` catches it.
- **Mitigations that must survive the change:** the served-coordinate drift guard stays
  terminal (`provider_changed`); resolution still stops before the provider is called, so
  `field_outlook_cells` is never written with a fabricated `distance_km`; the evidence
  state stays declared, never inferred; `requireValidated` still guards ingest paths.
- **The adapter must refuse `land`/`sea`** on a nearest-centre spec rather than approximate
  them: those modes select by a 90 m DEM, which a lattice resolver cannot model. Silently
  substituting `nearest` would change the values without changing the identity.
- **No new trust boundary.** No authentication, authorization, tenant, or RLS change; no
  secret, credential, or PII is introduced. The resolver remains a pure function of
  `(spec, coordinate)` and never touches I/O.
- **Validation must not be weakened.** `latRange ⊆ [−90, 90]` stays; lattice-point bounds
  stay; `cellKey` stays a canonical decimal pair. The nearest mode does **not** need a
  bound relaxation — the earlier "unrepresentable" framing held only while the v1
  ownership rule was fixed.

---

## 15. Consequences and trade-offs

**Positive.** A provider whose cell is centred on its node becomes expressible without
redefining any existing key. The old rule stays executable as a regression net. The
selection rule becomes a reviewed, hashed input instead of ambient code behaviour. Cell
identity and provider request configuration become separable, which is what makes the
`requestParametersHash` decision expressible at all.

**Negative.** Every `defineGridSpec` call site changes at compile time; `contracts` takes a
breaking bump; five literal hashes are regenerated once. `latRange` carries two meanings
depending on mode — a documented cost, not a hidden one. Two rules must be maintained and
tested instead of one. A future provider that wants a third rule (e.g. `sea`-aware
selection) is still unrepresentable, and this ADR does not pretend otherwise.

**Neutral.** `rowCount`/`colCount` change for nearest-centre specs only; because both are
hashed, the counts cannot drift from the mode. No data migration exists because no
identity is stored.

---

## 16. Unresolved questions

### 16.1 Owner decision register

D1–D10 (§5) are the ADR's proposed decisions. The register below is the same set as
owner-facing items, plus the questions this validation could not decide.

| Decision | Recommendation | Evidence | Status | Owner approval required |
|---|---|---|---|---|
| Selection semantics declared on `GridSpec` (D1) | `lower-edge` \| `nearest-centre`, required, validated | `ADR-001` D8; 2026-11-21 owner decision; measured 41/41 vs 14/41 | Recommended | **Yes** |
| Is there an implicit default? | No — required field; no silent `lower-edge` | the hash must pin the reviewed definition (ADR-007 D2) | Recommended | **Yes** |
| Existing specs' behaviour | `cellSelection: "lower-edge"`, behaviour unchanged | `grid.test.ts:207-357` unchanged | Recommended | **Yes** |
| Per-model or per-provider scope | Per `(provider, model)` binding, stored on the spec | `ADR-001` D8; `OPEN-18` 2026-11-21 | Recommended | **Yes** |
| Hash preimage (D4) | Include unconditionally; regenerate 5 literals once | `grid.ts:186-218`; `grid.test.ts:100-130`; no stored hash | Recommended | **Yes** |
| Resolver version (D5) | `grid-resolve/2` | `grid.ts:595-608`; no persisted resolution | Recommended | **Yes** |
| `SpatialResolution` field (D6) | Add `cellSelection` | `grid.ts:618-636`; result is not persisted | Recommended | **Yes** (may defer) |
| Provider `cell_selection` in ingest identity (D7) — forecast/seasonal only | `requestParametersHash` inside `ingestionVersion`, stored on `ingestion_runs`; adapter pins `nearest`; `land`/`sea` refused | `climate.ts:74-92`; `provenance-contract.md:150-190`; 7/8 sites (REPORTED) | Recommended | **Yes** |
| Climatology baseline identity | **No change.** Keep `source_reference` + `ClimatologySourceConflictError`; D7 adds no hash and no migration here | `packages/database/src/climatology.ts:281-333`; `apps/worker/src/ingest/climatology.ts:218,344-348`; `packages/weather-core/src/adapters/open-meteo-archive.ts:163-171` | No change proposed | No |
| Idempotency sufficiency of D7 | Sufficient **with** the drift guard; the guard is the backstop, not optional | `weather.ts:195-254`; `tables-climate.md:246` | Recommended | **Yes** |
| Top-of-window clamp (D3) | Clamp `colCount → colCount − 1` in nearest mode only | measured `179.99 → 179.75` (REPORTED); arithmetic VERIFIED | Recommended | **Yes** |
| Exact `180` (D8) | Keep the documented fold; document the divergence | `climate-data-foundation.md:931-943`; measured `180 → 179.75` | Recommended | **Yes** |
| Bounded outer half-cell | Reject (`out_of_grid`), as today's node-range validation does | no measured provider uses one | Recommended | **Yes** |
| `spatialResolutionKm` in preimage (D9) | Leave unchanged; not coupled to this ADR | `OPEN-18` question 5 | **Open** | **Yes** |
| Mode change on an existing binding (D10) | New `model` string | `grid.ts:521-563`; `ADR-007` D1 | Recommended | **Yes** |
| Implement now? | No — separate implementation task after approval | this ADR | **Deferred** | **Yes** |
| Grade A for `ecmwf_ifs025` | Unchanged blocker: geometry is grade B, the identifier→product mapping is grade C, so grade A + B is not met and no `validated` entry is possible | evidence §2.3, §4; `climate-data-foundation.md` §5.2.6 | **Open** | **Yes** |
| Does the provider clamp at the region or only near `180`? | Needs `179.90` (and `179.875`, `180.01`) | §12.7 | **Open** | Measurement first |
| Live database inventory | Assume zero rows; verify before any provider rollout | code + `CHECK` read; **no live DB inspected** | **UNVERIFIED** | Operator |

### 16.2 Evidence gaps

1. The raw 172-request corpus is outside the repository; only tables and aggregates are
   committed. The 41-pair extract reproduces arithmetically but is not a committed
   dataset, so the ADR cannot treat it as a rerunnable fixture until it is.
2. The 7-of-8 provider `cell_selection` claim has five locations in the document.
3. Polar and seam behaviour rest on a handful of coordinates each.
4. Grade A for `ecmwf_ifs025` is incomplete and its identifier→product mapping is grade C;
   the geometry itself is only grade B. Nothing in this ADR changes that.
5. The archive adapter's two URL builders are not asserted to agree parameter-for-parameter
   (§9.5, limit 1), so baseline source identity depends on two literals staying in sync.

OWNER APPROVAL IS NOT IMPLIED BY ANY "Recommended" ABOVE.

---

## 17. Verification performed for this ADR

What was actually executed, so a reader can tell evidence from assertion:

| Check | Result |
|---|---|
| Every code and schema claim in §1.1 read directly from the file and line named | done |
| `floorDiv` re-evaluated on the `0.25°` lattice at `±0.125`, `±0.125001`, `0.124999` | matches §6.2 |
| The 41 published request→served pairs recomputed under the nearest rule and the floor rule | 41/41 and 14/41, matching the report |
| Every golden vector's inputs recomputed under a nearest rule, to size Option B | 8 vectors change; vector 10 does not |
| Internal cross-references and section numbers in this ADR checked | see the corrections applied in this pass |
| `prettier --check` over the four touched documents | clean |
| `git diff --check` | clean |
| A live database queried for existing cell rows | **not run** — no database was inspected; §11 states the inference explicitly |
| The 172-request corpus re-fetched | **not run** — it is outside the repository (§16.2) |
| Any code, contract, fixture, registry or migration modified | **none** — this ADR is documentation only |
| Terminology pass 2026-11-24: every `cell_selection` / `cellSelection` occurrence read | separated per §6.6; §9.2 rewritten to name the provider parameter |
| D7 scope pass 2026-11-24: `apps/worker/src/ingest/climatology.ts`, `packages/weather-core/src/adapters/open-meteo-archive.ts`, `packages/database/src/climatology.ts` read | climatology opens no `IngestionRun` (`:218`, `:344-348`); `source_reference` carries the pinned parameters and is compared as identity; §9.5 states it and adds nothing |

---

## 18. References

**Decision and contract**

- `docs/adr/ADR-001-weather-data-provider-strategy.md` — D8 (per-model rounding rule)
- `docs/adr/ADR-007-spatial-registry-identity.md` — D1–D6
- `docs/architecture/climate-data-foundation.md` — §5.2.2 rules, §5.2.3 algorithm,
  §5.2.5 re-gridding, §5.2.6 evidence grades, §5.2.7 vectors, §5.2.8 two-phase write,
  §5.2.9.2 result contract, §5.2.9.3 longitude questions
- `docs/architecture/provenance-contract.md` — §3 identities and idempotency
- `docs/data-model/open-decisions.md` — `OPEN-18` (and its questions 1–7)
- `docs/data-model/tables-climate.md` — `outlook_cells`, `ingestion_runs`,
  `weather_records`

**Implementation read for this ADR**

- `packages/contracts/src/grid.ts` — `defineGridSpec`, `resolveGridCell`,
  `createGridRegistry`, `GRID_RESOLUTION_ALGORITHM_VERSION`,
  `createSpatialResolution`
- `packages/contracts/src/grid.test.ts`, `packages/weather-core/src/grids/registry.test.ts`
- `packages/contracts/src/climate.ts` — `ingestionVersionOf`
- `packages/database/src/weather.ts` — `resolveForecastCells`, drift guard
- `packages/database/prisma/migrations/20261118030000_domain_tables/migration.sql`
- `apps/api/src/field/field.service.ts` — `resolveCell`
- `apps/worker/src/ingest/{forecast,seasonal,climatology}.ts` — `cellsFromSelector`
  round-trip
- `packages/weather-core/src/grids/{registry,synthetic}.ts`

**Evidence**

- `docs/review/open-18-open-meteo-ifs025-evidence.md` (2026-11-24)
- `docs/review/open-18-grid-selection-architecture-proposal.md` (2026-11-24; `4210167`)

**Errata recorded, not rewritten**

- evidence report §5: the provider cell interval is `[n − step/2, n + step/2)`, not
  `(n − step/2, n + step/2]`; its own §3.4 measurement is the authoritative statement.
- proposal §4.5: vector 10 is unaffected; the Option B set is 1, 4, 6, 8, 9, 12, 13, 15.
