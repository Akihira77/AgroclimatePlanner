# `OPEN-18` — Open-Meteo `ecmwf_ifs025` grid evidence

**Status:** investigation only. **No production grid is configured, no registry entry is
added, no `gridSpecHash` is computed or pinned, and no resolver, contract, migration or
golden vector is changed.** The last section is a list of decisions an owner has to make,
not a record of decisions made.

> **Follow-up 2026-11-24:** the decisions this report lists are analysed in
> `docs/adr/ADR-008-grid-cell-selection-semantics.md` (status **Proposed**, not accepted).
> §5 carries a dated erratum for its cell interval; §3.4 was correct. This report is
> otherwise unchanged.

**Question:** does Open-Meteo's `ecmwf_ifs025` product have enough documented and measured
evidence to define a production `GridSpec`, and can the current resolver represent what
the provider actually does without approximation?

**Answer:** the lattice geometry is now measured and is unambiguous, and the endpoint
**snaps** rather than interpolates. But the provider selects the **nearest cell centre**
while `GridSpec` defines a cell as `[node, node + step)`, and the half-step offset that
would reconcile the two is **unrepresentable** — it requires a latitude range outside
`[-90, 90]`. Registering the node lattice unchanged would put roughly two requests in
three in a different cell than the provider served. `OPEN-18` therefore stays open.

Evidence is tagged:

- **Verified** — read from this repository or produced by a command in it.
- **Reported** — received from a provider or a source outside the repository.
- **Concern** — a risk or gap identified here, not a defect in shipped code.

---

## 1. What was asked, and what was measured

| Field | Value | Evidence |
|---|---|---|
| Endpoint | `https://api.open-meteo.com/v1/forecast` | Verified — request |
| Product | `models=ecmwf_ifs025`, `daily=precipitation_sum`, `forecast_days=1`, `timezone=UTC` | Verified — request |
| Selection | `cell_selection=nearest` unless a case says otherwise | Verified — request |
| Measurement date | 2026-11-24 (UTC). The stored corpus records `2026-11-24T07:42:14Z`–`07:42:38Z`; later batches ran in the same session | Verified |
| Requests | 172 across five batches, of which 164 returned a served coordinate (the other 8 are the out-of-domain `400` cases in §3.2); distributed by latitude, longitude, hemisphere, boundary and antimeridian | Verified |
| Retention | Raw responses kept outside the repository; the tables below are the reproducible extract | Concern — see §8 |

`cell_selection=nearest` was pinned because the provider default is `land`, which is not
the nearest cell (§4.6). Measuring the default would have measured a DEM lookup, not a
lattice.

---

## 2. Grade A — documented

Two Open-Meteo pages were read.

### 2.1 ECMWF API — Data Sources

> This API provides access to both real-time IFS HRES 9 km forecasts and open-data ECMWF
> IFS and AIFS 0.25°.

| Weather Model | Region | Spatial Resolution | Temporal Resolution | Forecast Length | Update frequency |
|---|---|---|---|---|---|
| IFS 0.25 Open-Data | 🌍 Global | 0.25° (~25 km) | 3-Hourly, 6-hourly after 144 hours | 15 days | Every 6 hours |

Source: <https://open-meteo.com/en/docs/ecmwf-api> §Data Sources. **Reported.**

Establishes: global extent, `0.25°` spacing, `~25 km` nominal resolution, 6-hourly cadence.

### 2.2 Weather Forecast API — JSON return object and parameters

> `latitude, longitude` | Floating point | WGS84 of the center of the weather grid-cell
> which was used to generate this forecast. This coordinate might be a few kilometres away
> from the requested coordinate.

> `cell_selection` | String | No | `land` | Set a preference how grid-cells are selected.
> The default `land` finds a suitable grid-cell on land with similar elevation to the
> requested coordinates using a 90-meter digital elevation model. `sea` prefers grid-cells
> on sea. `nearest` selects the nearest possible grid-cell.

