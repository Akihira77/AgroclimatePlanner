# Open Decisions

Everything this specification **did not settle**, with what it blocks and what
information would settle it. An `OPEN` item is never implemented by guessing.

Severity describes **scope**, not urgency:

| Level | Means | Evidence required to assign it |
|---|---|---|
| **P0** | blocks Phase 3 as a whole — no part of the phase can be built | the blocking object is `app` itself: a migration that cannot apply, a role that cannot connect |
| **P1** | blocks one named subsystem, deliberately named; the rest of Phase 3 proceeds | a specific write path, job, or slice that cannot be written or cannot be correct |
| **P2** | can be settled during implementation of the item that needs it | the affected code is not on the Phase 3 path |

**No item in this list is currently P0.** Phase 3's deliverables are tables,
constraints, indexes, policies, and grants; all of them can be created today,
which is exactly why the severity of every item that blocks anything is P1 with a
named subsystem rather than a phase-wide stop. A blocker is never widened to P0 to
signal that it matters — an item that blocks an entire subsystem still does not stop
a migration from applying.

**The register is 29 items: 14 P1 and 15 P2.** The 14 are classified by what they
stop in §1.1 — none blocks the Phase 3 DDL, twelve block a slice built on top of
it, one is mitigated by a labelled fallback, and one's DDL half is settled by
omission (`D26`). The 15 P2 items are in §3 and block nothing in Phase 3 by
definition. §5 records the Phase 2.4 disposition of every id.

Nothing in this list is a design preference. Each one is a question where a
plausible answer exists and choosing it silently would put an unapproved decision
into a normative schema.

## 1. The P1 register

### 1.1 Matrix (authoritative) — every P1 item, with what it stops

**Scope of this matrix, stated because the alternative is that a reader assumes it
means something else:** it lists **all 14 P1 items**, not a selection. It is the
complete P1 register, and it is the single source for "what is blocked and by
what". Every other document points here instead of restating it.

Two columns describe impact, and they are independent of severity:

`Applies` — where the decision lands:

| Value | Means |
|---|---|
| **Phase 3 DDL** | the decision changes what the Phase 3 migration must literally contain, so that migration cannot be written correctly without it |
| **after Phase 3** | the decision blocks a slice built on top of Phase 3 — auth, snapshot, ingest, window write, worker, AI, lifecycle. Phase 3's 19 tables, constraints, indexes, policies, and grants are written without it |

`Blocking` — whether a path exists today. Added in Phase 2.4, because "not P0" and
"not blocking" were being used as if they were the same claim:

| Value | Means | Example |
|---|---|---|
| **hard** | no implementation path exists; the affected slice cannot be written at all | — (no entry currently sits at this severity: `OPEN-01` was the last, closed 2026-11-21) |
| **conditional** | the path exists and works until a named condition enters scope, and then it stops | `OPEN-28` — the threat model holds until a leaked DSN is in scope |
| **mitigated** | a degraded path ships and is labelled as degraded; the decision improves it, it does not stop it | `OPEN-02` — the BMKG band falls back to labelled Open-Meteo |
| **none** | the DDL half is settled by omission, so nothing is blocked; only a vocabulary or contract remains open | `OPEN-09` — `D26` ships `plantings` without the default and without the index |

Severity stays a separate axis: it measures the scope of the subsystem the item
affects, not whether that subsystem has a fallback. `OPEN-02` is P1 and
`mitigated`; `OPEN-28` is P1 and `conditional`; neither is `hard`, and neither was
reclassified to P2 to make the distinction go away.

"Phase 3" here means the deliverables the phase tracker records: the 19 specified
tables, their constraints and indexes, the RLS policies, and the grants, as
hand-written SQL applied with `prisma migrate deploy`. No runtime write path is
part of it.

| ID | Sev | Category | Applies | Blocking | What is unresolved | Blocked | Continues independently |
|---|---|---|---|---|---|---|---|
| `OPEN-09` | P1 | catalog vocabulary | after Phase 3 (vocabulary only) | **none** — `D26` omits the DDL | whether the planting status vocabulary spells `active` | the `plantings.status` default and `plantings_active_idx`, both **deliberately not created** in Phase 3 | the `plantings` table without a default, `harvests`, every other table and index |
| `OPEN-01` | P1 | authentication | after Phase 3 | **none** — resolved 2026-11-21: the mechanism (`ADR-004`, S3/S4/S6) is shipped, and `POST /v1/auth/login` reads a credential through `app_auth` (`S8`, real-role integration test) | nothing now; it blocked login, session issuance, and every authenticated request | the DDL, the catalog, the weather plane, all RLS policies and grants |
| `OPEN-13` | P1 | authentication | after Phase 3 | **none** — resolved 2026-11-20 | nothing: PostgreSQL `app.sessions` was selected (`ADR-005`) and shipped in S5 | nothing on the storage question; the request path that uses the table arrived with `S8`, closing `OPEN-01` | everything — the table exists, is granted, and is verified on canonical |
| `OPEN-17` | P1 | field snapshot | after Phase 3 | **hard**, for point-shaped fields only | what `areaHa` means for a `POINT`-shaped field | field snapshot creation for point-shaped fields, and every artifact derived from one | the DDL (a `POINT` row is still storable); `POLYGON`/`MULTIPOLYGON` fields end to end |
| `OPEN-21` | P1 | field snapshot | after Phase 3 | **hard** | the `irrigationAvailable` boolean mapping and three field vocabularies | field → snapshot construction | the DDL — the columns stay unconstrained `text`; every non-snapshot path |
| `OPEN-18` | P1 | cell resolution | after Phase 3 | **conditional** — generic resolver, literal hash fixtures, the `(provider, model)` registry, the `SpatialResolution` result contract, and a synthetic-only registry instance implemented 2026-11-22 (5.2.1–5.2.4); per-`(provider, model)` grid configuration pending graded evidence; `ecmwf_ifs025` measured 2026-11-24 (grade A partial + B) and still unconfigurable, because the resolver cannot express nearest-centre cell selection (`docs/review/open-18-open-meteo-ifs025-evidence.md`) | the per-provider/model grid origin, spacing, orientation, longitude convention, and revision | cell identity, and field → cell resolution, for a model whose grid configuration is unvalidated | the DDL (`cell_key` is `text` for exactly this reason), the catalog, every query that reads an already-keyed cell, and the now-implemented generic resolver, registry and result contract |
| `OPEN-26` | P1 | window write | after Phase 3 | **hard** | the six-check `EvidenceSegment` partition validator | persisting a `planting_windows` row | the table, its index, every read path, `suitability_runs`, `ai_briefings` |
| `OPEN-27` | P1 | worker | after Phase 3 | **hard** | how the worker learns which fields a cell serves | `recompute.windows` — the job that delivers a new forecast to a dashboard | the DDL **and** the grants, which ship the documented default: no `app_system` grant on a tenant-owned table |
| `OPEN-11` | P1 | AI slice | after Phase 3 | **hard** | the `ClimateBriefing` body shape | writing or validating an `ai_briefings` row | the `ai_briefings` DDL; the table is createable exactly as specified, it simply cannot yet hold a valid document |
| `OPEN-04` | P1 | identity lifecycle | after Phase 3 | **hard** | the account-deletion policy | the deletion path and whether `users` gains a partial unique email index | the `users` DDL as implemented; registration; every read |
| `OPEN-03` | P1 | deployment / licensing | after Phase 3 | **conditional** — at production launch | Open-Meteo paid plan vs self-host | production deployment legality and `raw_payload_ref` retention | the DDL; non-production use |
| `OPEN-05` | P1 | retention | after Phase 3 | **hard** for a `reproducible: true` claim | per-provider raw payload retention | that claim for an artifact built on the provider | the DDL; artifacts stored with `reproducible: false` and a reason |
| `OPEN-02` | P1 | provider | **Phase 3 DDL: never** | **mitigated** — labelled fallback ships | BMKG written permission | the 0–3 d BMKG band only | everything — no column, constraint, or query in this model references BMKG |
| `OPEN-28` | P1 | security hardening | after Phase 3 | **conditional** — if a leaked DSN enters scope | whether signed tenant context (ADR-003 A2) is required | nothing, today | everything |

