# Background Processing

Status: Phase 1. Implementation in Phase 4.

## 1. Why a separate worker

Ingestion is slow, bursty, and provider-limited; user requests are fast and must never wait for a forecast. The worker also owns the one operation that is expensive by nature: recomputing every affected planting window when a new seasonal run lands.

## 2. Queues

Six queues, not ten. Each one exists because of an isolation requirement that a shared queue cannot express (concurrency ceiling, timeout, rate bucket, or blast radius). Queues that shared all four were merged.

| Queue | Jobs | Why it needs independent isolation | Resource profile | Concurrency | Timeout | Retry | Rate constraint | Priority / SLA |
|---|---|---|---|---|---|---|---|---|
| `ingest.forecast` | BMKG cuaca; OM forecast; OM ensemble (0–14 d) | must stay responsive hourly; a monthly burst must never delay it | small JSON, 3–50 member columns, 0.3–3 s | 5 | 20 s | 5, backoff 1/5/20 m | BMKG 60/min/IP; OM 10k/day bucket | high · p95 < 60 s after trigger |
| `ingest.climate` | EC46 daily; SEAS5 monthly; climatology (on first use, yearly) | huge payloads and multi-minute fetches; must not consume `ingest.forecast` slots, and must be paused independently when a provider degrades | 50 members × 45–200 d, MB-scale, 5–120 s | 3 | 180 s | 4, backoff 2/10/30 m | OM 10k/day; seasonal endpoint has its own budget share | low · SEAS5 must finish within 6 h of the 5th |
| `aggregate` | daily→monthly rollup, spread computation, coverage | pure transformation of stored data; different failure mode (no provider involved), and safe to replay in bulk | CPU + DB writes, no network | 5 | 60 s | 3, immediate | — | medium · after ingest |
| `recompute.windows` | agronomy fan-out per field | largest blast radius: a bug here writes wrong recommendations to every user; must be pauseable and rate-limited separately | CPU-bound, DB-heavy, 50–500 ms/field | 5 | 120 s | 3 | — | high · near-term fields first |
| `verify` | forecast scoring against truth | weekly, GPU-of-the-poor (long loops), must never compete with user-facing recompute | CPU + large reads | 1 | 30 m | 2 | archive provider budget | lowest · off-hours only |
| `maintenance` | stale sweep, orphan cleanup, dead-letter reaper, **briefing staleness detection** | cheap, frequent, must never be blocked behind heavy work; and must be able to run while everything else is paused | trivial | 1 | 30 s | 5 | — | lowest · hourly |

### Merges applied, with reasons

| Was | Now | Why the split was unjustified |
|---|---|---|
| `ingest.short` + `ingest.ensemble` | `ingest.forecast` | same provider, same adapter family, same failure semantics, same retry shape. The only difference was payload size — expressed as a per-job timeout, not a queue. |
| `ingest.subseasonal` + `ingest.seasonal` + `ingest.climatology` | `ingest.climate` | one endpoint family (seasonal), one budget, one degrade-together failure mode. Cadence differences are handled by schedule and priority inside the queue. The monthly SEAS5 burst is protected by a 3-slot ceiling and a 180 s timeout, not by a separate queue. |
| `recompute.briefings` | **deleted** | it only invalidated cached briefing state — deleting a cache key does not need a worker. Invalidation now happens where it is *allowed* to happen: at the end of `recompute.windows`, inside `withTenant(ownerId)`. `maintenance` may only *detect* candidates and enqueue that work — see §10. Pre-generating briefings would also mean paying for AI calls nobody reads. |

### Merges deliberately **not** applied

- `ingest.climate` vs `ingest.forecast`: a 120 s seasonal fetch would otherwise occupy the slots that keep the 0–3 day forecast current.
- `aggregate` vs `recompute.windows`: aggregation failure must not block window recompute, and vice versa; they also have different replay costs.
- `verify` vs everything: verification reads years of history and must be schedulable off-hours without touching interactive latency.
- `maintenance` vs everything: it must run when other queues are paused or wedged — that is its purpose.

Concurrency is deliberately low. Open-Meteo's free tier is 10 000 calls/day and BMKG's is 60/min; a parallel ingest that fans out per user request would burn the budget in an afternoon.

## 3. Scheduling and run identity

- `ForecastRun.id` is **UUIDv7** — the only identifier persisted or exposed. The natural key `(provider, model, product, initializedAt)` is unique and used for lookup/upsert, and nothing else. A composite string like `{provider}:{model}:{product}:{initializedAt}` is **not** an id: it duplicates what the natural key already guarantees, it breaks when a provider adds a model version, and it would put a mutable-looking string into every derived row's provenance.
- `ingestionRunId` → one row per **logical** ingest: unique on `(forecastRunId, ingestionVersion)` where `ingestionVersion = sha256(adapterVersion, normalizerVersion, targetSelectorHash)`. `attempt` is a physical retry counter on that row, not part of identity. Re-normalizing stored payloads bumps `normalizerVersion`, which changes `ingestionVersion` and creates a new `IngestionRun` under the **same** `ForecastRun` — a normalization fix must never surface to users as a new forecast. A BullMQ retry increments `attempt` in place and creates nothing.
- Job idempotency keys use ids: `ingest:{queue}:{forecastRunId}:{targetSelectorHash}`, where `forecastRunId` is the UUIDv7 resolved from the natural key at enqueue time.
- Every derived artifact stores `inputRefs[]` (discriminated: forecast run, baseline, observation set, dataset), `fieldSnapshot` where applicable, `inputSnapshotHash`, `derivationVersion`, `computedAt`.
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
- Per-cell deduplication: one in-flight job per `(cellKey, source, forecastRunId)`; duplicates are dropped by `jobId`, which is the idempotency key.
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