> `elevation` | Floating point | The elevation from a 90 meter digital elevation model.
> This effects which grid-cell is selected (see parameter `cell_selection`). Statistical
> downscaling is used to adapt weather conditions for this elevation.

Source: <https://open-meteo.com/en/docs> §JSON Return Object, §API Documentation.
**Reported.**

Establishes, and this is the load-bearing sentence:

1. The served coordinate is the **centre of the selected grid cell** — a node, not an
   arbitrary nearest point and not an interpolated point.
2. Selection is a **parameter**, not a property of the model: `land` (default) chooses a
   cell by land cover *and elevation*, `sea` by sea, `nearest` by distance.
3. `elevation` in the response is a DEM value at the **requested** point, and it
   influences which cell is chosen.

### 2.3 What grade A does **not** establish

| Property | Status |
|---|---|
| Grid origin / reference convention (are nodes at multiples of `0.25`? at `0`? at `±90`?) | **not documented** |
| Axis order and index direction | **not documented** |
| Regular vs reduced construction | **not documented** — "0.25°" is stated, construction is not |
| Longitude convention of the native axis (`0..359.75` vs `-180..179.75`) | **not documented** |
| That the string `ecmwf_ifs025` names the "IFS 0.25 Open-Data" row | **not documented** — the identifier appears on neither page |

`§5.2.6` grades A as "the provider's or model's own statement of grid spacing, origin/
reference convention, axis order, and reduced/regular construction". Two of those five are
documented. **Grade A is therefore partial, and the identifier mapping is grade C.** The
remainder had to be measured.

---

## 3. Grade B — measured

### 3.1 The endpoint snaps; it does not interpolate

`§5.2.6` protocol step 3: identical served coordinates for different requests prove
snapping.

| Requested | Served | `precipitation_sum` |
|---|---|---|
| `-6.1300, 106.6200` | `-6.25, 106.75` | 18.0 |
| `-6.2000, 106.7000` | `-6.25, 106.75` | 18.0 |
| `-6.2400, 106.7400` | `-6.25, 106.75` | 18.0 |
| `-6.2450, 106.7450` | `-6.25, 106.75` | 18.0 |
| `-6.2550, 106.7550` | `-6.25, 106.75` | 18.0 |

Five requests spanning one `0.25°` box returned one coordinate and one value; a request
on the other side of the box edge returned a different pair. **Verified.** The endpoint is a
nearest-cell service, so `§5.2.6`'s open ambiguity for this row — "the served point is on a
plausible 0.25° lattice, but the same research calls it an interpolated point" — is
**resolved in favour of snapping**. That earlier reading is now contradicted by
measurement, not by argument.

`served_value_is_interpolated` therefore stays `false` for this product, and the served
coordinate may be stored as the provider's own answer.

### 3.2 Lattice step and congruence class

Every served coordinate observed was an exact multiple of `0.25`: `-6.25`, `-6.00`,
`106.50`, `106.75`, `45.00`, `45.25`, `-34.00`, `-33.75`, `151.25`, `179.75`, `-180.00`,
`0.00`, `-73.50`, `90.00`, `-90.00`, `84.50`, `84.75`, `26.50`, `-153.50`.

`§5.2.6` protocol step 4: the greatest common step of the served differences is the
spacing, and the served value modulo the step is the origin's congruence class.

- Step: `0.25°` on both axes. **Verified.**
- Congruence class: `0.00` on both axes — nodes are at multiples of `0.25`, not offset by
  `0.125`. **Verified.**
- Extent: nodes exist at `+90.00` and `-90.00` (requests `89.9`/`89.88` → `90.0`;
  `-89.9`/`-89.88` → `-90.0`), and at `-180.00` (`-179.99` → `-180.0`). Latitude is
  therefore `721` nodes in `[-90, 90]`; longitude is `1440` nodes covering `360°`
  (`-180.00 … 179.75`). The counts are arithmetic over a measured lattice, not a provider
  statement.
