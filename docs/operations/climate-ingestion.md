# Climate ingestion — operator runbook

Phase 5.8 (§8.8 of `docs/architecture/climate-data-foundation.md`). Covers the
worker, the queue, and how to read what it did. It documents what exists; where a
step is not automated it says so instead of implying a cron that nobody wrote.

**Nothing here is a production runbook yet.** No provider grid is validated
(`OPEN-18`), commercial ingestion is not licensed (`OPEN-03`), and no scheduler
enqueues anything. Every statement below is about a database and a process an
operator starts by hand.

---

## 1. What runs

| Process | Command | Role | What it does |
|---|---|---|---|
| Worker | `pnpm build && pnpm --filter @agroclimate/worker start` | `app_system` | Claims one job at a time from `app.jobs`, renews its lease, recovers expired leases, settles the job and its `IngestionRun` |
| API | `pnpm build && pnpm --filter @agroclimate/api start` | `app_api` | Serves the tenant routes; never claims jobs |
| Database | `pnpm db:up` | — | Local PostgreSQL + PostGIS in Docker |

The worker needs `APP_SYSTEM_DATABASE_URL`. The API needs
`APP_API_DATABASE_URL` and `APP_API_PASSWORD`. Never put a credential in this file,
in a log line, or in a job payload.

**No scheduler exists.** A job runs only because something inserted it. Registering
a handler opens no gate: `ingest.forecast` is registered and every real job dies
with `grid_not_validated` before a provider is called, because the shipped registry
holds only `synthetic` and `requireValidated` refuses it.

### Startup line

```json
{"event":"worker_started","handlers":["aggregate","ingest.forecast","ingest.climate"],…}
```

An absent handler is a wiring bug, not a configuration choice: the claim filter is
built from the registered handlers, so a job of an unregistered kind is never
claimed and waits in `queued` forever. The `job_unhandled` event is a log-only guard
that the shipped claim filter makes unreachable.

---

## 2. Reading the queue

```sql
-- Is anything stuck or dead? A dead row IS the dead letter record; there is no
-- second table.
SELECT kind, status, count(*)
FROM app.jobs
GROUP BY 1, 2
ORDER BY 1, 2;

-- What failed, and why.
SELECT id, kind, attempt, max_attempts, last_error, finished_at
FROM app.jobs
WHERE status = 'dead'
ORDER BY finished_at DESC
LIMIT 20;

-- A running row whose lease has lapsed is waiting for the reaper, not for work.
SELECT id, kind, lease_expires_at, now() - lease_expires_at AS overdue
FROM app.jobs
WHERE status = 'running' AND lease_expires_at < now();
```

Retryable failures return the job to `queued` with `run_at` set; between attempts
there is nothing to observe by design (`background_process` §4). Only `dead` needs
a person.

### Replaying a dead job

A dead job is **not** replayed in place. The idempotency key
(`ingest:{queue}:{forecastRunId}:{ingestionVersion}`) is part of the job's identity,
so re-inserting it produces the same row. A retry is a new logical ingest: a new
`ForecastRun`, or a bumped adapter or normalizer version — not an edit to the dead
row. Its `IngestionRun` is already terminal and would refuse to reopen.

---

## 3. What the database already guarantees

These are constraints, not conventions, and they are why a nightly sweep cannot
find a violation of them:

| Invariant | Enforced by |
|---|---|
| A record's `forecast_run_id` and `ingestion_run_id` exist | Immediate foreign keys on `app.weather_records` and on `app.monthly_outlooks` (the latter nullable, for climatology rows that have no run) |
| One live deterministic row per `(forecast_run_id, cell_key, variable, valid_at, ensemble_member)` | `weather_records_live_key`, unique, `NULLS NOT DISTINCT`, partial on `superseded_at IS NULL`. The `NULLS NOT DISTINCT` clause is load-bearing: without it every re-ingest of a deterministic product would append a full duplicate set |
| A supersession moves `superseded_by_id` and `superseded_at` together | `weather_records_supersession_check` |
| A terminal job write and a terminal `IngestionRun` write are one fact | Lease-guarded settlement in one transaction |
| One running job per `IngestionRun` | `jobs_active_ingestion_idx`, unique partial on `ingestion_run_id WHERE status = 'running' AND ingestion_run_id IS NOT NULL` |

`packages/climate-core/src/audit.ts` re-checks the first two **for data that is no
longer inside those constraints** — an export, a payload, a fixture, a future
staging table. It is not a substitute for them, and pointing it at a live database
with correct FKs is a test, not monitoring.

---

## 4. Coverage reconciliation

"Did this run produce what it should have?" needs an expectation, and no table
holds one: the expected horizon is the provider contract for that product. The
quarters below are what an operator can answer today.