Derived artifacts do **not** inherit a single "oldest" freshness. That rule was wrong twice: climatology has no initialization time (so it would age a whole outlook forever), and a month missing for `beyond_horizon` is not stale at all.

`DerivedFreshness` records `computedAt`, `oldestInputInitializedAt` (computed over **non-climatology** inputs only), and `staleInputRoles[]`. The artifact's availability is a function of those plus its own policy:

| Artifact | Policy | Becomes stale when |
|---|---|---|
| `MonthlyOutlook` | derived | any non-climatology role was stale at compute time, or its own TTL (6 h) elapsed |
| `PlantingWindow` | derived | older than the shortest-lived input TTL, floor 6 h, or any segment's source went stale |
| `AiBriefing` | derived | any input run id changed — invalidation by identity, not by clock |

A failed recompute leaves the previous artifact `active` with `reason = "recompute_failed"`; it is never deleted and never silently replaced by a worse class. New runs supersede by status change (`supersededById`), preserving the audit trail.

## 7. Recompute fan-out control

A new SEAS5 run can invalidate thousands of fields. The fan-out is:

1. Collect affected cells (only cells with at least one active field).
2. Resolve `(fieldId, ownerId)` pairs — this is the only step that needs the system role, and it emits ids only.
3. **Group by `ownerId`**, then chunk each owner's fields into batches of ≤ 100. One job = one owner.
4. Each job runs inside `withTenant(ownerId, …)` and writes in a transaction per batch, so a mid-run failure does not leave half-updated windows.

Batching "100 fields" across owners was the earlier design and is incompatible with transaction-scoped RLS: a batch spanning two tenants cannot be written under one `app.user_id`. Grouping by owner costs nothing — a farm has a handful of plots, so most owners produce exactly one job — and it keeps the recompute path identical to the request path.

Priority: fields with an active planting record or a near-term window are computed first; the rest follow. `ownerId` is part of the job payload; a payload without it fails the job rather than falling back to a bypass role.

## 8. Failure semantics that must not be softened

- A job that cannot ingest must never write a placeholder row. Missing data is missing.
- A recompute that fails must leave the previous windows intact and flagged stale, not delete them.
- The worker never "repairs" a class boundary. Months 2–7 falling to climatology happens **only** when the seasonal horizon genuinely ends there (`beyond_horizon`). A `pending`, `ingest_failed`, or `provider_unavailable` seasonal month is reported as exactly that — never backfilled with climatology, and never marked `beyond_horizon` because the job failed. Deciding "the horizon ends here" from "we have nothing" is the single most attractive wrong shortcut in this system.

## 9. Observability

Per queue: depth, in-flight, completed/failed counts, oldest waiting age, dead-letter count. Per provider: last success, last attempt, latency p50/p95, error rate, remaining budget. Per cell: last ingest per class, coverage percentage.

Alert thresholds (later, Phase 9): seasonal missing for > 40 days, forecast ingest failure rate > 10 % over an hour, dead-letter > 0, budget exhausted before 18:00 local.

## 10. Maintenance and tenant-owned data

`maintenance` runs as `app_system` (`BYPASSRLS`). It must never write a table that carries a `user_id` column.

| Capability | Allowed |
|---|---|
| **Read** | ids and metadata only: field ids, owner ids, artifact ids, `inputRefs`, run ids, dead-letter entries, queue state. No soil values, no geometry, no observations, no briefing text. |
| **Write** | weather-plane bookkeeping only — `sync_attempts`, dead-letter status, sweep watermark. None of these carry `user_id`, so none of them are covered by a tenant policy. |
| **Enqueue** | yes, and this is its main output: `recompute.windows` jobs keyed by `(ownerId, fieldBatch)`, with `ownerId` in the payload. |
| **Never** | mark a tenant row stale, rewrite or delete a briefing, touch `farms`, `fields`, `suitability_runs`, `planting_windows`, or `ai_briefings`. |

Briefing invalidation therefore has exactly one executor: the `recompute.windows` job running as `app_api` inside `withTenant(ownerId)`, which drops the briefings for the fields it just recomputed. `maintenance` only notices that a briefing's `inputRefs` no longer match current runs and enqueues that work.

Note that "mark stale" is not an operation at all, because derived freshness is computed at read time from stored provenance (`provenance-contract.md` §5). The sweep exists to *enqueue recomputation*, not to relabel state — which is why it never needs tenant write access.

Why this is a hard rule rather than a preference: a bug in a `BYPASSRLS` write path to `ai_briefings` would rewrite what a farmer was told with no user context in the audit trail, and no RLS policy would have stopped it. The role boundary is the only thing standing between a maintenance sweep and every user's derived data.
