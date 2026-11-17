# Weather Source Matrix

Phase 0 deliverable. Evidence date: **2026-11-18**. Probe location: Jakarta (`-6.2, 106.8`).
Status legend: **observed** = live HTTP request made and payload inspected; **doc** = provider documentation statement; **inferred** = reasoned conclusion, not directly verified.

Anything not verified is marked. No provider is claimed accurate — accuracy is unverified until Phase 9 verification runs.

---

## A. Short-range / current (0–16 days)

### A1. BMKG — Prakiraan Cuaca Desa

| Field | Value |
|---|---|
| Endpoint | `GET https://api.bmkg.go.id/publik/prakiraan-cuaca?adm4=<kode wilayah IV>` |
| Horizon | 3 days (**doc** verbatim: "waktu 3 harian"); **observed** 3 day-groups, 17 slots total covering `2026-11-18 05:00 → 2026-11-20 05:00` — i.e. **~48 h plus a partial third day**, slot local hours 05/08/11/14/17/20/23 = **7 slots/day** |
| Temporal res | 3 hourly |
| Spatial | village / kelurahan point (`lokasi.lat`, `lokasi.lon`), village-centroid |
| Coverage | all Indonesian desa/kelurahan, keyed by Kepmendagri 100.1.1-6117/2022 adm4 code |
| Update | 2×/day (`analysis_date` 00/12 UTC — **observed**) |
| Variables | `t` °C, `tp` mm, `hu` %, `ws` kt?, `wd`/`wd_deg`/`wd_to`, `tcc` %, `weather` code, `weather_desc` (id), `vs` visibility, `image` icon URL |
| Auth | none |
| Rate limit | **doc**: 60 requests/minute per IP |
| Licensing | attribution mandatory; commercial integration requires written permission — see `data-licensing-and-attribution.md` |
| Feasibility | **point-queryable API.** Best available local ground-truth-shaped forecast. `tp` present but undocumented in the key table — treat as supported-but-thin contract |
| Role in product | local short-range layer + human-recognisable reference; never the climate engine |

Unknowns: `adm4` master list is not published by BMKG; community mirrors of Kepmendagri exist but were not audited (**inferred**). Wind speed unit not documented — must be determined empirically before display.

### A2. Open-Meteo — Forecast API

| Field | Value |
|---|---|
| Endpoint | `GET https://api.open-meteo.com/v1/forecast` |
| Horizon | `forecast_days` 0–16 enforced server-side (**observed** error text) |
| Temporal res | 1 h / 3 h / daily |
| Spatial | model grid snap; request `-6.2,106.8` served `-6.221,106.781`, elev 15 m (**observed**) |
| Update | per model, hourly–6 hourly (**doc**) |
| Variables observed | `precipitation_sum`, `temperature_2m_max`; full catalogue includes humidity, wind, gust, radiation, ET₀, soil temp/moisture, weather code (**doc**) |
| Auth | none (free tier) / API key (paid) |
| Rate limit | free: 600/min, 5000/h, 10 000/day, 300 000/month (**doc**, verbatim from Terms) |
| Licence | data CC BY 4.0 + Open-Meteo attribution (**doc**) |
| Feasibility | **point-queryable API**, trivial integration, merges many NWP models |
| Role | backbone of 0–16 day layer; ensemble for uncertainty |

### A3. Open-Meteo — Ensemble API

| Field | Value |
|---|---|
| Endpoint | `ensemble-api.open-meteo.com/v1/ensemble` |
| Verified model | `ecmwf_ifs025` → 200 |
| Member count | **50 members** (`precipitation_sum_member01..50`) + ensemble-mean column |
| Horizon | **14 days.** `forecast_days=35` returns 35 rows but all values are `null` from day 15; last non-null = `2026-12-01` (day 14). Verified 2026-11-18 |
| Role | probability/uncertainty for **4–14 d only**. Days 15–45 are EC46 |

---

## B. Subseasonal (16–46 days)

### B1. ECMWF EC46 — via Open-Meteo seasonal API