Reading the matrix:

- **No P1 item blocks the Phase 3 DDL any more.** Until Phase 2.4 the single
  blocker was `OPEN-09`: `plantings.status` has a `DEFAULT 'active'` and
  `plantings_active_idx` filters on `status = 'active'`, both spelling a value
  whose vocabulary is undecided. `D26` removes the question from the DDL instead
  of answering it — `plantings` ships with no default on that column and no
  partial index on that literal, so the vocabulary stays open and the table is
  still creatable. The vocabulary itself remains P1 and blocks the first writer.
- **"Not blocking Phase 3" is not one condition, and the `Blocking` column says
  which one applies.** `hard` means no path exists. `conditional` means the path
  works until a named condition enters scope — `OPEN-03` at production launch,
  `OPEN-28` if a leaked DSN is in scope. `mitigated` means a labelled fallback
  ships — `OPEN-02`. `none` means Phase 3 settles it by omission — `OPEN-09`.
  Collapsing these into one bucket is how `OPEN-02` and `OPEN-28` ended up looking
  identical when they are not.
- **The four items previously listed alone here — `OPEN-01`, `OPEN-17`,
  `OPEN-26`, `OPEN-27` — are not Phase 3 DDL blockers either.** They were the
  four that block the *first slice that consumes a Phase 3 table*: auth, snapshot,
  window write, worker. That is a real and narrower claim, and it is the claim
  §1.2–§1.5 make, one entry each. Naming only them, without saying what the other
  ten block, is what made the earlier matrix look exhaustive when it was not.
- **`OPEN-17` is narrower than it first appears.** Only a point-shaped field has
  `area_ha = 0`; a polygon field is unaffected. It escalates to **P0** if the
  product makes point-shaped fields a v1 requirement, because then field
  creation itself — the first thing every user does — is on the critical path.
- **`OPEN-26` is a write-path blocker, not a read or schema blocker.** The
  database cannot express the partition invariant, so it is enforced nowhere
  until the validator exists; the table, its columns, and its checks are
  unaffected.
- **`OPEN-27` is a worker blocker.** The table and its index are correct; the
  credential that would query them is not. Because the documented default is "no
  `app_system` grant on a tenant table" (`ownership-and-rls.md` §2), Phase 3 ships
  that default and the decision later either keeps it or adds one narrow grant.
- **`OPEN-02` is P1 by severity and blocking by nothing.** It is in the register
  because the permission is genuinely absent; it is not a blocker because the
  fallback is specified and labelled. A register that quietly dropped it would be
  the same defect in the other direction.

### 1.2 `OPEN-01` — the authentication lookup — **RESOLVED 2026-11-21**

The read that happens before a tenant context exists. `app_api` has no grant on
`app.users`; the table has `FORCE` RLS; `app.user_id` is only set inside
`withTenant`, which requires knowing the user. "Authenticate, then open a scope"
is not buildable from the current schema.

**The mechanism is no longer open.** `AG-1` selected the dedicated `app_auth` role on
2026-11-18 (`ADR-004`), and S3/S4/S6 built and verified it: column grants on
`app.users`, two policies, `db:verify` 499 assertions, the `auth-boundary` suite at 49
real-role cases. On 2026-11-21 the owner confirmed that boundary as final — no
`BYPASSRLS` shortcut, no new `SECURITY DEFINER` lookup, no tenant context on the auth
path (*Amendment 3* in `docs/review/phase-3.2-owner-decisions.md`).

**Closed by the `S8` request path.** `POST /v1/auth/login` reads `password_hash` through
`findAuthUserByEmail`, which issues a plain `SELECT` on `app.users` through the `app_auth`
client — no `withTenant`, no `app.user_id`. `packages/database/test/integration/session.test.mjs`
proves it against the real roles: the connection reports `current_user = app_auth`,
`current_setting('app.user_id', true)` is `NULL`, the credential row is returned, and
`app_api` is still refused `42501` on `SELECT password_hash`. Both halves of the gate — the
mechanism and the read path — are now shipped.

**Blocked:** nothing. It blocked the authentication slice, which now exists.
**Settled by:** `POST /v1/auth/login` reading a credential through `app_auth`, verified.

### 1.3 `OPEN-17` — `area_ha` for a `POINT` field — **P1**

`fields.area_ha` is a stored generated column
`ST_Area(geom::geography) / 10000.0`, which is **`0`** for a point.
`FieldSnapshotPayload.areaHa` is `z.number().positive()`. A point-shaped field
therefore cannot produce a valid field snapshot, and every artifact derived from
it is impossible to create. A polygon field is unaffected.

Three options: (a) disallow `POINT` — drop it from `fields_geom_type_check`;
(b) make `areaHa` nullable for point fields — a contract change, so an ADR;
(c) derive an assumed area from a declared radius — invents a number the user did
not supply. **None is chosen, and no estimated area is assumed for a point.**

