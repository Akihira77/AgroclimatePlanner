# User guide

What the web interface does today, what it deliberately does not, and how to read
the numbers it shows. It documents the four screens in `apps/web`, not the API —
that is `docs/guides/api-reference.md` — and not the agronomy, which lives in
`docs/research/` and `docs/data-model/`.

The interface is in Indonesian; this guide is in English and names the labels as
they appear on screen.

---

## 1. What this is not yet

Stated first, because a user guide that omits it would set the wrong expectation
for every number on every screen:

- **No recommendation is shown anywhere.** The agronomy engine exists
  (`packages/agronomy`), the catalogue it reads is the one on the Katalog screen,
  and nothing joins them in the interface. There is no suitability score, no
  planting window, no "plant now" verdict.
- **The climate values come from fixtures.** The only grid configured is
  `synthetic/synthetic_1deg_20x20`. A real provider answers `GRID_NOT_FOUND`,
  because the field → cell mapping has no writer until `OPEN-18` is decided.
- **The crop catalogue arrives by running a command.** `pnpm db:seed:catalog`
  inserts four crops with one cultivar and one published rulebook each, as
  `migration_owner`. Until it runs, the Katalog screen is empty and says how to
  fill it. The seed ships no water threshold for kedelai or cabai, because the
  evidence for one is missing — those two profiles say so rather than guessing.
- **No account management.** No password reset, no email verification, no account
  deletion. Registration and login are the whole lifecycle (`OPEN-04` is the open
  decision for deletion).

---

## 2. Signing in

There is one form for both actions; the switch at the bottom toggles it.

| Action | What happens |
|---|---|
| **Daftar** (register) | Creates the account, then immediately logs in with the same credentials. Registration does not itself issue a session, so this is two calls behind one button |
| **Masuk** (login) | Issues an `HttpOnly` session cookie. The browser never sees the token |
| Password rule | At least 12 characters, enforced by the server; the hint on the form states it |
| Existing email | `Alamat email sudah terdaftar.` — the server's `CONFLICT` code reworded by the form, which knows which conflict it asked for |

Two failures do not look like a login:

- **The shell says "Tidak dapat menghubungi API".** The session check failed for
  a reason other than `401` — the API is down, the base URL is wrong, or the
  origin is not admitted. Showing the login form here would hide a broken
  deployment behind a password prompt.
- **A page goes blank back to the form mid-session.** The cookie expired or was
  revoked server-side. The app leaves the shell rather than painting "session
  ended" over data it can no longer load.

**Keluar** in the sidebar ends the session. A logout that fails keeps the cookie
and the server-side row in place and shows the error: the screen does not claim
you signed out of a session that still exists, which matters on a shared machine.

The session cookie is `HttpOnly` and same-site: in development the Vite dev
server proxies `/v1`, and a deployment that splits the two sets
`VITE_API_BASE_URL` and `CORS_ORIGINS` in step.

---

## 3. Ringkasan (dashboard)

The landing screen answers "where am I", in that order:

- **Counts**: farms recorded, fields with geometry. The horizon ranges
  (`0–45` days, `1–12` months) are the contract's limits, not a measurement of
  anything stored.
- **Kebun terbaru**: the four newest farms with region, field count and creation
  date.
- **Langkah berikutnya**: two links and one statement. The cards go to Iklim and
  to Katalog; the third is not a link at all — it says that climate values come
  from fixture rows until the production grid is validated, and carries the
  `OPEN-18` tag. Lahan is reached through the *Kelola lahan* link in the
  *Kebun terbaru* header, or from the left navigation.

No chart is drawn. There is no suitable series to plot yet, and a chart over an
empty table is a worse lie than an empty state.

---

## 4. Lahan (farms and fields)

One screen holds both levels: the farms as a selectable grid, and the fields of
the selected farm in a table below.

### 4.1 A farm

| Field | Limit | Notes |
|---|---|---|
| Nama | 100 characters, required | |
| Wilayah | 120 characters, optional | Free text, not a boundary; nothing is derived from it |

**Hapus** on a farm with live fields is refused with `409`: the server will not
orphan fields, and the message says the farm still has them. Delete the fields
first, or leave the farm.

### 4.2 A field

The name is capped at 100 characters, same as a farm's. `areaHa` is not an input
and cannot be set.

A field needs a polygon, and typing a GeoJSON ring is not a thing anyone does.
Two ways in, on the same form:

- **Draw it.** The frame is anchored by three numbers: latitude and longitude of
  the centre, and the side of the frame in kilometres (0.1–50). Click inside the
  frame to add a vertex, drag a vertex to move it, **Hapus titik terakhir** to
  remove the last one. Vertices are stored normalised, so changing the centre or
  the span keeps the shape you drew and re-anchors it.
- **Type it.** Open *Tanpa tetikus: tulis poligon* and write one point per line,
  longitude first then latitude. If the text box has content it replaces the
  sketch; the ring is closed automatically.

Limits, all refused rather than truncated: 200 vertices, 12 000 characters of
polygon text, a frame that would cross a pole or the antimeridian. A
self-intersecting ring is refused by PostGIS, not by the browser — the browser
draws what you drew and the server decides.

**Luas (ha)** is not typed. It is a stored generated column
(`ST_Area(geography) / 10000`), so it changes when the shape changes and never
otherwise. The table shows two decimals.

**Ubah** on a field prefills name and ring. An untouched ring is not re-sent: a
formatting-only difference (`106.8,-6.2` versus `106.8, -6.2`) is not a geometry
change and does not bump `updated_at`. Clear the text box to keep the current
shape.