```sql
-- Per run: how much arrived, and of what class.
SELECT forecast_run_id, data_class, variable, count(*) AS records,
       min(valid_at) AS first_valid, max(valid_at) AS last_valid,
       count(*) FILTER (WHERE value IS NULL) AS null_values,
       count(*) FILTER (WHERE superseded_at IS NULL) AS live
FROM app.weather_records
GROUP BY 1, 2, 3
ORDER BY first_valid DESC
LIMIT 50;

-- Live duplicate candidates. Each should return zero rows while the unique index
-- above is in place; a non-zero count means an index was dropped, not that the
-- ingestion is wrong. `forecast_run_id` belongs in the key: the same cell, variable
-- and instant in two different runs is two valid rows, and omitting the run id would
-- report them as duplicates.
SELECT forecast_run_id, cell_key, variable, valid_at, ensemble_member, count(*)
FROM app.weather_records
WHERE superseded_at IS NULL
GROUP BY 1, 2, 3, 4, 5
HAVING count(*) > 1;

-- Run lifecycle: a succeeded run with no records is a real incident.
SELECT r.id, r.status, r.record_count, r.coverage_percent, count(w.id) AS rows
FROM app.ingestion_runs r
LEFT JOIN app.weather_records w ON w.ingestion_run_id = r.id
GROUP BY r.id, r.status, r.record_count, r.coverage_percent
ORDER BY r.created_at DESC
LIMIT 50;
```

A null `value` is a provider-published null preserved on purpose; it is not a
missing row and must not be counted as coverage.

### Missing-period detection

Compare `max(valid_at)` per class with the horizon that class promises: 0–14 d
`weather_forecast`, 15–45 d `subseasonal_forecast`, lead months 1–6
`seasonal_forecast`, 7–12 `climatology`. A gap inside a run's own range is visible
as a missing date; a range that simply ends early is a provider or request question
and cannot be judged from the database alone.

---

## 5. The weekly check Phase 5.8 asks for

Acceptance for 5.8 is "one week of scheduled runs produces a report whose counts
reconcile with `ingestion_runs`". Until a scheduler exists, run this by hand once a
week and keep the output:

1. Queue state: no `dead` rows, no `running` row with a lapsed lease.
2. Per-run record counts and date ranges (§4, first query). A `succeeded` run with
   zero records is an incident; a `partial` run is a success and must be labelled as
   one.
3. Live duplicates: zero (§4, second query).
4. Served availability: `GET /v1/climate/outlook?fieldId=…` must show `fresh` or
   `stale` for a stored month, `pending` for one that was never materialised, and it
   must never present a climatology month as a forecast month.

A count that does not reconcile is an incident. A count that reconciles because
nothing ran is not evidence of anything.

---

## 6. Signals an operator will actually see

Two different things appear in the log: a **code** on the job's `last_error`, and an
**event**. Three events — `ingestion_terminal`, `ingestion_already_owned` and
`lease_lost` — leave the job unsettled on purpose, for the reaper to recover.
`handler_error` is logged and then settled by the worker as retryable, or dead on the
last attempt.

| Signal | Kind | Meaning | Action |
|---|---|---|---|
| `grid_not_validated` | code | The registry has no validated entry for this provider/model | `OPEN-18`. Do not add constants to make it pass |
| `provider_changed` | code | The provider's response shape no longer matches the adapter | Update the adapter and bump `adapterVersion`; the job key changes, so the retry is a new job |
| `invariant_violation` | code, never retried | A database invariant refused the write | Inspect the rows that were written; do not retry until the cause is known |
| `ingestion_terminal` | event | The `IngestionRun` is already terminal, so the job cannot reopen it | Inspect the run. A retry needs a new run identity |
| `ingestion_already_owned` | event | Another running job owns this run; this one is abandoned | None. The reaper settles the abandoned lease |
| `lease_lost` | event | The lease expired and another process may now own the job | None. This process stops writing, which is the point |
| `handler_error` | event | Unknown failure; retried as `retryable` until the attempt budget is spent | Read the message; the last attempt turns the job `dead` and the run `failed` |
| `provider_unavailable` | code | Retryable transport failure | Nothing unless the attempt budget runs out |

A `dead` row's `last_error` is the one that stopped it; the events above it explain
how it got there.

## 7. What must not be claimed

- That a provider payload can be reproduced. Original bytes are not retained
  (`OPEN-05`).
- That a value is live. Only `fresh` and `stale` are served, and staleness is
  evaluated at read time.
- That a grid was validated because a job succeeded. A synthetic fixture grid can
  succeed; `requireValidated` is what refuses a real one.
- That monitoring is automated. It is not: this file is the monitoring.
