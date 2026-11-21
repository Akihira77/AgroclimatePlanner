# Temporal and Weather Semantics

What every date and timestamp column means, which horizon each data class may
answer, and how "no data" is represented without becoming "no rain".

The two failure modes this document exists to prevent:

1. A monthly outlook rendered as if it were a daily forecast.
2. A missing value rendered as a number.

## 1. Column meaning, exhaustively

| Column | Type | Meaning | Never means |
|---|---|---|---|
| `valid_at` | `timestamptz(6)` | the instant the value describes | when we fetched it |
| `initialized_at` | `timestamptz(6)` | the model run's initialisation instant, UTC | the forecast's start date |
| `ingested_at` | `timestamptz(6)` | when we stored it | anything about the weather |
| `received_at` | `timestamptz(6)` | when we first had this **run** | when we re-fetched it |
| `horizon_end` | `timestamptz(6)` | the last instant this run covers | when the run becomes stale |
| `computed_at` | `timestamptz(6)` | when the engine/job produced the artifact | when it was last read |
| `observed_at` | `timestamptz(6)` | when a user's measurement was taken | when they typed it |
| `resolved_at` | `timestamptz(6)` | when a field→cell resolution was computed | when the cell's data arrived |
| `created_at` / `updated_at` | `timestamptz(6)` | row bookkeeping | provenance |
| `planted_at` | `date` | sowing or transplant **calendar day** | an instant |
| `window_start` / `window_end` | `date` | inclusive calendar days | instants |
| `month` | `date` | first day of a month, Asia/Jakarta | a range |
| `period_from` / `period_to` | `date` | baseline period bounds | validity |
| `harvested_at` | `date` | picking day | a timestamp |
| `accessed_at` | `date` | when a citation was retrieved | publication |

Rules:

- **No naive timestamps anywhere.** Every instant is `timestamptz(6)`, stored
  UTC. A `timestamp` column is a bug that surfaces only in a zone with a half-hour
  offset.
- **No instant for a calendar day.** `planted_at` is a day: a sowing at 23:50 and
  one at 00:10 are the same sowing to the duration model.
- **`initialized_at` is immutable.** Re-normalising payloads changes
  `normalizer_version` and therefore the `ingestion_runs` row; it must never
  change the run's initialisation time, because that is what a user-facing
  "initialized 5 November" refers to and what freshness is computed from.
- **`received_at` ≠ `ingested_at`.** A run may be re-ingested; when we first had
  it does not change.
- `updated_at` is maintained by the application, not a trigger (`OPEN-19`), so a
  raw SQL write must set it explicitly.

## 2. Calendar: Asia/Jakarta everywhere

Every calendar computation in this model — a planting window's start, a month
key, an agronomic day offset — is interpreted in **Asia/Jakarta (UTC+07:00, no
DST)**.

- `users.timezone` exists and is per-user, but v1 has one computation zone. A
  second zone would change what `window_start` means for a user who moves, and
  windows are stored as days, not instants, so the change would be silent.
- Month keys are `date` constrained to the first of the month
  (`EXTRACT(DAY FROM month) = 1`). `2026-11-01` is November 2026 in Jakarta.
  Storing `YYYY-MM` text or `YYYYMM` integer would sort wrong or validate
  nothing.
- `valid_at` from a provider is stored as the provider published it (UTC). The
  conversion to a Jakarta day happens **once**, when a daily or monthly aggregate
  is assembled — not at every read, because two conversions in different code
  paths is how a day lands in the wrong month.

## 3. Horizon map — which class may answer which day

This is the binding table. A value outside its class's band is a modelling bug,
not a display preference.

| Days from today | Permitted `dataClass` | Product / provider |
|---|---|---|
| 0–3 | `weather_forecast` | BMKG `prakiraan-cuaca` (gated), Open-Meteo deterministic |
| 4–14 | `weather_forecast` | Open-Meteo deterministic + `ecmwf_ifs025` ensemble |
| 15–45 | `subseasonal_forecast` | `ecmwf_ec46` (daily to 46 d, weekly stats to 42 d) |
| ~46 d – ~7 mo | `seasonal_forecast` | `ecmwf_seas5` (6 monthly rows by default, 7 if `forecast_days ≥ 200`) |
| ~8–13 mo | `annual_outlook` | ECMWF Set VII only (licence + GRIB PoC still pending) |

A month is an aggregate of days, so the monthly outlook uses a **1-based lead
month, `1–12` inclusive**. There is no lead month 0 and no lead month 13; exactly
twelve entries describe the horizon.