**No map, no tiles, no projection.** The sketch frame is small enough that
degrees-per-kilometre is honest. If you need to see the parcel against a
basemap, that capability does not exist yet.

### 4.3 When the list fails to refresh

If a save succeeds but the reload fails, the page keeps the list it already has
and adds a note: *daftar gagal dimuat ulang; perubahan terakhir mungkin sudah
tersimpan*. It does not replace the page with an error, because that reads as
"your save failed".

---

## 5. Katalog (crop catalogue)

Read-only, two levels: crops, then one crop's cultivars with their rulebook
version history.

- A crop card shows the Indonesian name, the English name and the category.
- A cultivar shows the cycle length in days, whether the cycle starts at sowing
  or at transplant, and the nursery period when there is one.
- **Versi** lists each rulebook version with its `ruleVersion`, status (`draf`,
  `terbit`, `pensiun`), publication date, and a marker when it supersedes an
  earlier version. Clicking a row opens the version in place.

An opened version shows three things: growth stages (day offsets, which are
critical), thresholds (dimension, comparator and value, the stage it applies to,
the evidence grade, and whether it is a hard or soft constraint), and the
citations behind them.

Two things to read carefully:

1. **The grade is the point.** `A`–`D` is the evidence grade the research matrix
   assigns to that threshold — never a probability, and never a confidence the
   screen computed. It is shown per row rather than summarised, because a summary
   would let a weak threshold borrow a strong one's authority. What each grade
   means is `docs/research/agronomic-reference-matrix.md`.
2. **This is a rulebook, not a recommendation.** The footer of every version says
   so. Nothing on this screen has been applied to any field of yours.

If the catalogue is empty, the screen names the command that fills it
(`pnpm db:seed:catalog`). The seed runs as `migration_owner`, because catalogue
rows are global reference data and no runtime role may write them; it is not
something the interface can do, and it will not overwrite a published profile.

---

## 6. Iklim (climate)

Two horizons, one form. You choose a field, a provider/model pair, and which
horizon, then **Tampilkan**.

### 6.1 The grid pair is typed, not derived

The screen asks for `provider` and `model` as text, prefilled with the only pair
that answers today: `synthetic` / `synthetic_1deg_20x20`. This is not a
placeholder to be polite — the field → cell mapping has no writer, so the screen
shows the resolver's failure (`GRID_NOT_FOUND`) instead of guessing a cell from
the field's centroid.

A warning banner says the same thing: the production grid is unvalidated
(`OPEN-18`).

### 6.2 Horizon bulanan (12 months)

One row per month from the first materialised month, with the value in
millimetres and, on every row, the **data class** — `climatology`,
`weather_forecast`, `subseasonal_forecast`, and so on — plus freshness (`segar` /
`basi`), and the baseline version where one applies.

A month with no row is shown as a missing reason, not as zero. **A gap is not a
dry month.** Months are not interpolated from their neighbours, because a
climatology normal and a seasonal forecast are different claims and a line drawn
between them would be an invented one.

### 6.3 Horizon 0–45 hari

Two bands: `Harian (0–14)` and `Subseasonal (15–45)`. The **data class is per
band** — a band is one forecast class by construction. What is per day is the
provenance: the model that produced it, whether it is fresh or `basi`, and its
TTL on hover. One 45-day horizon can legitimately contain more than one model
run, which is why those labels sit on the day and not on the band.

Again: a day with no value is a gap with a reason, not 0 mm.

### 6.4 Why the classes are not decoration

`stale` means the row is past its TTL and a fresher run has not arrived. Reading
a stale forecast as current is the specific error the class exists to prevent.
Do not strip the tags when copying numbers out.

---

## 7. Errors you will see

| Message | Cause | What to do |
|---|---|---|
| `Tidak dapat menghubungi API` | Session check failed with something other than `401` | Check the API process and the base URL; this is not a login problem |
| `Alamat email sudah terdaftar.` | Registration on an existing email | Log in instead |
| A `409` after deleting a farm | The farm still has live fields | Delete the fields first |
| `GRID_NOT_FOUND` | The provider/model pair has no grid | Use `synthetic` / `synthetic_1deg_20x20` until `OPEN-18` |
| `daftar gagal dimuat ulang…` | A save worked, the reload did not | Reload the page; check what is actually stored before repeating the save |

Every API error carries a code, and validation errors carry the field paths that
failed. The screen does not print the server's message verbatim: it has its own
Indonesian wording for each code it can meet (`GRID_NOT_FOUND`, `CELL_NOT_FOUND`,
`FIELD_NOT_FOUND`, `CROP_NOT_FOUND`, `PROFILE_NOT_FOUND`, `UNAUTHENTICATED`,
`CONFLICT`, `VALIDATION_FAILED`) and falls back to the server's text only for a
code it does not know. A validation failure shows the **first** offending field,
not all of them, and the request id is appended when the server supplied one.
`docs/guides/api-reference.md` §7 lists the codes and statuses.

---

## 8. Not in the interface

Recorded so the absence is a decision rather than an oversight:

- No suitability or planting-window screen — no writer exists for those rows.
- No map view, tiles or basemap — no projection decision, no provider.
- No alerts, notifications or exports.
- No password reset, email verification or account deletion.
- No admin surface for the catalogue — it is seeded by a script run as the schema
  owner, and administering it is a database operation today.
- No read-only or shared link; every route requires a session.

Each of these is gated by a decision recorded in
`docs/IMPLEMENTATION_MASTER_ROADMAP.md` §14, not by missing UI work.
