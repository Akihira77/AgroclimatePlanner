# Forecast Horizon Capabilities

Status: Phase 0 evidence log.
Date: 2026-11-18.
Every number below was verified by direct HTTP request from a WSL2 machine in Indonesia on 2026-11-18, unless marked **[doc]** (taken from provider documentation) or **[unverified]**.

Test location for probes: Jakarta, `latitude=-6.2&longitude=106.8`.

What code depends on this log (Phase 5.1): the SEAS5 monthly adapter pins the exact
values recorded in §2 — `models=ecmwf_seas5`, `monthly=precipitation_mean`,
`forecast_days=217` — and refuses a six-row answer. The adapter's tests use
**synthetic** payloads that reproduce this log's shape and row counts, never a
recording, so no test depends on the network. Any revision to the numbers below
requires an adapter change, which is the point of citing them here.

---

## 1. Verified provider limits

### BMKG — `api.bmkg.go.id/publik/prakiraan-cuaca`

| Property | Observed value |
|---|---|
| Endpoint | `GET https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=<code>` |
| HTTP status | `200` for `adm4=31.71.01.1001` (Gambir) |
| Granularity required | village level `adm4` (14-char style `PP.KK.CC.DDDD`). `adm3` (`31.71.01`) returned `404 {"error":"Data cuaca tidak ditemukan"}` |
| Response shape | `{ data: [ { lokasi: {...}, cuaca: [ [slot, ...], ... ] } ] }` |
| Slots observed | 3 day-groups, 17 time slots total |
| Time coverage observed | `2026-11-18 05:00` → `2026-11-20 05:00` local (≈72 h) |
| Slot step | ~3 h at local 05/08/11/14/17/20/23 |
| Variables | `t`, `tp`, `hu`, `ws`, `wd`, `wd_deg`, `wd_to`, `tcc`, `weather`, `weather_desc`, `weather_desc_en`, `vs`, `vs_text`, `image` |
| Forecast init | `analysis_date` present per slot (e.g. `2026-11-17T12:00:00`) |
| Point vs area | point at village centroid (`lokasi.lat/lon`); no polygon query |

Consequence: BMKG gives **0–3 days only**, deterministic, single-value, no ensemble. It cannot support 4–15 d, subseasonal, or seasonal.

### Open-Meteo standard forecast — `api.open-meteo.com/v1/forecast`

| Property | Observed value |
|---|---|
| Max horizon | `forecast_days` allowed range **0–16** (server error text: `Forecast days is invalid. Allowed range 0 to 16. Given 400.`) |
| Daily variables verified | `precipitation_sum`, `temperature_2m_max` |
| Timezone handling | `timezone=Asia%2FJakarta` honoured (`utc_offset_seconds: 25200`) |
| Grid snap | requested `-6.2/106.8` → served `-6.221441/106.78094`, elevation 15.0 m |
| Model list | ECMWF IFS 0.25°/0.4°, ICON, GFS, JMA, MET Norway, etc. **[doc]** |

### Open-Meteo ensemble — `ensemble-api.open-meteo.com/v1/ensemble`

| Property | Observed value |
|---|---|
| Verified model id | `ecmwf_ifs025` → `200` |
| Member count | **50 members** (`precipitation_sum_member01..member50`) + 1 ensemble-mean column = 51 precipitation columns, 52 total keys |
| Invalid model | `models=invalid` → `400 Cannot initialize MultiDomains from invalid String value invalid` |
| **Effective horizon** | **14 days.** `forecast_days=35` returns 35 date rows, but **every value is `null` from day 15**; last non-null day observed = `2026-12-01` (day 14). Same truncation at `forecast_days=16` and `30` |
| Correction | An earlier version of this file recorded "35 days returned" from the row count alone. Row count is not data. Any horizon claim must state the last non-null index |

### Open-Meteo seasonal — `seasonal-api.open-meteo.com/v1/seasonal`