**Blocks:** field snapshot creation for a point-shaped field, and therefore every
artifact derived from one. It does **not** block table creation, a polygon field,
or any subsystem that never handles a `POINT`.
**Severity note:** P1 while point fields are optional; **P0 if the product
requires them**, because then the first action a user takes is on the critical
path. Nothing in the current documents establishes that requirement.
**Would be settled by:** whether the product supports "I do not know my plot
boundary" as a first-class case.

### 1.4 `OPEN-27` — the recompute fan-out cannot query tenant rows — **P1**

Q18 ("which fields does this cell serve?") reads `field_outlook_cells`, which is
tenant-owned and RLS-protected, while the job that needs the answer runs as
`app_system`, which has no grant on it — and if it were granted one, its
`BYPASSRLS` would expose every tenant's resolutions.

Options: narrow `SELECT` to `app_system` (widest exposure) · a `SECURITY DEFINER`
function returning only field ids (narrow output, one privileged entry point) · a
global "cell → interested field" projection table (duplicates state, can drift).

**Blocks:** `recompute.windows`, i.e. the one job that makes a new forecast reach
a user's dashboard. **Would be settled by:** a decision on the narrowest
acceptable shape, in a follow-up ADR that does not yet exist (an earlier draft of
this document pointed at `ADR-004`; no such file exists and none is written).

### 1.5 `OPEN-26` — no `evidence_segments` partition validator — **P1**

Six interval checks (no overlap, no gap, full span, internal contiguity, reason
presence, coverage reconciliation) have no implementation. The database cannot
enforce them (`provenance-storage.md` §4), and `provenance-contract.md` §4 states
the validator does not exist. `jsonb_typeof(evidence_segments) = 'array'` is the
only check the schema performs, and it says nothing about interval algebra.

**Blocks:** the `planting_windows` write path. A window with a broken partition
is currently storable, and once the write path exists it must be impossible for
an invalid partition to be persisted as a valid recommendation.
**Would be settled by:** writing the validator, which belongs with the engine that
produces segments, not with the schema. Not implemented in this phase.

## 2. Detail — the other ten P1 items

Each of these is a row in §1.1. Eight are `after Phase 3`; `OPEN-09` is the single
`Phase 3 DDL` item, and `OPEN-02` blocks nothing because its fallback exists.

### `OPEN-21` — field vocabularies and the `irrigationAvailable` mapping — **P1**

`fields.soil_type`, `drainage_class`, `irrigation_availability` are text with no
vocabulary; `FieldSnapshotPayload.irrigationAvailable` is a **boolean**. No
document defines the conversion, so the mapping is unowned — and a wrong one
silently changes every window's `fieldSnapshotHash` and every water-dependent
verdict. Options: a lookup table, a `CHECK` list, or a boolean column.

**Blocks:** field → snapshot construction. This is the most consequential open
item in the identity group. **Does not block:** the DDL — the three columns stay
unconstrained `text`, and a `CHECK` vocabulary is one of the options, so it would
arrive as a later migration rather than as Phase 3 DDL.

### `OPEN-09` — `plantings.status` vocabulary — **P1**

No enum is written anywhere. `plantings_active_idx` assumes a value spelled
`active`, and the column carries `DEFAULT 'active'`. Options: `active` ·
`harvested` · `failed` · `abandoned`.

**Blocks:** the first writer of a `plantings` row, and the "what is growing here"
query that would read through the index (`tables-identity.md` §6,
`indexes-and-query-patterns.md` §2).
**Does not block Phase 3 any more.** `D26` (Phase 2.4) removes the question from
the migration instead of answering it: the column ships `NOT NULL` with **no
default**, and `plantings_active_idx` is **not created**. Both arrive in one
additive migration once the vocabulary is decided, with no data rewrite — no row
can exist before then. `D26` is a decision about the DDL, not about the
vocabulary, and the vocabulary is still open.

### `OPEN-18` — cell identity resolver per `(provider, model)` — **P1**

`outlook_cells.cell_key` is `text` because the rounding rule is per model, and
`ADR-001` D8 says "a fixed, documented rounding rule per model" — but **no model's
rule is written down**. The DDL does not need it (a `text` column accepts any
key); the first ingest does, because it must compute a key from coordinates.

**Blocks:** writing a cell identity, and field → cell resolution, for any
`(provider, model)` whose grid configuration is unvalidated. **Does not block:** the
`outlook_cells` and `field_outlook_cells` DDL, the catalog, or any query that reads a
cell that is already keyed.
**Corrected in 2.3.x.1:** this entry previously said "Phase 3's write path needs
it". Phase 3 as recorded in the phase tracker is DDL only, so it does not.

**Owner decision 2026-11-21 — the generic half is approved.** Cell identity is
computed by a provider/model-specific deterministic resolver; the grid origin,
spacing, orientation, and revision are explicit inputs. A universal
`floor(lat / resolution)` is refused because it assumes a zero origin, square cells,
and one axis orientation, none of which is established for any provider. Identity is
never derived from a served coordinate and never reconstructed from the key. A grid
change that alters identity requires a **new `model` string inside the same
`provider`**. The full contract is `docs/architecture/climate-data-foundation.md`
§5.2, with the registry identity and the resolution result in §5.2.9 and
`docs/adr/ADR-007-spatial-registry-identity.md`.

**Implementation status 2026-11-22 — all four pieces landed.**
5.2.1 (`44b278c`) and 5.2.2 (`965f528`) closed the registry key and the hash fixture;
5.2.3 added the result contract and 5.2.4 the concrete registry instance:

| Piece | Current fact (2026-11-22) | Status |
|---|---|---|
| registry key | `createGridRegistry` is keyed by `(provider, model)` through nested maps; duplicate pair → `duplicate_grid_spec`, unknown pair → `unknown_model` naming both components; no model-only overload | **Done** (5.2.2) |
| literal hash fixture | four literals in `packages/contracts/src/grid.test.ts` pin the preimage (1° global, the same lattice under a second `gridId`, 0.25° global, 0.05° bounded), and a fifth pins the registered synthetic spec in `packages/weather-core/src/grids/registry.test.ts` | **Done** (5.2.1, plus 5.2.4's own spec) |
| result contract | `SpatialResolution` and `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"`, assembled by `createSpatialResolution`, which re-checks `gridSpecHash` before resolving. `ResolvedCell` (`provenance.ts:104-112`) is still not reused: it requires `servedLat`, `servedLon`, and `distanceKm`, so it cannot describe a pre-ingest resolution | **Done** (5.2.3) |
| registry instance | `syntheticGridRegistry` in `packages/weather-core/src/grids/`, built by `createGridRegistry` from one entry labelled `synthetic` (provider `synthetic`, model `synthetic_1deg_20x20`). The pair resolves; unknown pairs fail with `unknown_model`; `requireValidated` fails with `grid_not_validated`. No provider constant beyond the synthetic one | **Done** (5.2.4), but synthetic only |

`CONTRACTS_VERSION` and the package version are `0.2.0`; the registry migration was
the deliberate breaking change ADR-007 D6 approved. The status reconciliation for these
steps is `1dff5fd` (§8.2 step 5.2.8). Earlier revisions of this entry, of §5.2.2, and of
§5.2.5 stated the `(provider, model)` registry and the literal fixture as if they were
already in force. They were not; that history is recorded here instead of being silently
rewritten, and both items are now actually implemented.

**Owner decision 2026-11-21 — the field-mapping boundary is resolved.**
`field_outlook_cells.distance_km` is `NOT NULL` and is a distance from the anchor to
the provider's **served** coordinate, which does not exist before the first ingest.
Resolution therefore stops at the cell identity: `outlook_cells` may be minted,
`field_outlook_cells` is not written, `0` is never a placeholder, and the anchor is
never substituted for the served coordinate. The mapping row belongs to the ingest
that learns the served coordinate, or to a later migration that makes the column
nullable — not to a fabricated value.

**Still open — provider evidence (owner approval outside the repository).** The five
configurations — `ecmwf_ifs025`, `ecmwf_ec46`, `ecmwf_seas5`, the ERA5 archive, and
CHIRPS v3.0 — need origin, spacing, axis orientation, longitude convention, and
node-vs-interpolation behaviour. Evidence is graded: **A** documented grid definition,
**B** measured request→served pairs under the §5.2.6 protocol, **C** inferred from a
resolution figure or an approximate coordinate. **C never configures a row, and one
measured pair is not enough** — an interpolating endpoint says nothing about the
lattice, and a pair that lands on a plausible lattice is consistent with every origin
in the same congruence class. The one Open-Meteo pair that lands exactly on a 0.25°
lattice (`-6.25/106.75`, `weather-source-matrix.md:163`) is graded **C** because the
same research calls it an interpolated point — **superseded on 2026-11-24** by the
measurement below, which shows the endpoint snaps.

**Evidence review 2026-11-24 — `ecmwf_ifs025` measured, and still not configured.**
`docs/review/open-18-open-meteo-ifs025-evidence.md` records 164 request→served pairs
against `api.open-meteo.com/v1/forecast` with
`models=ecmwf_ifs025&cell_selection=nearest`. It raises the row's grade and adds a
blocker that no further measurement can remove:

| Finding | Grade | Consequence |
|---|---|---|
| Global regular lat/lon, `0.25°` on both axes, nodes at multiples of `0.25` including `0`, `±90` and the antimeridian; not reduced | **B measured**; A for spacing and global extent only | the lattice itself is established |
| The endpoint **snaps**: identical served coordinates *and* identical values across a whole cell, different across a boundary | **B** | the earlier "interpolated point" reading is contradicted; `served_value_is_interpolated` stays `false` for this product |
| Selection is the **nearest node**, ties toward `+∞`. `resolveGridCell` floors: it reproduced the served node for **14 of 41** requests, the nearest rule for **41 of 41** | **B** | `GridSpec` defines a cell as `[node, node + step)`, so the node lattice describes a different partition |
| Reconciling them needs an anchor lattice offset by half a step, i.e. a `latRange` starting at `-90.125` | **Verified** — `grid.ts:279-281` | no legal `GridSpec` reproduces the provider's cells; the offset is unrepresentable |
| `cell_selection` (default `land`) changed the served cell at 7 of 8 probed locations, and response `elevation` is a DEM value at the *requested* point, not a cell property | **B** | the served cell is a function of a request parameter, not of `(provider, model, coordinate)` alone |
| Requesting `180` serves `179.75`; requesting `-180` serves `-180` — a different cell with a different value | **B** | contradicts §5.2.9.3's folding rule; unresolved |
| `ecmwf_ifs025` is not named on either documentation page | **C** | the identifier→product mapping remains inferred |

**Decision:** no production `GridSpec`, no `gridSpecHash`, no registry entry, no
`validated` state, and no resolver change. Registering the node lattice unchanged would
key roughly two requests in three to a cell the provider did not serve, in both
directions — one provider cell under two keys, and one key over two provider cells — and
`UNIQUE (provider, model, cell_key)` cannot detect either. `OPEN-18` stays
`BLOCKED_EXTERNAL_INPUT`; part of what blocks it is now an internal decision, listed
below.

**Still open — five resolver and configuration questions (owner approval required):**

1. Does generic coordinate validation reject `|lon| > 180` before wrapping? Today it
   does not — `400` resolves to a cell — and tightening it invalidates the `359.5`
   input of golden vector 10.
2. On a grid whose origin makes `180` the exclusive upper edge, should the
   antimeridian fold to the lower edge instead of failing?
3. Is a provider whose convention is `[0, 360)` expressed as a `global` domain with
   `originLon = 0`, or as a bounded `[0, 360)` grid?
4. Should `lonRange` gain the absolute bound that `latRange` already has? Today
   `["0", "400"]` is a legal configuration, because `latRange` is clamped
   (`grid.ts:278`) and `lonRange` is not (`grid.ts:295-309`).
5. Should `spatialResolutionKm` stay in the hash preimage? It is descriptive rather
   than part of the lattice, so correcting a published resolution figure changes
   `gridSpecHash` and — under the one-spec-per-`(provider, model)` rule — forces a new
   model string although no cell identity changed. Keeping it is defensible, because
   the hash pins the whole reviewed definition, but it has to be a stated choice.

**Still open — two questions this measurement adds (owner approval required), continuing
the five above:**

6. Does `GridSpec` gain a declared cell-selection mode (`lower-edge` today,
   `nearest-centre` for this product) with a `GRID_RESOLUTION_ALGORITHM_VERSION` bump —
   or is `cellKey` redefined as the node itself, with the half-step offset accepted and
   `latRange` relaxed to admit pole rows? They produce different historical keys, and
   only one may be implemented.
7. Must a request parameter that changes which cell is served (`cell_selection`) enter
   the ingest identity? Today it could move a stored cell without changing
   `(provider, model, cell_key)`.

**Decided, not open:** `cellKey` stays `nodeLat,nodeLon`, because
`UNIQUE (provider, model, cell_key)` already carries the other two components;
`gridId` stays in the hash preimage; the hash algorithm does not change.

**Built:** `packages/contracts/src/grid.ts` — `defineGridSpec`, `resolveGridCell`,
`gridSpecHash`, integer micro-degree arithmetic, `south-west` orientation only,
`GridKey`, `GridEvidence`, a registry keyed by `(provider, model)` with
`specFor` / `resolve` / `evidenceFor` / `requireValidated`, and `SpatialResolution`
with `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"` built by
`createSpatialResolution`, which refuses a spec whose hash does not describe its
lattice. Eighteen synthetic golden vectors, four literal `gridSpecHash` fixtures and
the resolution-result cases execute in `packages/contracts/src/grid.test.ts`.
`packages/weather-core/src/grids/` holds `syntheticGridRegistry` — one entry, labelled
`synthetic`, resolving provider `synthetic` model `synthetic_1deg_20x20`.

**Still unbuilt:** the route, every field→cell write, and every real provider grid.
The registry exists, but only the synthetic entry is in it; the field anchor exists and
`upsertCell` stores an identity triple, but nothing joins the two yet. A model cannot
ingest until its configuration reaches grade A + B, and `validated` is a review decision
the code does not make.

**Revised would-be-settled-by:** a validated `GridSpec` per `(provider, model)` with
grade A + B evidence, not a resolution figure and not one measured pair.

### `OPEN-02` — BMKG written permission — **P1**

Not obtained. `BMKG_SHORT_RANGE_ENABLED` defaults off. Nothing in this schema
depends on BMKG; the 0–3 d band falls back to Open-Meteo, correctly labelled.

### `OPEN-03` — Open-Meteo plan — **P1**

The free tier is non-commercial only. Whether production is commercial decides
whether the plan must be paid or self-hosted, and self-hosting's bucket terms are
undocumented. Affects `raw_payload_ref` retention and deployment legality, not
the schema.

**Owner decision 2026-11-21 — deferred, not closed.** Do not commit to a paid plan
yet. Commercial operation stays conditional on verified licensing and an appropriate
commercial plan; the free tier is not used for commercial operation; self-hosting is
not assumed to resolve licensing or redistribution terms. Price, quota, attribution,
and permitted use must be evaluated before 5.4 runs on a schedule. **Revisit:** before
any commercial deployment, or when 5.4 needs a production endpoint.

### `OPEN-05` — raw payload retention — **P1**

Per-provider licensing (`lifecycle-and-retention.md` §2). Determines whether
`reproducible` can be `true` for artifacts built on a given provider.

**Owner decision 2026-11-21 — retention deferred for the initial release.** No object
storage, no `raw_payload_ref` writer, and no assumption that any provider's terms
permit indefinite payload retention. Normalized records keep enough provenance to
identify origin and transformation; an artifact built on a non-retained payload
records `reproducible: false` with the reason `raw_payload_not_retained`. That is a
statement about the missing input bytes, **not** a statement that provenance is
missing — an artifact with no `inputRefs` is a separate defect. **Revisit:** when a
lawful paid or self-hosted plan exists, storage cost is known, and a verification run
must re-derive a score.

### `OPEN-11` — the briefing body contract — **P1**

`ai_briefings.body` is validated against the `ClimateBriefing` contract, whose
shape is not defined anywhere. Three distinct states, which should not be
conflated: the **table** can be created exactly as specified; a **row** cannot be
validated, because there is nothing to validate against; the **AI subsystem**
cannot be implemented. **Blocks:** the AI slice, and the write path into
`ai_briefings`. **Does not block:** the `ai_briefings` DDL, its constraints, its
indexes, or any read of a row written under a later contract.

### `OPEN-13` — session storage — **P1 — RESOLVED 2026-11-20**

Redis vs a table. **Decided: PostgreSQL `app.sessions`**, on the owner's `AG-2`
(2026-11-18) and `ADR-005` (accepted 2026-11-20), with `D-1`–`D-3` fixing the token-hash
shape, the 90-day absolute cap, and the two indexes. Delivered by S5 in
`20261118050000_sessions` and applied to the canonical development database
(`127.0.0.1:5442`) on 2026-11-20.

All three of `ADR-005`'s Definition of Done are evidenced, not asserted: the ADR is
**Accepted**; the migration is applied canonically (5/5 in `app._prisma_migrations`); and
`packages/database/test/rls/auth-boundary.test.mjs` (S6) is green there — 49 real-role
cases, including the `app_auth` column boundary on `sessions`, the `23514` constraint
behaviour at the 90-day cap, and the GC split between `app_api` and `app_system`.

**Does not resolve `OPEN-01`, and does not resolve `OPEN-04`.** The store is decided,
applied, and proven; the login, issuance, and request-path code that will use it is S8
and does not exist. (S7's registration path uses the `app_auth` credential but writes no
session row.) `sessions.user_id` keeps PostgreSQL's default `NO ACTION`, so account
deletion still has no policy (`D16` forbids the cascade).

### `OPEN-04` — account deletion — **P1**

Three options in `lifecycle-and-retention.md` §1. Only anonymisation preserves
provenance. **Blocks:** a GDPR-shaped request path and the `users` unique index
design. **Does not block:** the `users` DDL as it exists — the table is already
implemented without `deleted_at` and without a partial email index, and neither is
a Phase 3 deliverable; whichever option wins will amend an applied table through a
later migration.

### `OPEN-28` — signed tenant context — **P1**

`ADR-003` A2: HMAC over `user_id`, verified in the policy. The only mitigation
against a leaked `app_api` DSN that reads every tenant. Deferred; becomes required
if that threat is in scope before production.

## 3. Settle during implementation

The remaining **15 items, all P2**: none blocks a Phase 3 deliverable, because each
affects code that is not on the path yet. `OPEN-12` is the farthest out — it blocks
Phase 9's verification tables, not Phase 3. Each is listed with its effect so the
question is not lost.

| ID | Question | Effect |
|---|---|---|
| `OPEN-06` | `cultivars.photoperiod_sensitivity` representation | a real agronomic property with no type; unused until settled |
| `OPEN-07` | what a `window` comparator compares | `constraints` **rejects** `comparator = 'window'` until it exists |
| `OPEN-08` | `growth_stages.requirement_profile` type | currently unconstrained text |
| `OPEN-10` | `crops.category` vocabulary | unconstrained text; no code may branch on it |
| `OPEN-12` | verification/scoring tables (skill metrics, `forecast_scores`) | no table specified; blocks Phase 9, not Phase 3 |
| `OPEN-14` | `temporal_resolution` / `aggregation_level` vocabulary | enum values named but not frozen |
| `OPEN-15` | the `area_weighted` weight set | the resolution row cannot describe multi-cell weighting; `centroid` is the v1 policy |
| `OPEN-16` | `weather_records` growth/retention policy | ~56 000 rows per ensemble run; first real at Phase 5.4. **Owner decision 2026-11-21:** no automatic pruning until at least one month of measured ingestion, and never delete data needed for provenance or audit |
| `OPEN-19` | `updated_at` trigger | application-maintained today; raw SQL bypasses it |
| `OPEN-20` | v1 catalog seed scope | which graded thresholds ship in the first published profiles |
| `OPEN-22` | `fields_geom_gist_idx` justification | no query uses it; drop or keep at Phase 6 |
| `OPEN-23` | `cultivars.cycle_start` vs `plantings.cycle_start_used` disagreement | application invariant, not a database one |
| `OPEN-24` | `constraints.growth_stage_id` may name a stage of another profile | one composite FK + one unique key |
| `OPEN-25` | supersession cycles | not prevented; a looping chain is a writer bug |
| `OPEN-29` | `observationsUsed` embeds ids, not values | an edited observation does not change `fieldSnapshotHash` |

## 4. Decisions made here

Binding for Phase 3, revisable through review, never silently. Each is recorded
in the document that makes it.

| ID | Decision | Where |
|---|---|---|
| `D1` | `field_outlook_cells` holds the field-specific half; provider-grid facts live in `outlook_cells` | `tables-identity.md` §4 |
| `D2` | `monthly_outlooks` is global per cell, not tenant-owned | `tables-climate.md` §5 |
| `D3` | every instant is `timestamptz(6)`; no naive timestamp | `physical-model.md` §3 |
| `D4` | month keys are `date` constrained to the first of the month | `physical-model.md` §3 |
| `D5` | `crop_profile_versions` is immutable after publication: no `UPDATE` grant + a specified trigger | `tables-catalog.md` §3 |
| `D6` | constraints use `threshold_lower`/`threshold_upper`/`threshold_count`, not a single `value` | `tables-catalog.md` §5 |
| `D7` | `field_observations.entered_by` must equal `user_id` in v1 | `tables-identity.md` §5 |
| `D8` | enums are `text` + named `CHECK`, never PostgreSQL `enum` types | `physical-model.md` §5 |
| `D9` | hashes are `text` lowercase hex with a shape `CHECK`, never `bytea` | `physical-model.md` §6 |
| `D10` | JSONB only for documents that are a hash preimage | `physical-model.md` §7 |
| `D11` | `created_at` everywhere; `updated_at` on mutable tables; `deleted_at` on `farms`/`fields` only | `physical-model.md` §8 |
| `D12` | `raw_payload_ref` is an object-store key, populated only where the licence permits | `lifecycle-and-retention.md` §2 |
| `D13` | the catalog is seeded by `migration_owner`; runtime roles hold no write grant | `ownership-and-rls.md` §2 |
| `D14` | `app_api` may insert an `outlook_cells` identity triple and nothing else (column grant) | `ownership-and-rls.md` §2 |
| `D15` | every tenant→tenant edge is a composite `(id, user_id)` FK | `relationships.md` §2 |
| `D16` | no `ON DELETE CASCADE` anywhere | `relationships.md` §2 |
| `D17` | "one live row" invariants are partial unique indexes | `indexes-and-query-patterns.md` §3 |
| `D18` | `weather_records_live_key` uses `NULLS NOT DISTINCT` | `indexes-and-query-patterns.md` §3 |
| `D19` | status and `superseded_by_id` must agree, per table | `relationships.md` §5 |
| `D20` | `field_snapshot` is stored whole on `suitability_runs` only; other tables carry the hash | `provenance-storage.md` §3 |
| `D21` | `evidenceSegments` is a canonical `sequence`; `missing_ranges` is a `set` | `provenance-storage.md` §4 |
| `D22` | `geometryHash` is `sha256` of the stored EWKB, with no normalisation | `spatial-model.md` §6 |
| `D23` | harvest is per picking event — many per planting; yield is aggregated at read time | `tables-identity.md` §7 |
| `D24` | `weather_records` stores only the four forecast classes; observations, climatology, and verification truth have other homes | `tables-climate.md` §4 |
| `D25` | the suitability vocabulary is `suitable`/`conditional`/`unsuitable`/`insufficient_data`; `poor` is gone | `tables-derived.md` §2 |
| `D26` | `plantings.status` ships with no `DEFAULT` and no `plantings_active_idx`; both arrive with the vocabulary (`OPEN-09`) in one additive migration | `tables-identity.md` §6 |

## 5. Phase 2.4 dispositions

Every id has exactly one disposition. The vocabulary is fixed, because "not P0"
and "deferred" were doing too much work:

| Disposition | Means |
|---|---|
| **RESOLVED** | a decision is made and recorded; the item is no longer open |
| **DEFERRED** | no Phase 3 dependency; assigned to a named later subsystem, where the work is technical rather than a judgement call |
| **BLOCKED_EXTERNAL_INPUT** | needs a product, legal, licensing, agronomic, or security decision this project cannot make for itself |
| **NOT_APPLICABLE** | only with evidence; no item currently uses it |

| ID | Disposition | Assigned to | Why Phase 3 does not depend on it |
|---|---|---|---|
| `OPEN-09` | **DEFERRED** | the first `plantings` writer | the DDL half is settled by omission (`D26`): no default, no partial index |
| `OPEN-01` | **RESOLVED** | — | both halves met: the owner confirmed the `app_auth` boundary as final (`docs/review/phase-3.2-owner-decisions.md` *Amendment 3*), and `POST /v1/auth/login` now reads `password_hash` through it, proven by `packages/database/test/integration/session.test.mjs` (`current_user = app_auth`, `app.user_id` unset, `app_api` still refused `42501`) |
| `OPEN-13` | **RESOLVED** | — | not applicable now: `ADR-005` accepted, S5 applied canonically, and the S6 `auth-boundary` suite green (49 cases) |
| `OPEN-17` | **BLOCKED_EXTERNAL_INPUT** | product decision, then the snapshot path | a `POINT` row is storable; only its snapshot is impossible |
| `OPEN-18` | **BLOCKED_EXTERNAL_INPUT** | 5.0/5.2: pinned hash, provider/model registry, then provider grid validation — now also an owner decision on cell-selection semantics (nearest-centre row vs lower-edge resolver) | the generic resolver contract is approved (2026-11-21); `cell_key` is `text` and no constraint depends on its content; the field-mapping boundary is resolved (5.2 defers `field_outlook_cells`); `ecmwf_ifs025` geometry measured 2026-11-24 |
| `OPEN-21` | **BLOCKED_EXTERNAL_INPUT** | agronomic decision, then snapshot construction | the columns stay unconstrained `text` |
| `OPEN-26` | **DEFERRED** | the window engine that produces segments | the table, plus a `jsonb_typeof` array check, is all the schema can honestly do |
| `OPEN-27` | **BLOCKED_EXTERNAL_INPUT** | worker phase, with a security review of the narrowest read shape | grants ship the default: nothing to `app_system` |
| `OPEN-11` | **DEFERRED** | AI slice; the contract is authored with the briefing engine | `ai_briefings` is creatable exactly as specified |
| `OPEN-04` | **BLOCKED_EXTERNAL_INPUT** | product/legal decision on account deletion | `users` is already implemented and unchanged |
| `OPEN-03` | **BLOCKED_EXTERNAL_INPUT** | commercial decision at production launch | development use is inside the free tier |
| `OPEN-05` | **BLOCKED_EXTERNAL_INPUT** | licensing, per provider | the column is an object-store key, granted or `NULL` |
| `OPEN-02` | **BLOCKED_EXTERNAL_INPUT** | BMKG written permission | the labelled Open-Meteo fallback ships |
| `OPEN-28` | **DEFERRED** (conditional) | security review, only if a leaked DSN enters scope | the current threat model is the documented one |
| `OPEN-06` | **DEFERRED** | catalog seed authoring | `photoperiod_sensitivity` is unconstrained text, unused |
| `OPEN-07` | **DEFERRED** | constraint engine | `comparator = 'window'` is rejected by a `CHECK` |
| `OPEN-08` | **DEFERRED** | catalog seed authoring | `requirement_profile` is unconstrained text |
| `OPEN-10` | **DEFERRED** | catalog seed authoring | `crops.category` is unconstrained text; no code branches on it |
| `OPEN-12` | **DEFERRED** | Phase 9 verification/scoring | no verification table is specified or created |
| `OPEN-14` | **DEFERRED** | weather aggregation | the vocabularies are named in a `CHECK`, not frozen |
| `OPEN-15` | **DEFERRED** | resolution engine, when multi-cell weighting exists | `centroid` is the v1 policy |
| `OPEN-16` | **DEFERRED** | after at least one month of 5.4 ingestion, against measured growth | an empty table has no growth policy to enforce; the owner approved no pruning until measured (2026-11-21) |
| `OPEN-19` | **DEFERRED** | `updated_at` maintenance, when a writer exists | `DEFAULT now()` is applied; no trigger |
| `OPEN-20` | **DEFERRED** | catalog seed authoring | the catalogs are empty until seeded |
| `OPEN-22` | **DEFERRED** | Phase 6 spatial queries | the index exists and is unused |
| `OPEN-23` | **DEFERRED** | application invariant, with the planting writer | not expressible as a database constraint |
| `OPEN-24` | **DEFERRED** | catalog constraint authoring | one composite FK plus one unique key, added later |
| `OPEN-25` | **DEFERRED** | writer discipline | a looping supersession chain is a bug, not a state |
| `OPEN-29` | **DEFERRED** | snapshot builder | the column stores what the contract says it stores |

**Counts (recomputed from the table, 2026-11-21):** 2 RESOLVED (`OPEN-01`,
`OPEN-13`), 19 DEFERRED, 8 BLOCKED_EXTERNAL_INPUT, 0 NOT_APPLICABLE. The earlier
count of 9 BLOCKED_EXTERNAL_INPUT did not match the seven BLOCKED rows in the table;
`OPEN-18` moved from DEFERRED to BLOCKED_EXTERNAL_INPUT when its generic contract was
approved, which is the eighth.

Both `RESOLVED` items earned the word, and neither earned it from a decision alone:
`OPEN-13` from an accepted ADR, an applied migration, and a real-role suite green on the
canonical database; `OPEN-01` from the confirmed boundary plus a login path that reads a
credential through it, with a real-role test proving `current_user = app_auth`. The other
27 still need an owner outside this task — a product decision, a licence, an agronomic
vocabulary, or a security review.

Note that `RESOLVED` is still not the goal. A phase that resolved `OPEN-17` by assuming a
500 m radius "for now" would have made the database lie about a plot's area, and that lie
is inside a hash.

## 6. Phase 5 architecture decisions

Seven decisions were made during the Phase 5 design review and its 5.1 continuation. They are **not** `OPEN-*`
items — they are recorded here so this file remains the single decision register, and
they do not change the 29-item count in §1 or §3.

| ID | Decision | Rationale | Scope | Status | Revisit condition |
|---|---|---|---|---|---|
| `Q-P5-1` | PostgreSQL is the initial queue backing, using row locking and `FOR UPDATE SKIP LOCKED` behind a narrow job interface | PostgreSQL is already required; Redis and BullMQ would be new infrastructure with no operational evidence; the documented job semantics survive a backing swap. Refines `ADR-002` D2/D7 for the first implementation; see `background-processing.md` §2.1 | Job claiming, leases, retry scheduling, attempts, idempotency, dead-letter state, transaction boundaries, worker shutdown, observability | **Owner-approved architecture decision; implemented in Phase 5.3.** `app.jobs`, `apps/worker/src/queue`, and the runner exist; no Redis or BullMQ dependency was added | Measured contention or polling cost; a multi-region worker requirement; or a queue feature that is expensive to express in SQL |
| `Q-P5-2` | Structured logs plus `ingestion_runs.error` before any operational-history migration | `sync_attempts`, a dead-letter table, and a sweep watermark are named in `background-processing.md` §10 and **do not exist**; the first question that a log cannot answer should commission the table, not a guess | Per-attempt latency/bytes, dead-letter entries, sweep state | **Deferred** | A question the stored state and logs cannot answer, or a dead-letter count that must be queried rather than grepped |
| `Q-P5-3` | Temperature outlooks are out of Phase 5 | `monthly_outlooks_variable_check` admits only `precipitation`; temperature needs an assembly rule before a migration | `monthly_outlooks.variable` | **Deferred** | An assembly rule for temperature, and a sub-phase that needs it |
| `Q-P5-4` | CHIRPS v3.0 is preferred as the climatology baseline once a lawful, reachable route exists; ERA5 is the labelled fallback | `data.chc.ucsb.edu` timed out on 2026-11-18, and GEE's commercial terms are unevaluated | The baseline dataset, not the schema | **External evidence** | A fetched CHIRPS month from a reachable route, with commercial terms confirmed, or a decision to ship ERA5 permanently |
| `Q-P5-5` | A month is one source product; a month assembled from more than one product is not representable and is not permitted | `monthly_outlooks` has one `data_class` column and `MonthlyOutlook` one `dataClass` field; §5.5 rule 4 says "never blended". Supporting a mixed month needs an aggregation rule, a provenance shape for the split, and a schema change | `MONTHLY_OUTLOOK_BANDS`, `outlookMonthSchema`, `monthly_outlooks.data_class`, the aggregator in 5.7 | **Deferred** — the single-source rule is implemented and tested; mixed-source is not | A month where the only honest value needs two products, plus an owner decision on how to label and prove it |
| `Q-P5-6` | Whether a calendar month may be aggregated from **one product's daily values** (`weather_forecast` from Open-Meteo, `subseasonal_forecast` from EC46), and at what coverage threshold | Neither product returns a monthly statistic (`models=ecmwf_ec46&monthly=…` returns 0 rows; Open-Meteo reaches 16 d), so a month from them needs a daily→monthly rule and the coverage threshold, which has no owner decision yet. `monthly_outlooks.data_coverage_percent` exists for exactly this and is currently unpopulated | `MONTHLY_OUTLOOK_BANDS` (would gain `weather_forecast` / `subseasonal_forecast`), `outlookMonthSchema.dataCoveragePercent`, `monthly_outlooks.data_coverage_percent`, the aggregator in 5.7 | **Deferred** — monthly bands accept `seasonal_forecast` (1–7) and `climatology` (8–12) only | A measured coverage distribution per product, plus an owner decision on the threshold and on whether a partial month may be labelled at all |
| `Q-P5-7` | `monthly_outlooks.value_mm` holds an **estimated precipitation accumulation for one calendar month, in mm**, and the estimate's basis is named per `data_class`: `seasonal_forecast` → `ensemble_mean`, `climatology` → `climatological_mean` (`F-09`) | A single amount column is only honest if every filler of it says how the amount was estimated. Two estimators cover the two classes v1 can write, and neither is a realised total, so the read path must state the estimator rather than let a client infer a forecast from a number | `MonthlyOutlook.valueMm`, `monthly_outlooks.value_mm`, `outlookMonthSchema`, `climateOutlookSchema`, the monthly normalizer, the climatology aggregator, the UI label | **RESOLVED 2026-11-24 — owner-approved.** No estimator column was added: the mapping is total over the classes v1 can produce, so it is derived from `data_class` in `packages/contracts/src/climate.ts`; see the amendment below | A second approved estimator for the same `data_class` (needs a column), a provider-documented monthly total that makes `precipitation_mean` unnecessary, or a class with no approved estimator being written |

| `Q-P5-8` | **Which** `baseline_version` an outlook materialisation uses, and when a new one replaces a stored answer | `monthly_outlooks` has a free-form `baseline_version` per row and no "current baseline" pointer. Multiple versions can coexist (`climatology_baselines` is append-only), so "latest" is not a defined rule: `computed_at` orders builds, not approvals, and silently moving every stored outlook to a newer baseline would change published numbers with no decision behind it. Phase 5.7A therefore **refuses to select**: `baselineVersion` is an explicit `aggregate` job payload field, and an unknown version is terminal `baseline_unknown` | `aggregate` job payload, `packages/database/src/outlook.ts`, the read path, any future scheduler (Phase 6) | **Deferred** — fail-closed explicit input is implemented; no selection policy exists | An owner decision naming the rule (a promotion flag on `climatology_baselines`, a config value, or an explicit operator action per baseline), plus the fan-out that would use it |

Recording `Q-P5-1` was not implementing it; Phase 5.3 did that later. `app.jobs`, the
queue module, and the runner now exist, and still no Redis or BullMQ dependency was
added. `background-processing.md` §2.1 carries the same status.

### Amendment — `Q-P5-7` resolved (2026-11-24)

The owner decided the quantity, and with it the only defensible reading of the column.
Five things are now contract, not interpretation:

1. **The quantity.** `monthly_outlooks.value_mm` is an estimated precipitation
   **accumulation for one calendar month**, expressed in **millimetres per calendar
   month**. It is not a daily mean, not a rate, and not a monthly mean scaled by a
   month length. A consumer that needs a different period must convert explicitly and
   label the conversion; nothing in the contract performs one.
2. **The estimator, per class.** `data_class = 'seasonal_forecast'` means
   `ensemble_mean`: the arithmetic mean of the **50 SEAS5 members' monthly totals** for
   one initialisation. `data_class = 'climatology'` means `climatological_mean`: the
   arithmetic mean of the monthly totals of the **qualifying baseline years** for that
   calendar month. The two are different populations answering the same question, and
   they are never interchanged.
3. **The mapping is deterministic and derived, not stored.** `data_class` selects the
   estimator through one table in `packages/contracts/src/climate.ts`
   (`estimatorForDataClass`). A class absent from that table has **no** approved monthly
   estimator, so a value carrying one is unrepresentable rather than guessed. No
   estimator column was added in v1: two estimators for one class — the only thing a
   column would buy — is exactly the case the contract refuses.
4. **Climatology is a historical normal, never a forecast.** A `climatology` month
   answers "what this month usually brings", computed from complete baseline years. It
   is not a prediction for the coming year and must not be labelled as one. This is why
   `monthly_outlooks_beyond_horizon_check` and `MONTHLY_OUTLOOK_BANDS` keep it out of
   lead months 1–7.
5. **A seasonal value is an ensemble estimate, not a guarantee.** The mean of 50 members
   describes the centre of the ensemble's distribution for that initialisation. It says
   nothing about spread, and nothing about what will be realised; the spread columns
   exist and stay unpopulated until the spread policy is decided (see
   `docs/review/seasonal-spread-investigation.md`).

The repository evidence is why the estimator is the mean of member monthly totals and
not the provider column's daily shape: measured 2026-11-23, the mean of the 50 per-member
monthly sums reproduces `precipitation_mean` for all seven months of a live
initialisation (ratios 0.989–1.011, within the provider's 0.1 mm rounding). See
`packages/weather-core/src/adapters/open-meteo-seasonal.ts` and
`climate-data-foundation.md` §8.7.

`Q-P5-8` is **not** affected: which `baseline_version` a materialisation uses is still
deferred, still an explicit `aggregate` job payload field, and still fail-closed
(`baseline_unknown`). Resolving the quantity said nothing about selecting a baseline.

