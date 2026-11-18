# ADR-001 — Weather Data Provider Strategy

- Status: **Proposed** (Phase 0, awaiting review)
- Date: 2026-11-18
- Deciders: project owner + orchestrator; to be challenged in Phase 1 review
- Supersedes: none

## Context

The product must deliver a rolling 12-month climate outlook at farm-plot coordinates in Indonesia, with strict separation of observation / short-range / subseasonal / seasonal / climatology, and with provenance. Every data layer must be legally usable, technically reachable, and honest about what it does not provide.

Evidence gathered 2026-11-18 (`weather-source-matrix.md`, `forecast-horizon-capabilities.md`, `data-licensing-and-attribution.md`):

- BMKG publishes a 3-day village forecast API only, with strict terms; all monthly/seasonal products are maps and documents, emitted through a Tableau dashboard, and site-scraping is prohibited.
- Open-Meteo is the only documented low-friction point API for ECMWF EC46 (46 d) and SEAS5 (7 months), with 51-member ensembles.
- Open-Meteo's free tier explicitly forbids commercial use.
- ECMWF publishes an annual outlook extending 13 months, but only as charts — no free gridded point feed. C3S seasonal datasets stop at 7 months.
- CHIRPS v3.0 (0.05°, from 1981, public domain) is the strongest climatology and verification baseline available for Indonesian points.
- No provider offers a genuine 12-month daily forecast. None ever will.

## Decision

**D1. Open-Meteo is the forecast plumbing; ECMWF is the forecast authority.**

Use Open-Meteo as the transport for ECMWF model data across all horizons:

| Layer | Source | Aggregation floor | Verified limit |
|---|---|---|---|
| 0–3 d | BMKG (gated) + Open-Meteo deterministic | hourly/daily | BMKG 7 slots/day, ~48 h + partial |
| 4–14 d | Open-Meteo deterministic + IFS ensemble (50 members) | daily | ensemble values are `null` after day 14 |
| 15–45 d | EC46 via seasonal API | daily to 45, weekly ≤42 | no monthly EC46 product |
| Months 2–7 | SEAS5 via seasonal API | monthly | 6 rows by default, 7 if `forecast_days≥200`; cap 217 |

No daily rendering of EC46 beyond day 45 or of SEAS5 at all.

**D2. Months 8–12 default to climatology, with one documented escape hatch.**

Baseline: **1991–2020**, WMO normal period. Preferred dataset CHIRPS v3.0 monthly rainfall; **implemented fallback ERA5 monthly via the Open-Meteo archive API**, because the CHIRPS bulk host was unreachable from the target environment on 2026-11-18 and was not confirmed by the provider. The baseline dataset is a configurable, named property of every climatology record, and the UI names it.

**D2a. ECMWF Set VII (Seasonal 13-month forecast, forecast months 8–13) is real and must not be dismissed.** Verified on ECMWF's dataset page 2026-11-18: quarterly production (Feb/May/Aug/Nov, disseminated on the 5th at 12:00 UTC), GRIB, monthly means of ensemble means, monthly mean anomalies, monthly means and anomalies per ensemble member, plus 6-hourly/24-hourly individual runs. Units note from that page: monthly `tp` is a **rate in m/s**, not mm — conversion depends on calendar month length and parameter definition.

What is **not** verified: how a third party obtains it. It is not in ECMWF's Open Data portal, and no free point API is documented. Until a licence enquiry and a GRIB proof-of-concept (fetch → parse → cell extraction → member count → variable audit) succeed, months 8–12 remain climatology. If they succeed, months 8–12 become a genuine — quarterly-refreshed, therefore up to ~3 months stale — labelled `annual_outlook` class, and the timeline gains a real 13-month reach. This is a Phase 4 research task, not a Phase 1 assumption.

**D3. Anomalies are computed twice and labelled — model-relative is the primary number.**

Evidence forced a reversal of the original decision. Measured at Jakarta 2026-11-18, the model's implied seasonal climatology is systematically wetter than ERA5 (Nov 297.6 mm vs 220.5 mm, **+35 %**), so a "forecast minus observed baseline" anomaly is contaminated by a bias as large as the signal: November flips from **−50.0 mm** (model-relative) to **+27.1 mm** (ERA5 baseline) to **+52.0 mm** (NASA POWER baseline), and February flips too.