| Field | Value |
|---|---|
| Endpoint | `seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_ec46` (**observed 200**) |
| Horizon | 46 days (**observed** daily series to `2027-01-01`; **doc** 46 d) |
| Spatial res | 36 km O320 (**doc**) |
| Temporal res | 6-hourly native (**doc**) |
| Ensemble | 100 members + 1 control at ECMWF (**doc**); **observed payload = 50 members + mean** for the daily product; weekly statistics use all 100 (**doc**) |
| Update | daily, ~20:30 UTC (**doc**) |
| Variables | as SEAS5 plus EFI/SOT; soil moisture/soil temp/wind gusts/showers limited to 46 d (**doc**) |
| Bias correction | none (**doc**) |
| Licence | CC BY 4.0 + ECMWF attribution (**doc**) |
| Role | month 1–2 detail, weekly anomaly strips |

Note: raw EC46 gridded fields are **not** in ECMWF Open Data (**doc**); Open-Meteo is the documented low-friction route.

---

## C. Seasonal (2–7 months)

### C1. ECMWF SEAS5 — via Open-Meteo seasonal API

| Field | Value |
|---|---|
| Endpoint | `seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_seas5` (**observed 200**) |
| Horizon | 7 months max (**doc**); **observed** `forecast_days=200` → daily `2026-11-17 … 2027-06-04`, 50 members + mean |
| Monthly aggregation | **observed** `monthly=…` with **no** `forecast_days` → **6 rows** (`2026-11 … 2027-04`); with `forecast_days=217` → **7 rows** (`… 2027-05`). Server cap on `forecast_days` is **217** |
| Values observed (Jakarta) | precip mean 247.6, 336.4, 367.6, 335.7, 340.3, 332.8, 225.1 mm (non-monotonic); anomaly −50.0 … +102.0 mm; t2m 27.6–28.2 °C |
| Implied model climatology | Nov 297.6 mm, Dec 261.7, Jan 289.4, Feb 271.2, Mar 272.9, Apr 230.8 — **systematically wetter than ERA5** (Nov 220.5 mm, +35 %). This bias is why model-relative and baseline-relative anomalies disagree in sign; see ADR-001 D3 |
| Spatial res | 36 km O320 (**doc**) |
| Ensemble | 51 claimed (**doc**); **50 members in payload** + 1 mean. Weekly EC46 statistics use 100 members |
| Update | monthly, on the **5th** (**doc**) |
| Anomaly basis | forecast − **model** climatology (20–30 y hindcast of same system) — **not** station normals (**doc**) |
| Bias correction | none (**doc**) |
| Role | months 2–7 seasonal layer; weekly/monthly aggregates preferred over daily |

Caveat that must reach the UI: a SEAS5 "anomaly" is model-relative. Showing it as "your field will get 100 mm below normal" without recomputation against a station-grade baseline is scientifically wrong. Product rule: display SEAS5 anomaly as *model anomaly*, and compute the user-facing anomaly against the ERA5/CHIRPS 1991–2020 baseline, labelled as such.

### C2. ECMWF Annual outlook (13 months)

**Verified as a product, not as data.** ECMWF states annual forecasts extend 13 months (**doc**, seasonal documentation page). Access found: charts only (`charts.ecmwf.int/.../seasonal_system5_nino_annual_plumes`), no free gridded point feed, not in ECMWF Open Data, not in the C3S seasonal CDS datasets (which stop at 7 months).

**Consequence:** months 8–12 cannot be served from a genuine forecast at farm point. See §E.

---

## D. Historical observation / reanalysis

| Dataset | Res | Period | Access | Licence | Verified |
|---|---|---|---|---|---|
| ERA5 (CDS) | 0.25° hourly | 1940–present | CDS API | Copernicus Licence, commercial OK, attribution required | **observed** via Open-Meteo archive from `1940-01-02` → 200 |
| ERA5-Land | 0.1° hourly | 1950–present | CDS API | same | **doc** |
| CHIRPS v3.0 | 0.05° daily+monthly | 1981–near-present | HTTP/FTP, GEE | public domain / CC0 | **doc** (v3 release 2025); **host `data.chc.ucsb.edu` timed out from this environment (2026-11-18) — reachability unconfirmed** |
| NASA POWER | 0.5°×0.625° daily/monthly | 1981–present | REST point API, `community=AG` | NASA open, free | **observed** response for 1991–1993 monthly, keys `YYYYMM` |
| GPM IMERG V07 | 0.1° | 2000–present | GES DISC, GEE | US Gov, effectively public domain | **doc** |
| BMKG station history | station | varies | request/PPID only | commercial needs permission | **doc/inferred** |