| Lead month | Covering day band | Permitted `dataClass` |
|---|---|---|
| 1–2 | starts inside days 0–45, but **crosses day 45** | `weather_forecast`, `subseasonal_forecast`, **or** `seasonal_forecast` — the class names the one product that supplied the month |
| 3–7 | beyond subseasonal, within seasonal | `seasonal_forecast` |
| 8–12 | beyond seasonal | `climatology` — the 1991–2020 normal, labelled as such |
| — | beyond 12 | no entry; there is no month 13 |

A calendar month is **not** a 30-day window. Lead month 1 starts at day 0 but a
31-day month still ends at day 30; lead month 2 runs from roughly day 30 to day
60, so it crosses the day 45 boundary and part of it can only be answered by the
seasonal product. The monthly class is therefore *not* the day band of its first
day, and it is not inferred from day counts at all.

**One product per month.** The class on a month names the single source product
that supplied that month's value, chosen by the documented order in
`climate-data-foundation.md` §5.5 rule 4 (live seasonal within TTL → subseasonal
→ climatology). Day bands may differ within the month; classes never blend,
because `monthly_outlooks` has one `data_class` column and one value. A month
assembled from more than one product is not representable and is not permitted
(`Q-P5-5` in `open-decisions.md`).

`leadMonth` is derived from the entry's `month` and the outlook's `firstMonth`
(pure calendar arithmetic, year rollover included); the contract stores the
calendar month, never a bare index. A forecast failure inside a band stays
`missing_reason = 'ingest_failed'` with no value — it never becomes climatology.

Derived rules:

1. **A 12-month outlook is never a daily forecast.** Lead months 8–12 are
   `climatology` and labelled as such; the UI string is "Normal historis
   (1991–2020)", never "prakiraan".
2. **Missing bands are stated, not filled.** If `ecmwf_ec46` fails for a cycle,
   days 15–45 are `missing_reason = 'ingest_failed'` — not silently promoted from
   the seasonal run and not silently dropped.
3. **`annual_outlook` requires Set VII.** No row may claim it from SEAS5, which
   ends at month 7. Availability of Set VII is unverified (licence enquiry + GRIB
   proof of concept pending), so in practice months 8–12 are climatology.
4. **BMKG is gated.** `BMKG_SHORT_RANGE_ENABLED` defaults off pending written
   permission; with it off, 0–3 d is Open-Meteo, which is correctly labelled
   `weather_forecast` and not "BMKG".
5. **Seasonal row count is asserted, not assumed.** SEAS5 returns 6 or 7 monthly
   rows depending on the pinned `forecast_days`; the count is checked on ingest so
   a truncated response is `partial`, never a 5-month "12-month outlook".

## 4. `dataClass` is per-value, `evaluationBasis` is per-container

| Axis | Scope | Values |
|---|---|---|
| `dataClass` | one value | the nine `WeatherDataClass` values |
| `evaluationBasis` | a container (window, outlook month) | `daily`, `weekly`, `monthly`, `climatology`, `mixed` |

`mixed` is legal only at container level. A single value carrying `mixed` is a
modelling bug, which is why `EvidenceSegment.evaluationBasis` uses the narrower
single-value enum: **a segment is one class by construction**, and `mixed` lives
on the window that contains several segments.

`primaryBasis` on a window is the basis over the **critical growth stage**, not
the longest segment and not the average. A window whose critical stage is judged
on climatology cannot be `suitable` — enforced by
`planting_windows_climatology_primary_check`.

## 5. Freshness — computed at read time, never stored

Staleness is a function of the clock and the source's initialisation time. Stored
freshness is a value that is correct once; the moment it is stored it begins
lying.

| Artifact | Freshness rule | Stale when |
|---|---|---|
| Forecast values 0–3 d | `initialized_at` age | > 6 h |
| Forecast values 4–14 d | `initialized_at` age | > 12 h |
| Subseasonal values | `initialized_at` age | > 48 h |
| Seasonal values | `initialized_at` age | > 35 d |
| Climatology | `baseline_version` age | baseline > 13 months old |
| `MonthlyOutlook` | derived from inputs; `oldestInputInitializedAt` **excludes climatology** | any non-climatology input stale |
| `PlantingWindow` | derived from the segments' sources | any segment's source stale |
| `AiBriefing` | invalidated by input **identity**, not a clock | any `inputRefs` entry changed |

Two rules that are easy to get wrong:

1. **Climatology contributes nothing to `oldestInputInitializedAt`.** There is no
   initialisation time to be old. Treating it as infinitely old would mark every
   month 8–12 outlook permanently stale and train users to ignore the flag.
2. **A derived artifact reports the set of stale roles, not a boolean.** "Seasonal
   stale, climatology fresh" and "both fresh" are different states and the UI
   says which source is behind.

The freshest-inputs-display rule follows: a window spanning days 5–30 mixes a
6-hour-old deterministic forecast with a 48-hour-old subseasonal one, and its
segments carry the difference. There is no single "updated 3 hours ago" for such
a window.

