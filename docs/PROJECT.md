# Project — Agroclimate Planner

Status: Phase 1 definition. Supersedes nothing.
Companion documents: `docs/adr/ADR-001` (data), `docs/adr/ADR-002` (architecture), `docs/architecture/*`, `docs/research/*`.

## 1. What this product is

A planning tool for an Indonesian landowner who has to decide **when to plant what, on which plot, and what could ruin it**. It answers that with weather that is actually available, climate context that is honestly labelled, and agronomic reasoning that shows its work.

It is not a weather app. A weather app answers "will it rain tomorrow". This answers "is the next three weeks of my maize cycle going to hit flowering in a dry spell, and what does the season after that look like".

## 2. Primary user and job

One user type in v1: **the owner-operator**. Owns or manages one farm, several plots, decides planting. Not an agronomist, not a data scientist. Fluent in Indonesian, works on a laptop, checks the phone in the field.

The job, in their words: *"Saya mau tanam apa bulan ini, di petak mana, dan apa risikonya."*

Everything that does not serve that sentence is out of scope for v1.

## 3. Domains

| Domain | Responsibility | Phase |
|---|---|---|
| Farm & field | farms, plots, geometry, elevation, soil, irrigation, drainage | 3 |
| Crop catalog | crops, cultivars, agronomic profiles, versioning | 3 |
| Weather ingestion | provider adapters, normalization, provenance, freshness | 4 |
| Climate outlook | rolling 12-month timeline, monthly aggregation, anomalies, climatology | 5 |
| Agronomic engine | stage-aligned suitability, planting windows, explanations | 6 |
| Calendar & dashboard | 12-month view, day detail, opportunities | 7 |
| AI analyst | narration over verified structured output | 8 |
| Source monitoring | last sync, coverage, staleness, failures | 4 |
| Verification | forecast skill against independent truth | 9 |
| Identity & access | users, roles, permissions | 3 |

## 4. The five rules that outrank features

1. **Never show a number we cannot source.** Every value carries provider, model, initialization time, and data class.
2. **Never let a coarse resolution imitate a fine one.** 36 km monthly is not a daily local forecast, and the UI must make that structural, not a tooltip.
3. **Climatology is not a forecast.** Months beyond the seasonal feed are labelled "Normal historis", not "prakiraan".
4. **An unknown agronomic input is `insufficient_data`.** No defaults substituted for soil, irrigation, or missing thresholds. A recommendation that hides a missing input is a lie with a score attached.
5. **The deterministic engines decide; the AI explains.** The LLM may not produce a threshold, a probability, or a planting date that the engines did not compute.

## 5. Scope for v1

In:
- One owner-operator, multiple farms/plots, RLS-style ownership isolation.
- Four crops: padi, jagung, kedelai, cabai. Kedelai and cabai ship with **water = insufficient_data** (no verifiable threshold), capping their suitability at `conditional`.
- 0–14 d daily, 15–45 d subseasonal, months 2–7 seasonal, remaining months climatology.
- Planting windows with per-dimension explanation, calendar with crop markers and overflow, AI briefing in Indonesian.

Out (explicitly):
- Yield prediction, price/market data, pesticide or fertiliser scheduling, IoT device integration, multi-tenant organisations, mobile native apps, BMKG climate product republication (blocked pending written permission), any 12-month daily forecast.

## 6. Success criteria

1. A user can create a farm and plot, pick a crop, and get a planting window whose reasoning they can audit line by line.
2. Every rendered weather value traces back to a stored record with a provider, initialization time, and data class.
3. A month sourced from climatology is visually unmistakable from a month sourced from SEAS5.
4. The system runs with the AI layer disabled, losing narration only.
5. Forecast skill is either measured or absent — never asserted.

## 7. Vocabulary (id/en)

| Concept | Term used in UI | Note |
|---|---|---|
| Plot | Petak / Lahan | the unit that owns coordinates and soil |
| Planting window | Jendela tanam | range, not a single day, beyond day 14 |
| Suitability | Kesesuaian | excellent / good / conditional / poor / insufficient_data |
| Seasonal outlook | Prospek musiman | SEAS5, monthly |
| Climatology | Normal historis (1991–2020) | never called a forecast |
| Data class | Jenis data | observation / reanalysis / forecast / climatology |
| Freshness | Kebaruan data | per source, not per page |

## 8. Deliberate simplifications

- Modular monolith, one database, one worker. No microservices until a measured bottleneck demands it.
- No vector tiles, no map rendering in v1 beyond a simple plot locator.
- No custom auth provider; sessions in Postgres.
- English identifiers, Indonesian copy. Times in Asia/Jakarta, stored UTC.

Each of these has a `ponytail:` ceiling recorded where it is implemented.