| Property | Observed value |
|---|---|
| Working model ids | `ecmwf_ec46`, `ecmwf_seas5`, `ecmwf_ifs`, `ecmwf_ifs025` (last two accepted by the domain union) |
| Non-existent ids | `ecmwf_seasonal`, `cfsv2` → `400` |
| Default horizon **[doc]** | 6 months by default, **up to 7 months** |
| Horizon requires an explicit parameter | **observed**: with no `forecast_days`, the monthly axis returns **6 rows** (`2026-11 … 2027-04`); with `forecast_days=217` it returns **7 rows** (`… 2027-05`). The 12-month grid's forecast-vs-climatology split is therefore a function of a request parameter that must be pinned in the adapter |
| Server cap | `forecast_days` allowed range **0–217** (server-enforced) |
| Daily request `forecast_days=200` | `200`, range `2026-11-17 … 2027-06-04`, 52 columns (time + mean + **50 members**) |
| **EC46 daily, probed 2026-11-23** (`models=ecmwf_ec46&daily=precipitation_sum&forecast_days=46`, `-6.2/106.8`) | `200`, 16 782 bytes, **46 daily rows** `2026-11-23 … 2027-01-07`, unit `mm`, columns `precipitation_sum` + `precipitation_sum_member01..member50`. **The last row (lead day 45) is `null` in every column** — 45 of 46 days carry values. Coverage ends *inside* the axis, so `forecast_days=46` is the request that makes day 45 addressable, not a promise that day 45 has a value |
| **EC46 default timezone** | the probed request carried no `timezone` parameter and reported `timezone: "GMT"`, `utc_offset_seconds: 0`; `time[0]` was the request date. The adapter pins no `timezone` and asserts `time[0]` equals the request day in UTC, so index == lead day is verified rather than assumed |
| **EC46 served coordinate** | requested `-6.2/106.8` → served `-6.323185/106.68874`, which is **not** the requested point and is not a grid node: the same 5.5 rule applies (compare the served coordinate with the validated node, never assume the answer is the ask) |
| **EC46 mean vs members** | the mean column is a separate key from the 50 members and is **excluded** from the stored series; only the 50 real members are persisted, so spread stays genuinely derivable and no derived statistic can later be mistaken for an observation |
| **SEAS5 daily members, probed 2026-11-23** (`models=ecmwf_seas5&daily=precipitation_sum&start_date=2026-11-01&end_date=2027-05-31`, `-6.2/106.8`) | `200`, 64 477 bytes, **212 daily rows** (the seven calendar months of the run window), unit `mm`, columns `precipitation_sum` + `precipitation_sum_member01..member50`. The range form is the usable one: `forecast_days` anchors the axis on the request day, which is not the first day of the initialization month; `start_date`/`end_date` anchor it on the run's own months. Members are **not** exposed by the monthly axis |
| **SEAS5 daily mean vs members** | the daily `precipitation_sum` column is **not** the mean of the 50 members (191 of 193 fully-populated days disagreed by more than 0.06 mm at `2026-11-23`). The adapter never reads it as a member or as a monthly mean; only the members are aggregated, and the provider's monthly `precipitation_mean` is stored as its own row |
| **SEAS5 members reconcile with the monthly product** | mean of the 50 per-member monthly sums vs the provider's `precipitation_mean` for 2026-11 … 2027-05: ratios **0.989–1.011** (the provider's 0.1 mm rounding). This is the evidence that the daily members and the monthly quantity describe the same thing, and the basis for per-member monthly aggregation at ingest (ADR-001 D8b) |
| **SEAS5 partial months** | the daily axis ends cleanly at the last day of the seventh month for a range request (212 non-null rows for Nov–May); no partial trailing month is served, so an aggregate that is short a day is a provider change, not the normal horizon edge |
| Ensemble size **[doc]** | 51 members claimed for SEAS5 and EC46; **payload delivers 50 members + 1 mean**. Weekly EC46 statistics use 100 members |
| Monthly product | **SEAS5 only** — `models=ecmwf_ec46&monthly=…` returns **0 rows** |
| EC46 horizon / update **[doc]** | 46 days, updated daily ~20:30 UTC |
| SEAS5 horizon / update **[doc]** | 7 months, updated **monthly, on the 5th** |
| EC46 resolution **[doc]** | 36 km O320, 6-hourly |
| SEAS5 resolution **[doc]** | 36 km O320, 6-hourly |
| Monthly vars verified | `monthly=precipitation_mean,precipitation_anomaly,temperature_2m_mean` with `forecast_days=210` → 7 monthly rows `2026-11 … 2027-05` |
| Anomaly basis **[doc]** | forecast − **model** climatology (20–30 y hindcast of the same system), not station climatology |
| Ensemble spread | **no monthly spread variable** — `precipitation_spread`, `precipitation_ensemble_spread`, `temperature_2m_spread` all rejected `400` on 2026-11-18. Spread must be computed from the **50 daily members** (verified 2026-11-23; the payload delivers 50, not 51) |
| Bias correction | none — "dataset is currently provided without bias adjustment" **[doc]** |
| EFI / SOT | available from EC46 **[doc]** |
| Variables limited to 46 d **[doc]** | soil moisture, soil temperature, wind gusts, showers, snow, wave vars (EC46 only) |