- Request domain: latitude outside `[-90, 90]` and longitude outside `[-180, 180]` are
  `400` — `{"reason": "Latitude must be in range of -90 to 90°. Given: 90.01."}`. **Verified.**

### 3.3 The grid is regular, not reduced

A reduced Gaussian grid would lose longitudinal resolution with latitude. Measured
longitude spacing along `-137° … -135.75°` is `0.25°` at `84.5°N`, `89.0°N`, `70.0°N` and
`20.0°N` — ten requests each, identical snapping. **Verified.** The lattice is a regular
lat/lon rectangle over the whole domain, so `§5.2.2` rule 4 ("regular lat/lon only") does
not exclude it.

### 3.4 Selection is nearest-node, ties toward north/east

| Requested | Served | `0.25 × round_half_up(x / 0.25)` |
|---|---|---|
| `0.1250` | `0.25` | `0.25` |
| `0.3750` | `0.50` | `0.50` |
| `0.6250` | `0.75` | `0.75` |
| `-0.1250` | `0.00` | `0.00` |
| `-6.1250` | `-6.00` | `-6.00` |
| `-33.8750` | `-33.75` | `-33.75` |

Ties resolve toward `+∞` on both axes, i.e. `floor(x / 0.25 + 0.5)`. **Verified.**

The decisive measurement is the comparison against the resolver's rule. Over 41
distributed coordinates:

| Hypothesis | Matches |
|---|---|
| nearest node — `floor(x / 0.25 + 0.5)` | **41 / 41** |
| lower node — `floor(x / 0.25)`, i.e. this repository's `resolveGridCell` | **14 / 41** |

Examples of the disagreement are not edge cases:

| Requested | Provider serves | `resolveGridCell` would return |
|---|---|---|
| `-33.80, 151.30` | `-33.75, 151.25` | `-34.00, 151.25` |
| `-33.90, 151.30` | `-34.00, 151.25` | `-34.00, 151.25` |
| `-6.10, 106.62` | `-6.00, 106.50` | `-6.25, 106.50` |
| `0.13, 0.13` | `0.25, 0.25` | `0.00, 0.00` |
| `83.8209, -162.7768` | `83.75, -162.75` | `83.75, -163.00` |

### 3.5 `cell_selection` changes the cell, not just the value

The default is `land`, and it is **not** the nearest cell.

| Location | Requested | `land` (default) | `nearest` | `sea` |
|---|---|---|---|---|
| Jakarta bay | `-6.10, 106.80` | `-6.25, 106.75` — 18.0 mm | `-6.00, 106.75` — 1.3 mm | `-6.00, 106.75` — 1.3 mm |
| Singapore strait | `1.20, 103.80` | `1.00, 104.00` — 12.4 mm | `1.25, 103.75` — 9.4 mm | `1.25, 103.75` — 9.4 mm |
| Bali strait | `-8.30, 115.20` | `-8.25, 115.25` — 10.1 mm | `-8.25, 115.25` — 10.1 mm | `-8.00, 115.25` — 0.1 mm |
| Palu bay | `-0.90, 119.90` | `-1.00, 120.00` — 3.9 mm | `-1.00, 120.00` — 3.9 mm | `-0.75, 120.25` — 2.3 mm |
| Marseille coast | `43.30, 5.40` | `43.25, 5.50` — 0.7 mm | `43.25, 5.50` — 0.7 mm | `43.25, 5.25` — 1.8 mm |

Seven of eight probed locations changed cell under at least one mode. **Verified.**

**Concern.** Cell identity here is not a function of `(provider, model, coordinate)`. It is
a function of `(provider, model, coordinate, cell_selection)` — and `cell_selection` has no
place in `GridSpec`. An adapter must pin `nearest` and the pin must be part of the ingest
identity, or a re-run with a different flag silently re-points stored cells.

### 3.6 `elevation` is not a cell property

The same served cell reported six different elevations, because the value is the 90 m DEM
at the **requested** point:

| Requested | Served | Response `elevation` |
|---|---|---|
| `-6.1300, 106.6200` | `-6.25, 106.50` | 10.0 |
| `-6.2000, 106.7000` | `-6.25, 106.75` | 13.0 |
| `-6.2500, 106.7500` | `-6.25, 106.75` | 22.0 |
| `-6.2450, 106.7450` | `-6.25, 106.75` | 20.0 |
| `-6.2550, 106.7550` | `-6.25, 106.75` | 27.0 |
| `-6.2400, 106.7400` | `-6.25, 106.75` | 25.0 |

**Verified.** Elevation must never be used to infer or confirm cell identity, and two
requests to one cell do not share one elevation.

Separately, `elevation` may be overridden and precipitation is **not** affected by it:
`(-6.25, 106.75)`, `(45.25, 10.25)` and `(-0.2, 100.4)` each returned the same
`precipitation_sum` at `elevation` auto, `0` and `2500`. **Verified.** For this variable
the value is the native cell's, so the documentation's "statistical downscaling is used to
adapt weather conditions" does not make the stored number a function of the request's DEM
elevation. It would for temperature; that is not measured here and is out of scope.

### 3.7 Antimeridian anomaly — unresolved

| Requested | Served | Value |
|---|---|---|
| `0.0, 179.99` | `0.0, 179.75` | 3.9 |
| `0.0, 180.0` | `0.0, 179.75` | 3.9 |
| `0.0, -180.0` | `0.0, -180.0` | 6.9 |
| `0.0, -179.99` | `0.0, -180.0` | 6.9 |

`180` and `-180` are one meridian, and both are lattice nodes. The provider serves `179.75`
for a request of `180` and `-180` for a request of `-180`, and the two answers are
**different cells with different values**. **Verified.**

This contradicts `§5.2.9.3`, which documents that a `-180`-origined global grid folds `180`
onto the same cell as `-180`. **Concern.** No explanation is offered here: it could be an
input normalization that maps `180` to a value just under it, or an index edge. It is not
to be papered over by a rounding rule. It maps onto the still-open `§5.2.9.3` question 2.

---

## 4. Grade C — what remains inferred

| Claim | Why it is only grade C |
|---|---|
| `ecmwf_ifs025` **is** the documented "IFS 0.25 Open-Data" row | The identifier is not documented on either page; the mapping is naming convention |
| `spatialResolutionKm = 25` | The provider states "~25 km"; the repo's field is a nominal figure, and its hash participation is open question 5 of §5.2.9.3 |
| Longitude node count is exactly 1440 | Arithmetic over `360 / 0.25`; the endpoint exposes no node list, and `180`/`-180` are two representations of one meridian |
| Stability over time | One session. A lattice change would be a provider `re-grid`, and nothing here bounds when it could happen |

---

## 5. Can the current resolver represent this? — **no**

This is the finding that decides the task.

**Provider model.** Node `n` is the **centre** of a cell covering
`(n - 0.125, n + 0.125]`. Nodes are `{…, -34.00, -33.75, …}` at 0.25°, including `-90`,
`+90` and the antimeridian.

> **Erratum 2026-11-24 — not applied to the text above.** The interval as written here
> contradicts this report's own §3.4, where `-0.125 → 0.00` and `0.125 → 0.25`. With ties
> toward `+∞` the cell is `[n - step/2, n + step/2)`, i.e. `[n - 0.125, n + 0.125)` at
> `0.25°`; §3.4 is the authoritative statement and the formula is
> `floorDiv(2·δ + step, 2·step)`. Recorded and analysed in
> `docs/adr/ADR-008-grid-cell-selection-semantics.md` §1.4. No measurement changes.

**Resolver model.** `§5.2.2` rule 3: "a cell owns `[node, node + step)` on both axes", and
`resolveGridCell` computes `i = floorDiv(latµ - originLatµ, stepLatµ)` (`grid.ts:418`). Node
`n` is the cell's **south-west corner**, and a cell covers `[n, n + 0.25)`.