## 6. Missing data — five representations, distinguished

`WeatherRecord` (the value) and `MonthlyOutlook` (the presentation decision) use
different mechanisms on purpose.

### In `weather_records`

| Situation | Representation |
|---|---|
| provider published a value | `value` set |
| provider published `null` for an instant inside the run's horizon | row present, `value IS NULL` |
| instant outside the run's horizon | **no row** |
| run never ingested | **no run**, and `ingestion_runs.status` says why |
| ingest partially failed | `ingestion_runs.status = 'partial'`; the rounded `coverage_percent` may read 100, so the status is the authority |

The row-with-null versus no-row distinction is load-bearing: an ensemble that
returns nulls from day 15 tells you the horizon ended. That is `beyond_horizon`
evidence. An absent row is indistinguishable from "never asked", so it must not
be used for the same claim. Measured in Phase 1: 35 ensemble rows returned nulls
past day 14 — that is the horizon, not a fetch failure.

`value` is never interpolated, never filled forward, and never defaulted to 0. A
zero is a measurement (a dry day); absence is not.

### In `monthly_outlooks`

| State | `value_mm` | `data_class` | `missing_reason` |
|---|---|---|---|
| real forecast month | set | forecast class | `NULL` |
| horizon ends; climatology shown | set | `climatology` | `beyond_horizon` |
| climatology month with no forecast axis | set | `climatology` | `beyond_horizon` |
| ingest pending | `NULL` | `NULL` | `pending` |
| ingest failed / provider down | `NULL` | `NULL` | `ingest_failed` / `provider_unavailable` |
| cell not in scope | `NULL` | `NULL` | `not_requested` |
| baseline missing | `NULL` | `NULL` | `insufficient_history` |
| coverage too low to claim a month | `NULL` | `NULL` | `below_coverage_threshold` |

Two invariants of this table:

1. **A climatology substitution may only be labelled `beyond_horizon`.** The
   constraint `missing_reason <> 'beyond_horizon' OR data_class = 'climatology'`
   is the single most important one in the climate group: it makes "we showed
   climatology because our ingest failed" unrepresentable, because a failed
   ingest has no value at all.
2. **A climatology month carries no initialisation-derived anomaly.** It has a
   `baseline_version` and no `anomaly_kind`; an anomaly against climatology would
   be an anomaly of climatology against itself.

## 7. Anomaly semantics

`anomaly_kind` has exactly two values:

| Kind | Comparison base | Required disclosure |
|---|---|---|
| `model_anomaly` | the same model's own climatology | none — it is internally consistent |
| `baseline_difference` | an observational baseline (ERA5/CHIRPS 1991–2020) | `model_climate_offset_mm` **and** `baseline_version` |

`model_anomaly` is primary because SEAS5's implied climatology at Jakarta is
~35 % wetter than ERA5 for November (297.6 mm vs 220.5 mm). That offset is a
model property, not a forecast signal, and a naive difference would present it as
a 35 % wet anomaly every November. The offset is stored and disclosed only when a
`baseline_difference` is actually shown.

`bias_corrected` is `false` everywhere, enforced by a `CHECK`. v1 never corrects a
model value; a `true` would be an unimplemented claim shipped in a provenance
record.

## 8. Lead-time and duration columns

- Durations are `integer` with the unit in the name (`_days`, `_m`, `_mm`), never
  a text interval and never a float.
- Growth stage offsets are `start_day_offset`/`end_day_offset`, inclusive days
  from the cycle start, `0 ≤ start ≤ end`.
- `duration_days_min ≤ typical ≤ max` is a constraint
  (`cultivars_duration_order_check`), because a "typical" outside its own range
  makes every window critique meaningless.
- **`expectedHarvestAt` is not stored.** It is `planted_at + duration_days_*`,
  computed at read time; storing it would create a second answer that goes stale
  the moment a cultivar's duration is corrected.
- Harvests are per picking event (many per planting), so a planting has no single
  harvest date.

## 9. Time zone edge cases that are decisions

| Case | Decision |
|---|---|
| a provider timestamp with no zone | rejected at the adapter boundary; a provider that does not say is not silently assumed UTC |
| a `date`-only provider value | interpreted as a Jakarta day, not UTC midnight |
| DST | not applicable in Asia/Jakarta; this is why the model can use `date` at all |
| a window ending on the 31st | inclusive; `window_end >= window_start`, and a one-day window is legal |
| a month key for a 12-month outlook crossing a year | `date` arithmetic; no `YYYYMM` overflow |
| two runs initialised in the same hour | distinct rows only if `initialized_at` differs; the natural key includes it, so a provider republishing the same init is the same run |