### Open-Meteo historical / archive — `archive-api.open-meteo.com/v1/archive`

| Property | Observed value |
|---|---|
| Earliest date tested | `1940-01-02` → `200` (ERA5 back-extension) |
| Daily variable verified | `precipitation_sum` |
| Backing dataset **[doc]** | ERA5 / ERA5-Land reanalysis |

### Open-Meteo historical forecast — `historical-forecast-api.open-meteo.com/v1/forecast`

| Property | Observed value |
|---|---|
| Verified model id | `ecmwf_ifs04` → `200` for `2024-01-01 … 2024-01-03` |
| Purpose | archived past forecasts → enables forecast verification and lead-time skill analysis |

### NASA POWER — `power.larc.nasa.gov/api/temporal/monthly/point`

| Property | Observed value |
|---|---|
| Request | `parameters=PRECTOTCORR,T2M&community=AG&start=1991&end=1993` |
| Response | `200`, Feature JSON, monthly keys `YYYYMM` + annual `YYYY13` |
| Data start **[doc]** | 1981-01-01 |
| Spatial resolution **[doc]** | 0.5° × 0.625° |

---

## 2. Horizon map for this application

| Requested range | Genuine available data | Resolution | What the UI may claim |
|---|---|---|---|
| 0–3 days | BMKG forecast (7 slots/day) + Open-Meteo deterministic | ~3 h (BMKG), 1 h / daily (OM) | **Forecast** — there is no observation feed; see §3.1 |
| 4–14 days | Open-Meteo deterministic **and** IFS ensemble (50 members, spread real) | daily | Daily forecast with ensemble spread, skill caveat |
| 15–45 days | EC46 via seasonal endpoint (`ecmwf_ec46`): 46 daily rows, 50 members, data through day 45; weekly statistics available to **42 days** (100 members) | 6 h raw → daily/weekly | **Subseasonal** — weekly or daily-with-caveat, anomaly only |
| 2–7 months | SEAS5 (`ecmwf_seas5`) monthly mean + anomaly | 6 h raw → **monthly only** | **Seasonal**, monthly, probabilistic, no daily claim |
| 8–12 months | **No genuine forecast** — ERA5 (or CHIRPS if reachable) 1991–2020 climatology | monthly | **Climatology baseline** — never labelled forecast |
| Any range, "annual outlook" | **ECMWF Set VII (13 months, months 8–13) exists** — GRIB, quarterly, monthly means/anomalies per member; **access route unverified, not in Open Data, no point API** | monthly | Not offered until a licence enquiry + GRIB proof-of-concept succeed (ADR-001 D2a). Until then months 8–12 are climatology |

Deleted from the previous version of this table: a "16–35 days | Open-Meteo ensemble" band (no data past day 14) and "dekadal derived" SEAS5 aggregation (not derivable from a monthly mean).

### Rolling 12-month composition (default)

