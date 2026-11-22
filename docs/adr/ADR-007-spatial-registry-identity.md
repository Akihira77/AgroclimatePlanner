# ADR-007 — Spatial Registry Identity and the Field-Mapping Boundary

- Status: **Accepted** — approved by **Akihira77 on 2026-11-21** as six decisions in the
  Phase 5.2 corrective design pass. Acceptance was a **documentation gate at the time**:
  no contract was changed, no registry instance existed, no centroid read existed, no
  route existed, and no cell was persisted.
- Current state after `965f528` (2026-11-22): **D1, D2 and D5's structure are
  implemented.** The registry is keyed by `(provider, model)` with declared
  `GridEvidence`, `requireValidated` refuses a `synthetic` entry, `models()` is gone,
  and four literal `gridSpecHash` fixtures pin the preimage. `CONTRACTS_VERSION` and the
  package version are `0.2.0`. Still absent: `SpatialResolution` (5.2.3), the registry
  instance (5.2.4), the centroid read (5.2.5), persistence (5.2.6), and the route
  (5.2.7). No provider grid is configured, nothing is registered as `validated`, and no
  `field_outlook_cells` row is written by any code.
- Date: 2026-11-21 (decision and acceptance), recorded here 2026-11-21, implementation
  status updated 2026-11-22
- Depends on: ADR-001 (D8, provider strategy and the per-model rounding rule),
  ADR-002 (monorepo and backend architecture),
  `docs/architecture/climate-data-foundation.md` §5.2 (resolver, cell identity,
  golden vectors, two-phase cell write), `docs/data-model/tables-climate.md` §1
  (`outlook_cells`, `field_outlook_cells`), `docs/data-model/open-decisions.md`
  `OPEN-18`
