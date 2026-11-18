# Phase 0 Review Log

Reviewer: oracle (adversarial pass, 2026-11-18). Reviewed the five Phase 0 documents and re-probed the load-bearing provider claims.

`council` is not configured in this environment; its adversarial-of-adversarial role was not performed and is recorded as a process gap, not a completed step.

---

## Outcome

Verdict at review time: **not ready for Phase 1** — the horizon map and the anomaly contract were factually wrong. Bounded amendment required, not a re-do.

## Claims re-probed and confirmed wrong in the original docs

| Original claim | Verified reality |
|---|---|
| 16–35 d served by Open-Meteo ensemble, "daily + spread" | `forecast_days=35` returns 35 rows but **all values null from day 15**; 50 members, last non-null day 14 |
| "51 ensemble members" | payload = **50 members + 1 mean** |
| SEAS5 monthly = 7 rows through 2027-05 | **6 rows by default**; 7 only with `forecast_days≥200`; server cap **217** |
| EC46 subseasonal extends to 46 d with weekly and anomaly products | weekly statistics ≤ **42 d**; **no monthly EC46 product** (0 rows) |
| ERA5 grid ≈ 9–11 km | ERA5 = **0.25° ≈ 28 km**; 9–11 km is ERA5-Land. Seasonal↔archive served points differ by **15.2 km** |
| "0–3 days = observation/forecast" | **no observation provider exists**; every source in that row is a forecast |
| `baselineAnomaly` as the user-facing anomaly with `biasCorrected: false` | implies the model is unbiased; measured model-vs-ERA5 November climate offset is **+35 %**, enough to flip the sign of the anomaly |

## Amendments applied

1. **Horizon map** corrected in `docs/research/forecast-horizon-capabilities.md` §1–§3 and `weather-source-matrix.md` §A1–§E. Ensemble band deleted, observation class marked as provider-less, dekadal derivation removed, BMKG corrected to 7 slots/day and ~48 h + partial third day.
2. **Anomaly contract reversed** (`ADR-001` D3): model-relative anomaly is now primary; baseline difference is conditional, requires grid-matching and disclosure of `modelClimateOffset`; both reported in mm and %.
3. **Provenance schema extended** (D7): `requestedLat/Lon`, `servedValueIsInterpolated`, `cellKey`, `ensembleSize`, `anomalyKind`, `baselineDataset/Period/Resolution`, `modelClimateOffsetMm`.
4. **Cache key fixed** (D8) and **member-retention rule added** (D8b): members are ephemeral (≈1 month), per-member monthly aggregates become the system of record, no backfill for late-registered cells.
5. **Agronomic grade rule made self-consistent**: all four crops' rainfall thresholds are grade C, so v1 hard gates reduce to pH / drainage / paddy water; soybean and chili water dimension is explicitly insufficient in v1.
6. **Engine shape corrected**: four evaluation bases (daily / weekly / monthly / climatology), per-dimension coverage, no score when a dimension is unknown, cycle start per crop.

## Second review round — external (GPT), 2026-11-18

Verdict from that review: "conditional pass — do Phase 0.1 corrections, then Phase 1". Two of its claims were load-bearing and were checked before changing anything.

### Claim checked and accepted — CHIRPS licensing

Verified at `chc.ucsb.edu/data/chirps3`: CHIRPS3 is **both** public domain (copyright waived) **and** licensed **CC BY 4.0** (attribution expected). The earlier "public domain / CC0" line was incomplete. Corrected in `data-licensing-and-attribution.md` §1/§6 and `weather-source-matrix.md` §D. Also noted: `data.chc.ucsb.edu` times out while `www.chc.ucsb.edu` responds — a host problem, not a project problem.

### Claim checked and conditionally accepted — ECMWF Set VII (13-month forecast)

Verified on ECMWF's dataset page: **Set VII - SEAS is real**, covers forecast months 8–13, is produced quarterly (Feb/May/Aug/Nov, disseminated 5th 12:00 UTC), in GRIB, with monthly means of ensemble means, monthly anomalies, and per-member monthly means/anomalies. That invalidates the earlier flat statement "no annual outlook exists". It is **not** invalidated the other way either: no access route or licence for a third party was verified — it is not in the Open Data portal and no point API is documented. Recorded as **ADR-001 D2a**: months 8–12 stay climatology until a licence enquiry and a GRIB POC succeed. Also recorded: monthly `tp` in that product is a **rate (m/s)**, not mm.

### Claim checked and accepted — "bias-free by construction" was too strong

Removed from D3. Model-relative anomalies cancel the mean model-vs-baseline offset only; seasonal, lead-time and regime errors remain, `biasCorrected` stays `false`, `modelSkill` stays `null`.

### Claim checked and accepted — data classes were too coarse

Replaced the 6-value temporal class with a 9-value `WeatherDataClass` (ADR-001 D9), separating field observation, station observation, satellite estimate, reanalysis, and the three forecast horizons. Consequence: dashboard must say "Data cuaca terbaru", not "Observed at", until a user measurement exists.

### Claim checked and accepted — probes cover one location only

Added `forecast-horizon-capabilities.md` §4 "Validation scope": nothing about Jakarta generalises to a real plot; repeat the suite at real coordinates with served-vs-requested distance recorded before calling a provider locally validated.

### Already fixed before this review arrived

These were flagged by the external review but had already been corrected in the amendment documented above: 50-vs-51 members, `precision` → evaluation basis, cycle start (sowing/transplant), BMKG ~48 h + partial third day, unresolvable agronomic citations, per-dimension `insufficient_data`.



## Carried into Phase 1 as required decisions

- Cell-identification contract (requested-cell key, interpolation semantics, polygon → centroid).
- Ingest-on-the-5th architecture with no backfill; per-member monthly persistence.
- Per-class staleness/TTL; handling of a month changing temporal class when a run arrives.
- `inputRunRefs[]` + `inputSnapshotHash` on every derived recommendation; recalculation and notification policy.
- Schema-level enforcement of "no 12-month daily forecast" rather than discipline.
- Horizon constants in one declarative table validated by both adapters and API.
- Verification re-plan before Phase 9: independent truth (CHIRPS route or IMERG Final), archived-member availability, C3S hindcast extraction, minimum sample sizes, "cannot rank" rule.
- Probe the C3S annual-outlook dataset family before conceding months 8–12 to climatology.
- BMKG: either size the adm4 registry + plot→village mapping, or keep the adapter behind the flag with no v1 UI.

## Not yet verified (must not be claimed)

- Any forecast skill of SEAS5/EC46 over Indonesia. No verification has been run; `modelSkill` stays `null`.
- CHIRPS reachability (host times out from this environment).
- Whether archived ensemble members exist for historical verification.
- Whether an ECMWF/C3S 13-month product is retrievable as gridded point data.