**The only reconciliation** is to shift the anchor lattice by half a step, so that the
floor of a coordinate lands on the cell whose centre is nearest:

```
originLat = -90.125      latRange = [-90.125, 89.875]
originLon = -180.125     lonDomain = global
```

`defineGridSpec` refuses it. `grid.ts:279-281` requires `latRange` inside `[-90, 90]`; a
half-step-offset latitude lattice necessarily starts at `-90.125`. Relaxing the bound does
not help either, because every bound must be a lattice point of the origin
(`grid.ts:285-286`) and `±90` are themselves nodes. **Verified by reading the
implementation; not attempted in code.**

**What happens if the node lattice is registered unchanged** (i.e. the naive spec:
`originLat = -90`, `originLon = -180`, `stepLat = stepLon = 0.25`, `latRange = [-90, 90]`,
`lonDomain = global`): it is a legal `GridSpec`, but it describes a different partition
from the provider's, and the measured error rate is **27 of 41** requests. It fails in both
directions:

| Failure | Concrete case |
|---|---|
| One provider cell, two identities | requests `-33.80` and `-33.70` are both served cell `-33.75`; the resolver keys them `-34.00` and `-33.75` |
| One identity, two provider cells | resolver key `-34.00` is produced for `-33.80` (provider cell `-33.75`) and for `-33.90` (provider cell `-34.00`) |

`UNIQUE (provider, model, cell_key)` cannot detect either, because both keys are
internally consistent. This is exactly the class of defect `§5.2.1` exists to prevent:
served coordinate and cell identity pointing at different things.

**Concern.** A cell identity that is wrong for two thirds of coordinates is worse than no
configuration: it writes plausible-looking rows that cannot be reconciled later without a
new `model` string, and the first ingest would do it silently.

---

## 6. Decision

| Item | Decision | Reason |
|---|---|---|
| Production `GridSpec` for `ecmwf_ifs025` | **not added** | the resolver cannot represent nearest-centre selection without approximation (§5) |
| `gridSpecHash` | **not computed, not pinned** | no spec exists to pin; a pinned hash for an unusable spec would invite adoption |
| Registry | **unchanged** — still the one `synthetic` entry | no new entry, no `validated` entry |
| `requireValidated` | **unchanged** | nothing to validate against |
| Golden vectors / fixtures | **unchanged** | no configuration to vector |
| Contracts, resolver, `GRID_RESOLUTION_ALGORITHM_VERSION` | **unchanged** | the task forbids changing resolver semantics to fit a provider |
| Migrations, grants, RLS | **none** | nothing schema-level was needed |
| `OPEN-18` | **remains open, unvalidated** | geometry measured; representation blocked |

This is the "documented research-only result" the task prefers over an incorrect
production configuration.

---

## 7. What would unblock it

In dependency order. Each is an owner decision, not a task:

1. **Cell-selection semantics.** Either `GridSpec` gains a declared selection mode
   (`lower-edge` today, `nearest-centre` for this product) with a
   `GRID_RESOLUTION_ALGORITHM_VERSION` bump and a `cellKey` that names the node centre —
   or `cellKey` is redefined as the node itself and the half-step offset is accepted, which
   requires relaxing the `[-90, 90]` `latRange` bound to admit pole rows. They are
   different decisions with different historical-key consequences; only one may be
   implemented.
2. **The request parameter becomes part of identity.** `cell_selection=nearest` must be
   pinned in the adapter and recorded, or the served cell is a function of a 90 m DEM.
3. **Grade A completion.** A source that names `ecmwf_ifs025` and states origin/reference
   convention and construction, or an explicit owner decision that measured grade B
   carries the geometry.
4. **The `180` anomaly** answered against `§5.2.9.3` question 2.
5. **`spatialResolutionKm` in the hash** answered against `§5.2.9.3` question 5, before any
   spec is registered.

Until 1–3 are answered, no `ecmwf_ifs025` cell can be written honestly, and the
climatology read path's `provider`/`model` parameters remain unfillable in production.
