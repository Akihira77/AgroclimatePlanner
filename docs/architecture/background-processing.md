# Background Processing

Status: Phase 1. Implementation in Phase 4.

## 1. Why a separate worker

Ingestion is slow, bursty, and provider-limited; user requests are fast and must never wait for a forecast. The worker also owns the one operation that is expensive by nature: recomputing every affected planting window when a new seasonal run lands.

## 2. Queues

| Queue | Job | Trigger | Concurrency | Idempotency key |
|---|---|---|---|---|
| `ingest.short` | BMKG + Open-Meteo deterministic, 0–16 d | hourly | 5 | `short:{cellKey}:{yyyymmddhh}` |
| `ingest.ensemble` | 4–14 d members | every 6 h | 3 | `ens:{cellKey}:{runId}` |
| `ingest.subseasonal` | EC46 15–45 d | daily ~21:00 UTC | 3 | `ec46:{cellKey}:{runId}` |
| `ingest.seasonal` | SEAS5 daily members + monthly | monthly, day 5 + jitter | 2 | `seas5:{cellKey}:{runId}` |
| `ingest.climatology` | 1991–2020 baseline per cell | on first use, then yearly | 2 | `clim:{cellKey}:{baselineVersion}` |
| `aggregate.monthly` | build `MonthlyOutlook` | after ingest | 5 | `monthly:{cellKey}:{runId}` |
| `recompute.windows` | agronomy for affected fields | after monthly | 5 | `win:{runId}:{profileVersionId}:{fieldId}` |
| `recompute.briefings` | invalidate, do not pre-generate | after windows | 5 | `brief:{fieldId}:{runId}` |
| `verify.forecast` | score against truth | weekly | 1 | `verify:{model}:{cellKey}:{period}` |
| `maintenance.sweep` | stale detection, orphan cleanup | hourly | 1 | `sweep:{yyyy-mm-dd-hh}` |

Concurrency is deliberately low. Open-Meteo's free tier is 10 000 calls/day and BMKG's is 60/min; a parallel ingest that fans out per user request would burn the budget in an afternoon.

## 3. Scheduling and run identity

- `runId` = `{provider}:{model}:{initializedAt ISO}`. Everything derived carries it.
- SEAS5: run at day 5, 12:00 UTC. Ingest starts +30 min, jittered per cell to spread load.
- EC46: daily, after ~20:30 UTC.
- Climatology: computed once per baseline version, not per request.
- A missed run is not backfilled for cells that were never ingested — the provider retains members for about one month, so late registration produces `spreadUnavailable`, not a fabricated spread.

## 4. Retry policy

| Failure class | Policy |
|---|---|
| 5xx, timeout, connection reset | exponential backoff 1 m → 5 m → 20 m, 5 attempts, then dead-letter |
| 429 / rate limit | honour `Retry-After`, requeue with delay, never retry tight |
| 4xx validation (bad parameter, unknown model) | fail immediately, no retry, log the payload |
| Partial payload (fewer rows/days than requested) | accept, record coverage, do not retry |
| Normalization error | fail, keep raw payload reference, no retry until adapter version changes |

Dead-lettered jobs surface in `/monitoring/queues` with the error and the last payload reference.

## 5. Budget guards

- Token-bucket per provider in Redis (`om:free:10000/day`, `bmkg:60/min`).
- If a bucket is exhausted, jobs are deferred, not failed.
- Per-cell deduplication: one in-flight job per `(cellKey, source, runId)`; duplicates are dropped by jobId, which is the idempotency key.
- Batch multi-coordinate requests where the provider supports them; a single request for N cells costs one call.

## 6. Staleness rules (per class)

| Class | Max age | Action when exceeded |
|---|---|---|
| `weather_forecast` (0–3 d) | 6 h since `initializedAt` | mark stale in API, enqueue re-ingest |
| `weather_forecast` (4–14 d) | 12 h | mark stale |
| `subseasonal_forecast` | 48 h | mark stale |
| `seasonal_forecast` | 35 d | mark stale; do **not** substitute climatology silently |
| `climatology` | baseline version age (yearly) | rebuild baseline |
| `field_observation` | none | user data, always current-by-definition, show `observedAt` |

Derived rows inherit the **oldest** freshness of their inputs. A planting window is never fresher than the stalest month it consumed.

## 7. Recompute fan-out control

A new SEAS5 run can invalidate thousands of fields. The fan-out is:

1. Collect affected cells (only cells with at least one active field).
2. Compute deduplicated field set per cell.
3. Chunk into batches of 100 fields; each batch is one job.
4. Write results in a transaction per batch so a mid-run failure does not leave half-updated windows.

Priority: fields with an active planting record or a near-term window are computed first; the rest follow.

## 8. Failure semantics that must not be softened

- A job that cannot ingest must never write a placeholder row. Missing data is missing.
- A recompute that fails must leave the previous windows intact and flagged stale, not delete them.
- The worker never "repairs" a class boundary: if SEAS5 is unavailable for a cell, months fall to climatology because the class rule says so, and the record shows it.

## 9. Observability

Per queue: depth, in-flight, completed/failed counts, oldest waiting age, dead-letter count. Per provider: last success, last attempt, latency p50/p95, error rate, remaining budget. Per cell: last ingest per class, coverage percentage.

Alert thresholds (later, Phase 9): seasonal missing for > 40 days, forecast ingest failure rate > 10 % over an hour, dead-letter > 0, budget exhausted before 18:00 local.