- `modelAnomaly` — **primary, user-facing.** SEAS5 value minus the model's own climatology, as delivered. This removes the *mean* model-vs-baseline offset; it does **not** mean the forecast is unbiased, skilful, or locally representative. Seasonal-, lead-time- and regime-dependent errors survive. `biasCorrected` therefore stays `false` and `modelSkill` stays `null` until verification exists.
- `baselineAnomaly` — **secondary, conditional.** Monthly aggregate minus the observed baseline, permitted **only** when (a) the baseline has been area-averaged over the model grid cell, and (b) the measured model-vs-baseline climate offset is disclosed alongside it. Labelled "selisih terhadap normal historis" with the baseline dataset and period named.
- `modelClimateOffset` — its own labelled quantity: model climatology minus observed climatology, per month. Never presented as an anomaly.
- Both anomalies are reported in **mm and % of normal**. The denominator is part of the contract, not an implementation detail.

Presenting a model anomaly as "your field's normal" is prohibited. Publishing a `baselineAnomaly` under `biasCorrected: false` without the offset disclosure is prohibited.

**D4. BMKG is a gated local-trust layer, not a data backbone.**

- `BMKG_SHORT_RANGE_ENABLED` feature flag, default **off** until written permission is obtained (ToU §9.3).
- Attribution "Sumber: BMKG" + logo rendered in the component when enabled.
- ≤60 req/min/IP, aggressive caching, no scraping of any bmkg.go.id page.
- BMKG climate products may only enter via **admin-uploaded official artifacts** with recorded provenance, never via crawl.

**D5. No bias correction in v1.**

SEAS5/EC46 are delivered without bias adjustment. We do not "fix" them with a small sample. Bias correction is deferred until hindcast verification exists (Phase 9) and requires: hindcast data for the same grid cell, ≥20 years, per-lead-time evaluation, and a documented method. Until then every seasonal figure carries `biasCorrected: false`.

**D6. Uncertainty is reported in its own terms.**

Five distinct fields, never merged into one "confidence %":

`dataCoverage`, `ensembleSpread`, `modelSkill` (null until verified), `forecastProbability` (only when ensemble-derived), `generalUncertainty` (qualitative).

No invented confidence numbers such as 95%.

**D7. Provenance is schema, not decoration.**

Every ingested record carries: `provider`, `model`, `modelVersion?`, `initializedAt`, `validAt`, `ingestedAt`, `requestedLat`, `requestedLon`, `servedLatitude`, `servedLongitude`, `servedValueIsInterpolated: boolean`, `cellKey`, `spatialResolutionKm`, `temporalResolution`, `ensembleMember?`, `ensembleSize`, `biasCorrected`, `sourceUrl`, `attribution`, `dataClass`, `forecastRunId`, `ingestionRunId`.

`dataClass` is the canonical name for the 9-value enum in D9. `temporalClass` is **deprecated** — two names for one enum caused drift between this ADR and the architecture documents. Run identity is split (`forecastRunId` vs `ingestionRunId`) so that re-normalization cannot masquerade as a new forecast; full rules in `docs/architecture/provenance-contract.md` §3.

Anomaly-bearing records additionally carry `anomalyKind` ∈ {model_relative, baseline_difference}, `baselineDataset`, `baselinePeriod`, `baselineResolutionKm`, and `modelClimateOffsetMm`.

**D8. Caching by grid cell, not by request.**

Cache key: `(provider, model, initTime, cellKey, variableSet, aggregationLevel)` — **no `day` component for a monthly-init seasonal run**, and the key is the *requested* cell, not the interpolated served point (the served point is a function of the request and is not a stable identity). `cellKey` is derived by a fixed, documented rounding rule per model. The free-tier ceilings (10 000/day) and BMKG's 60/min make per-request fetching unacceptable, and member retention (one month) makes the cache the only durable store of member data.

**D8b. Members are ephemeral; aggregates are the system of record.**

Open-Meteo retains individual ensemble members for about one month. The ingest job therefore: (a) sweeps every known cell on/just after the SEAS5 run date; (b) aggregates to per-member monthly means at ingest (~350 rows/cell/run instead of ~10 000 member-days) and keeps them; (c) accepts that a cell first registered mid-cycle cannot be backfilled and reports `spreadUnavailable` rather than substituting a mean.

**D9. Data classes are finer than "forecast vs observation", and the UI must not claim an observation it does not have.**

```ts
type WeatherDataClass =
  | "field_observation"      // user's own rain gauge / sensor / manual note
  | "station_observation"    // BMKG station — not available as a feed
  | "satellite_estimate"     // IMERG, CHIRPS-SAT
  | "reanalysis"             // ERA5, ERA5-Land, MERRA-2
  | "weather_forecast"
  | "subseasonal_forecast"
  | "seasonal_forecast"
  | "annual_outlook"
  | "climatology";
```