```
days 0..3       → BMKG + Open-Meteo deterministic (forecast, not observation)
days 4..14      → Open-Meteo deterministic + IFS ensemble (50 members)
days 15..45     → EC46 daily / weekly (50 / 100 members) — subseasonal
months 2..7     → SEAS5 monthly mean + anomaly (7 rows only when forecast_days≥200)
months 8..12    → climatology 1991–2020, explicitly labelled "Normal historis (1991–2020)"
```

The seasonal/climatology split is **6 or 7 months depending on the pinned `forecast_days`**, so the boundary must be an asserted property of the adapter, not a comment. Daily rows extend past the monthly product (to 2027-06-05 at 200 days); the monthly axis is authoritative for the seasonal layer, and June 2027 must not be rolled up as a seasonal month.

Every month record must carry `dataClass` (the 9-value enum from ADR-001 D9) plus `evaluationBasis` and `dataAvailability`. Mixing classes inside one value is prohibited at storage and at render time.

---

## 3. Hard constraints derived from the evidence

1. **BMKG cannot be the backbone.** 3 days, village points only, no probability. It is a *validation and local-trust layer*, not the 12-month engine.
2. **No free verified annual outlook exists at farm-point level.** Months 8–12 are climatology, by necessity, and must say so.
3. **SEAS5 refreshes once a month (5th).** A "live" 12-month view will legitimately show a 1–31 day old seasonal initialization. Freshness must be shown, not hidden.
4. **Anomalies are model-climatology anomalies.** They are not anomalies against local station normals. Displaying them as "X mm below normal for your field" without a caveat is a scientific error. The platform must either (a) label them as model-relative, or (b) recompute anomaly against the ERA5 1991–2020 baseline and label the method.
5. **6-hourly native seasonal data must not be rendered as daily weather.** SEAS5 floor is **monthly** — a dekadal value cannot be derived from a monthly mean without inventing a within-month distribution. EC46 daily is legitimate but only to day 45 (42 for weekly statistics), and it is subseasonal, not "weather".
5b. **No observation source exists.** `observation` appears in the temporal-class enum because the domain needs it, not because a provider was found. BMKG 3-day is a forecast; ERA5 is reanalysis with multi-day latency. Phase 1 must either populate `<1 day` cells from ERA5-Land preliminary with an explicit reanalysis label, or remove `observation` from the enum until a provider is verified.
6. **Grid snapping changes the point.** Requests at 36 km (seasonal) vs 0.25° ≈ 28 km (ERA5) vs village centroid (BMKG) land on different cells and return **interpolated points**, not cell identifiers. Store requested *and* served coordinates per record, and never difference values from different endpoints without area-averaging to a common cell.
7. **16-day cap is a server-enforced limit**, not a documented suggestion. Do not plan a 30-day daily view on the standard endpoint.

---

## 4. Validation scope (what these probes do NOT prove)

All probes were run at **one point: Jakarta (`-6.2, 106.8`)**. Nothing here demonstrates that any provider is adequate at a real farm plot.

Not validated, and therefore not claimable:
- Behaviour at plots on volcanic slopes, narrow valleys, or coasts where a 28–36 km cell averages away the signal.
- Which grid cell a specific plot maps to, and how far the served interpolated point is from the plot.
- BMKG village (`adm4`) resolution correctness for non-Jakarta desa.
- Seasonal/hindcast behaviour at any second location.
- Any accuracy claim whatsoever — accuracy is Phase 9, not Phase 0.

Required before a provider is called "validated for local use": repeat the probe suite at a set of real plot coordinates spanning altitude and coastline, record served-vs-requested distance and elevation delta per point, and keep the raw responses.

## 5. Open questions carried to Phase 4

- Does BMKG publish a machine-readable probability product for monthly rainfall? (Phase 0 scope: appears PNG-map only — confirmed in `weather-source-matrix.md`.)
- Is there any lawful, point-queryable Indonesian national rainfall observation series for bias correction? **[unverified]**
- Does the ECMWF/C3S route give access to SEAS5 hindcasts for local calibration without a paid plan? (deferred to ADR-001 follow-up)
- Actual measured skill of SEAS5 over the maritime continent for monthly rainfall — cannot be asserted without running verification (Phase 9).
