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

## Carried into Phase 1 as required decisions

- Cell-identification contract (requested-cell key, interpolation semantics, polygon → centroid).
- Ingest-on-the-5th architecture with no backfill; per-member monthly persistence.
- Per-class staleness/TTL; handling of a month changing temporal class when a run arrives.
- `outlookRunId` on every derived recommendation; recalculation and notification policy.
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