1. No provider in scope returns `station_observation`. BMKG's village API is `weather_forecast`; ERA5 is `reanalysis`; CHIRPS is `satellite_estimate` blended with gauges. Only user-entered plot measurements produce `field_observation`.
2. The dashboard must therefore say **"Data cuaca terbaru"** with source and valid time — not "Observed at". `Observed at` is unlocked only when a field observation exists.
3. Reanalysis may be displayed for the recent past, always labelled, never as "current conditions".
4. Suitability and anomaly records carry the class of their *evidence*, not of their display date.

## Consequences

Positive:
- Every horizon has a real source with a real initialization time.
- Legal posture is explicit: BMKG off by default, Open-Meteo paid-or-self-host required for commercial use.
- The "no 12-month daily forecast" rule is enforced by data shape, not by discipline.
- Anomaly claims become auditable.

Negative / accepted costs:
- Commercial use requires paying Open-Meteo or operating an AGPL stack; neither is free.
- Months 8–12 will look less "actionable" than months 1–7. This is the truth, and the UI must make it legible rather than hide it.
- SEAS5 refreshes monthly on the 5th, so the seasonal layer is up to 31 days stale by design; freshness per source is mandatory.
- BMKG value to users is deferred until permission is granted.
- CHIRPS is 0.05° (~5.5 km); "point" accuracy at a 0.3 ha plot is a statistical statement, not a measurement.

## Alternatives considered

1. **BMKG-first architecture.** Rejected: 3-day horizon, document-only climate products, ToU blocks commercial republication.
2. **Direct ECMWF/C3S for real-time seasonal.** Rejected for v1: CDS is optimised for hindcast/bulk retrieval, not per-request point series; operational latency and request cost are worse than Open-Meteo, which already repackages the same models.
3. **Open-Meteo self-host only.** Deferred: AGPL and undocumented upstream-bucket terms make it a Phase 9 decision, not a foundational one.
4. **Annual outlook from a commercial provider.** Not evaluated as free/verified; no candidate met the bar at point level.
5. **Single-model timeline (SEAS5 only).** Rejected: EC46 gives materially better 16–46 d granularity, and the product's own rule requires the right data class per horizon.
6. **Ensemble-mean probabilities derived by averaging deterministic runs.** Rejected outright by BRAINSTORM; probabilities only from members or published probabilities.

## Follow-ups required before Phase 4 implementation

1. Decide Open-Meteo paid tier vs self-host (cost model, expected call volume).
2. Send BMKG cooperation request; track as external dependency.
3. Confirm Copernicus Licence Rev. 12 verbatim text.
4. Confirm a reachable CHIRPS v3.0 route (direct host timed out on 2026-11-18; try mirror/GEE) or accept ERA5 as shipped baseline.
5. **Resolved 2026-11-18:** monthly endpoints expose only `mean`/`anomaly` — no spread variable exists (`*_spread` rejected with 400). Ensemble spread for seasonal months must be computed from **50 daily members** (payload delivers 50, not 51) and aggregated. Because members are retained for only ~1 month, this must happen at ingest during the run window — see D8b.
6. Define the recalculation trigger when SEAS5 refreshes on the 5th, and store `inputRefs[]` + `fieldSnapshot` + `inputSnapshotHash` on every derived recommendation (a saved plan must be traceable to every input that produced it — not to a single `outlookRunId`, and not only to forecast runs: the baseline and the field's own soil state are inputs too).
7. **Re-plan verification before Phase 9 coding.** Truth must be independent of ECMWF: CHIRPS via a reachable route, or IMERG Final (its ~3.5-month latency is irrelevant for retrospective scoring). Probe the historical-forecast archive's retention and whether archived ensemble members exist at all; probe C3S SEAS5 hindcast point extraction; define grid verification over Indonesian cells with minimum sample sizes and an explicit "cannot rank — report only" rule at small n.
8. Probe the C3S annual-outlook dataset family before permanently conceding months 8–12 to climatology.
9. Pin `forecast_days` in the seasonal adapter and assert the resulting 6-vs-7 monthly row split in a test; the monthly axis is authoritative for the seasonal layer, and daily rows past it must not be rolled up.
10. Add `evidenceTemporalClass` to the planting-window contract (Phase 6), or Phase 7 cannot satisfy the "forecast vs climatology must be visually obvious" rule.

## Review requirement

`oracle` must attack: horizon composition, anomaly semantics, staleness handling, and the BMKG gating decision. `council` must attack: whether months 8–12 climatology is honestly presented, and whether the platform implies forecast skill it has not demonstrated.