- Supersedes: `climate-data-foundation.md` §5.2.2 rule 6 ("`gridId` binds
  one-to-one to `model`"), §5.2.5's "one `GridSpec` per model", §5.2.6's evidence
  sufficiency ("one measured request→served pair"), §5.2.7's claim that a committed
  `gridSpecHash` is asserted, and §8.2's scope (`weather-core/cells/`), contracts
  (`CellKey`, `ResolvedCell`, `distanceKm`), test count ("twelve vectors") and
  database impact (`field_outlook_cells`). Those sections are corrected in place;
  this ADR is the durable record of why.
- Implemented by: Phase 5.2, steps 5.2.1–5.2.8 of
  `climate-data-foundation.md` §8.2. 5.2.1 landed at `44b278c`, 5.2.2 at `965f528`, and
  5.2.8 at `1dff5fd`; 5.2.3–5.2.7 are not started.
- Register entry: `OPEN-18` — the generic half stays approved and unchanged; the
  provider/model half stays `BLOCKED_EXTERNAL_INPUT`.

## Context

The Phase 5.2 read-only audit found that the generic resolver is sound — integer
micro-degree arithmetic, `floorDiv` instead of truncation, half-open cells, frozen
ranges, node-derived keys, eighteen executed synthetic vectors — but that the layer
above it was designed for a repository that does not exist.

Three facts drove these decisions.

1. **A model string is a provider's own label.** Open-Meteo re-exports ECMWF models
   under strings it chooses, and nothing stops a second provider from using
   `ecmwf_seas5` for a different lattice. `createGridRegistry` is keyed by `model`
   alone (`packages/contracts/src/grid.ts:491-518`), so two providers cannot be
   addressed independently. The pipeline itself already speaks `(provider, model,
   product)` everywhere else — `ForecastRun`, `outlook_cells_grid_key`,
   `weather_records` — so the registry is the outlier.
2. **`gridId` was given an invariant it does not need.** The document said it binds
   one-to-one to `model`; the code never enforced it, and two models sharing one
   `gridId` are both accepted. A label is not an identity.
3. **The field → cell mapping cannot be written before ingest.**
   `app.field_outlook_cells.distance_km` is `NOT NULL` and is defined as the geodesic
   distance from the field anchor to the provider's **served** coordinate. The served
   coordinate is `NULL` on `outlook_cells` until the first ingest, by design. A
   resolver that writes this row before that moment must fabricate the number.

Two further findings shaped the result contract: no literal `gridSpecHash` fixture
existed, so an edit to the hash preimage passed all 354 tests of the time; and one
measured request→served pair cannot establish a grid, because an interpolating endpoint
says nothing about the lattice. The first was closed by 5.2.1; the second still governs
provider admission.

## Decision

### D1 — The registry is keyed by `(provider, model)`

```ts
interface GridKey { readonly provider: string; readonly model: string }
```

`specFor`, `resolve`, `evidenceFor` and `requireValidated` take a `GridKey`. Lookup by
`model` alone is **not provided** — not as a convenience overload, not as a fallback —
because it is exactly the ambiguity this decision removes.

- A duplicate `(provider, model)` registration fails deterministically
  (`duplicate_grid_spec`), as a duplicate model does today.
- An unknown key fails with `unknown_model` naming both components. No nearest match,
  no default grid, no other provider's grid.
- `GridSpec` keeps no provider or model field. The identity lives in the registry
  entry; the spec stays a pure configuration.

### D2 — `gridId` is a label; `gridSpecHash` is the pin

`gridId` names one reviewed definition. It is not unique across providers or models,
and it is never a lookup key. Two different configurations may share it; the hash
distinguishes them.

`gridSpecHash` continues to include `gridId` in its preimage. The hash's job is to pin
one named definition — the label is part of what is reviewed and committed — and
removing it would change every hash that will ever exist, before any hash is
persisted, for no gain. The consequence is stated rather than hidden: two
byte-identical lattices under different `gridId`s hash differently, by design.

The hash algorithm does **not** change in Phase 5.2. What changes is that a literal
expected value is committed per registered spec, which is the only mechanism that
makes an in-place edit fail the suite.

### D3 — The resolution result names three coordinates, and returns two

| Coordinate | Produced by | In the resolver result |
|---|---|---|
| **requested** | the caller | yes, as supplied, decimal strings |
| **anchor** | the cell indices | yes — `nodeLat`/`nodeLon`, never the request rounded |
| **served** | the provider's response | **no** |

```ts
interface SpatialResolution {
  readonly provider: string;
  readonly model: string;
  readonly gridId: string;
  readonly gridSpecHash: string;
  readonly resolutionAlgorithmVersion: string; // "grid-resolve/1"
  readonly evidence: GridEvidence;             // "synthetic" | "validated"
  readonly requested: { readonly lat: string; readonly lon: string };
  readonly anchor: { readonly lat: string; readonly lon: string };
  readonly i: number;
  readonly j: number;
  readonly cellKey: string;
}
```

No `servedCoordinate` field, because the resolver has no provider response; an HTTP
layer may write `servedCoordinate: null` so no client can read the anchor as served.
No `distanceKm`, because it needs the served coordinate. No `extractionPolicy`,
because it is a field concept rather than a grid concept.

`cellKey` stays `"<lat>,<lon>"`. The unique index is
`(provider, model, cell_key)`, so embedding provider or model in the key would
duplicate the other two components and diverge from the documented format for no
additional guarantee.

`Reproducibility` and `DerivationProvenance` are not reused. `Reproducibility` is
about retained raw bytes; `DerivationProvenance` is about derived artifacts and
rejects an empty `inputRefs`. A cell identity is a pure function of a pinned
configuration, so a focused contract is smaller and more truthful than a provenance
envelope that cannot honestly be filled.

`ResolvedCell` (`provenance.ts:104-112`) is the closer near miss and is also not
reused: it requires `servedLat`, `servedLon`, and a non-negative `distanceKm`, so no
value of that type can exist before the first ingest. Reusing it would force exactly
the fabrication D4 forbids; it keeps its present meaning in field snapshots.

### D4 — `field_outlook_cells` is written by ingestion, not by resolution

Phase 5.2 may mint an `outlook_cells` identity row — `app_api` is granted
`INSERT (provider, model, cell_key)` — and must not write `field_outlook_cells`.

- `0` is never a placeholder for an unknown distance.
- The anchor is never substituted for the served coordinate to manufacture a distance.
- The mapping row is created by the ingest that first learns the served coordinate,
  or by a later migration that makes `distance_km` nullable. No migration is proposed
  in Phase 5.2 to work around this.

### D5 — Synthetic configurations are labelled, and cannot reach ingestion

`GridEvidence` lives on the registry entry, never inferred from the name.

- `"synthetic"` entries resolve — tests and development need them — and
  `requireValidated` refuses them, so ingest paths cannot use one by accident.
- `"validated"` requires grade A + B evidence per §5.2.6: a documented grid definition
  plus a measured protocol that separates snapping from interpolation.
- No fallback grid, no cross-provider selection, no enabling a provider to make a test
  pass. All five real grids remain unavailable.
- **The code cannot verify that evidence.** `validated` is a declared value: the runtime
  guarantee is only that an entry declared `synthetic` is refused on an ingest path.
  Admitting a provider to `validated` is a review decision against §5.2.6, made by a
  person, not a check `requireValidated` performs.

### D6 — Compatibility is a deliberate breaking change

`createGridRegistry` changed signature. This was a migration, not an extension:

| Option | Why it was not chosen |
|---|---|
| compatible extension (model-only overload retained) | the overload reintroduces lookup by model name alone, which D1 forbids |
| separate registry interface alongside the current one | duplicates the resolver's consumer surface and forces two lookups for one identity |
| **deliberate migration (chosen)** | zero production consumers; `packages/contracts/src/grid.test.ts` was the entire blast radius |

It landed at `965f528`. `CONTRACTS_VERSION` and the package version moved `0.1.0` →
`0.2.0` because the export broke. Golden vectors 1–18 stayed valid: they exercise
`resolveGridCell`, which did not change.

## Consequences

**Positive.** Two providers can expose the same model string without collision. An
unknown configuration fails loudly instead of silently borrowing another grid. A
result carries everything needed to reproduce a cell, plus the one string that says
whether the algorithm that produced it is still current. A synthetic grid can be
tested without pretending to be a provider, and cannot reach ingestion.

**Negative.** Every caller of `createGridRegistry` changes at once; `contracts` takes
a version bump. `SpatialResolution` duplicates two fields already present on
`ResolvedGridCell` (`gridId`, `gridSpecHash`) because the result is what crosses a
boundary and the cell is what computes it — the duplication is intentional and small.

**Neutral, and worth stating.** `gridSpecHash` still changes when only `gridId`
changes, so re-labelling a definition is a new hash. No hash is persisted, so nothing
downstream needs migrating today.

## Not decided here

Recorded in `OPEN-18`, requiring owner approval before implementation:

1. Whether generic coordinate validation rejects `|lon| > 180` before wrapping.
2. Whether the antimeridian folds to the lower edge on a grid whose upper bound
   excludes it.
3. Whether a provider's `[0, 360)` convention is a `global` domain with
   `originLon = 0` or a bounded `[0, 360)` grid.
4. Whether `lonRange` gains the absolute bound that `latRange` already has, so
   `["0", "400"]` stops being a legal configuration.
5. Whether `spatialResolutionKm` stays in the hash preimage: it is descriptive, so
   correcting it changes the hash and forces a new model string without changing any
   cell identity.

## Alternatives considered and rejected

- **Put `provider` and `model` on `GridSpec`.** Rejected: the spec is a pure
  configuration, and the same configuration can serve two models legitimately. The
  identity belongs to the binding, not the grid.
- **Embed `gridId` (or the provider) in `cellKey`.** Already rejected in §5.2.5 and
  unchanged: it duplicates the uniqueness key and lengthens every key.
- **Let resolution write `field_outlook_cells` with `distance_km = 0`.** Rejected:
  zero is a real distance and would be read as one. It is the exact conflation §5.2.1
  exists to prevent.
- **Derive the grid from one measured request→served pair.** Rejected: an
  interpolating endpoint's answer says nothing about the lattice, and a value that
  lands on a plausible lattice is consistent with every origin in the same congruence
  class.