Chosen defaults (rationale in ADR-001):
- **Climatology baseline 1991–2020 monthly rainfall → CHIRPS v3.0 in principle** (0.05°, public domain, covers Indonesia, station-blended). **Operational caveat:** `data.chc.ucsb.edu` timed out on 2026-11-18, so the reachable path must be confirmed (direct host, mirror, or Google Earth Engine) before CHIRPS can be the shipped default. Until confirmed, the engine must run on ERA5 monthly from the Open-Meteo archive API (verified reachable, 1940→present), with CHIRPS as a pluggable preferred baseline.
- **Temperature baseline → ERA5-Land** (0.1°) where reachable; ERA5 0.25° via Open-Meteo archive as the default implementation.
- **Verification ground truth (Phase 9) → CHIRPS v3 final/reanalysis** daily; IMERG Final is unusable operationally (≈3.5 month latency).
- ERA5/ERA5-Land precipitation is **not** independently downscaled in ERA5-Land — finer grid ≠ better rain.

Known bias caveats (documented in literature, not measured by us): reanalysis under-represents intense convective/MCS rainfall in the maritime continent (reported ~25–34% in some regions); gridded products smooth orography, so >1000 m volcano slopes carry the largest point error; Indonesian gauge exchange into global networks is sparse, so "gauge-corrected" blends are weakly constrained. **All of this is unverified locally until Phase 9.**

---

## E. The 12-month composition actually achievable

| Month index | Source | Data class | Precision offered |
|---|---|---|---|
| 0–3 days | BMKG (7 slots/day, ~48 h + partial) + Open-Meteo deterministic | forecast only — **no observation provider exists** | daily, ~3-hourly |
| 4–14 days | Open-Meteo deterministic + IFS ensemble (50 members) | short-range forecast | daily + spread |
| 15–45 days | EC46 daily (50 members); weekly stats ≤42 d (100 members) | subseasonal | daily to day 45, weekly otherwise |
| Months 2–7 | SEAS5 monthly mean + anomaly | seasonal | **monthly only** |
| Remaining months up to 12 | ERA5 (or CHIRPS when reachable) 1991–2020 climatology | **climatology** | monthly only |

The number of seasonal months is 6 by default and 7 when `forecast_days≥200`; the climatology tail is therefore 6 or 5 months respectively, and the adapter must pin the request and assert the split.

No annual outlook in the timeline. If BMKG cooperation is obtained, BMKG monthly probabilistic products may be added as a **separately labelled** national reference layer — never merged silently.

---

## F. Products explicitly rejected or deferred

| Product | Verdict |
|---|---|
| BMKG monthly/seasonal rainfall as structured point data | **not available**; map PNG + narrative HTML only; scraping prohibited by ToU §8.1 |
| BMKG ZOM / awal musim as data | documents only; no downloadable zone table |
| BMKG ENSO/IOD indices | dashboard/bulletin text only; use NOAA/BOM indices if needed (**inferred** alternative, unverified) |
| ECMWF Open Data for seasonal | seasonal products "not yet available" in ODP (**doc**) |
| CFSv2 via Open-Meteo seasonal | model id rejected (`400`) — not offered |
| Any 12-month daily forecast | does not exist; will not be fabricated |

---

## G. Implementation risks

1. **Open-Meteo free tier forbids commercial use** (verbatim in Terms). A paid plan or self-hosting decision is required before launch — see ADR-001.
2. **BMKG requires written permission for commercial integration** (ToU §9.3). Attribution alone is not sufficient.
3. SEAS5 refreshes monthly; EC46 daily. A "fresh" 12-month view legitimately mixes a 0–31 day old seasonal run with a same-day subseasonal run. Freshness must be per-source, not global.
4. Open-Meteo cell snapping differs per endpoint and returns an **interpolated point**, not a cell identifier: one request at `-6.2,106.8` served `-6.323185/106.68874` (seasonal, 36 km), `-6.221441/106.78094` (ERA5, 0.25° ≈ 28 km — **not** 9–11 km, which is ERA5-Land), and `-6.25/106.75` (IFS ENS) — up to **15.2 km apart**. Differencing a 36 km area mean against a 0.25° value 15 km away is not a like-for-like comparison; the baseline must be area-averaged over the model cell before computing any anomaly.
5. `tp` in BMKG payload is undocumented; do not build logic that assumes guaranteed presence.
