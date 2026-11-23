# Phase 5.4 — Planning Consolidation

**Status:** consolidation only. No design revision, no implementation. Owner approval is recorded for `D21` and `D15c` only.
**Baseline:** `a383c59b4fc1121c2eeb6efcb01141d1d8aa1007` — `fix(worker): kill claim at attempt ceiling`.
**Date:** 2026-11-22.

---

## 1. Executive summary

Phase 5.4 is **short-range forecast ingestion**: fetch Open-Meteo forecast and ensemble data for lead days 0–14, normalize it, and persist it into `app.weather_records` under the `IngestionRun` lifecycle shipped in Phase 5.3.

Design work is substantially complete. 28 issues were closed at specification level, including the ones that would have damaged data: settling a job `dead` over a successful run, superseding newer output, writing after lease loss, and treating an unresolved COMMIT as a rollback.

The remaining gap is **authority and consistency**, not design depth:

- **2 of 31** tracked decisions carry explicit owner approval: `D21` (single lock order) and `D15c` (`settlePair`). No other decision is approved.
- **10** decision IDs (`D4`, `D6`–`D8`, `D10`–`D14`, `D18`) have no recoverable resolution text in any durable source. They are deferred with a stated reason and a reopening rule. This document does not guess.
- **2** implementation blockers:
  - **A-1** — a `dead` job can coexist with a `running` run, and nothing recovers it (`runner.ts:148-165`; reaper filter `postgres.ts:285-296`; `jobs_identity_key`). Remains open until the **complete** settlement contract is approved and implemented; `D15c` alone does not close it.
  - **A-2** — every settlement path in the baseline locks **run → job** while the reaper locks **job → run**. Two paths invert, not one: `beginIngestionExecution` (`climate.ts:253-296`), and `failTerminal`/`settle` (`runner.ts:156-183`). Resolvable only by D21 **plus** D15c together. **The design contract is approved; the implementation is pending, so the blocker stays open.**
- **7** operational dependencies, two of which are hard gates already recorded in the repo: `OPEN-03` (no commercial operation) and `OPEN-18` (no real ingestion on an unvalidated grid).
- **2** factual claims retracted: `transaction_timeout` is not configured anywhere in the repository (0 occurrences), and `jobs_active_ingestion_idx` does not block replacement of a `dead` job (the index is partial on `status='running'`).

**Phase 5.4 is not ready for implementation.** It is ready for owner review of a documented, internally consistent decision set.

---

## 2. Scope and exclusions

### 2.1 In scope

- Short-range forecast ingestion, lead days 0–14 (`SHORT_RANGE_FORECAST_DAYS = 15`).
- Open-Meteo forecast adapter and Open-Meteo ensemble adapter.
- Forecast ingestion handler, `ingest.forecast` queue wiring.
- Persistence into `app.weather_records`.
- Integration with the PostgreSQL queue and `IngestionRun` lifecycle from Phase 5.3.
- `ForecastRun` identity and provenance.
- Supersession and concurrency handling.
- Retry, lease fencing, recovery, and the observability required to operate them.

Planned files:

| File | Purpose |
|---|---|
| `packages/weather-core/src/adapters/open-meteo-forecast.ts` | short-range adapter |
| `packages/weather-core/src/adapters/open-meteo-ensemble.ts` | ensemble adapter |
| `apps/worker/src/ingest/forecast.ts` | ingestion handler |
| `apps/worker/src/main.ts` | handler registration |

### 2.2 Out of scope

| Item | Disposition |
|---|---|
| Phase 5.5–5.8 | excluded |
| BMKG integration | excluded without licence clearance |
| Raw provider payload retention | excluded (`OPEN-05`, deferred by owner) |
| Redis / BullMQ | excluded; PostgreSQL is the queue |
| `field_outlook_cells` writes | excluded; reassigned to a follow-up phase under `app_api` + `withTenant` |
| Computed ensemble mean | excluded permanently; provider `_mean` row only |
| Unit conversions not already approved | excluded; `wind_speed_10m_max` km/h→m/s returns `unsupported_unit` |
| Schema, migration, privilege, RLS changes | **not automatic scope** — each requires `D*` approval (§14) |

Any item appearing in a later proposal that is not in §2.1 is a **scope expansion** and is not included by default.

---

## 3. Baseline and source hierarchy

### 3.1 Baseline

`a383c59b4fc1121c2eeb6efcb01141d1d8aa1007`. Confirmed present and checked out; tree clean. The default branch HEAD must not be substituted for this commit when reasoning about Phase 5.3 behaviour.

### 3.2 Source priority

1. Implementation at `a383c59` — behavioural facts.
2. Migrations and database constraints — schema facts.
3. `docs/architecture/`, `docs/adr/` — recorded design decisions.
4. This planning record — Phase 5.4 decisions.
5. Reviewer recommendations — **recommendations, never approvals**.

### 3.3 Conflict handling

When two sources disagree, both are recorded, the disagreement is classified as *source fact* / *design decision* / *stale documentation*, and a reconciliation recommendation is given. Conflicts requiring owner authority are listed in §14.

### 3.4 Known documentation drift (verified)

| Location | Claim | Reality |
|---|---|---|
| `docs/architecture/climate-data-foundation.md` §5.3 | job identity ends in `targetSelectorHash` | `ingestionJobIdentityOf` is `ingest:{queue}:{forecastRunId}:{ingestionVersion}` (`contracts/src/climate.ts:134-144`) |
| `provenance-storage.md`, `architecture/tables-climate.md` (referenced in planning rounds) | — | do not exist; real paths are `docs/architecture/provenance-contract.md` and `docs/data-model/tables-climate.md` |
| `docs/architecture/data-flow.md:62-66` | EC46 branch | dead branch; no EC46 adapter exists |

---

## 4. Established architectural decisions

Settled; not reopened. Restated so this document is readable standalone.

### 4.1 Phase 5.2 — spatial and provider foundation

- Registry identity is `(provider, model)`. `gridId` is a label, not a lookup identity.
- `GridSpec` is pure; `SpatialResolution` carries no served coordinate.
- `GridEvidence` distinguishes `synthetic` from `validated`; `requireValidated()` rejects synthetic entries.
- No silent fallback for production configuration.
- `field_outlook_cells.distance_km` requires a provider served coordinate. No placeholder, no anchor substitution.
- `app.outlook_cells` is global, not tenant-owned.
- `app_api` and `app_system` have distinct, enumerated privilege boundaries.
- No Phase 5.2 write to `field_outlook_cells`.

### 4.2 Phase 5.3 — queue and lifecycle

- PostgreSQL is the queue backend; `app_system` is the worker role; `app_api` is the tenant-scoped API role.
- Jobs, `ForecastRun`, `IngestionRun` are global (no tenant scoping).
- Job statuses are exactly `queued | running | succeeded | dead` (`jobs/migration.sql:59`).
- `IngestionRun` statuses are `queued | running | succeeded | partial | failed`; `partial` is terminal (`domain_tables:399`). `queued` is admitted by the CHECK but never written — `beginIngestionExecution` inserts `running` directly (`climate.ts:255-262`).
- A `dead` job corresponds to `IngestionRun = failed`. A `succeeded` job may correspond to `succeeded` or `partial`.
- `IngestionRun` identity is `(forecast_run_id, ingestion_version)`; `ingestionVersion = sha256(adapterVersion, normalizerVersion, targetSelectorHash)` (`contracts/climate.ts:79-95`). A retry does not create a new run.
- `jobs_active_ingestion_idx` — partial, `WHERE status='running' AND ingestion_run_id IS NOT NULL` (`jobs/migration.sql:108-110`) — prevents two **simultaneously running** jobs from owning one `IngestionRun`.
- `jobs_identity_key UNIQUE (kind, idempotency_key)` (`:53`). A dead job keeps its key; the migration states this is what makes dead-letter recovery "an explicit operator action rather than an accident" (`:24-26`).
- `reapExpired` candidates are `status='running' AND lease_expires_at < now()`, selected `FOR UPDATE SKIP LOCKED` (`postgres.ts:285-296`).
- Terminal job settlement and terminal run status must be atomic.
- Worker shutdown must not perform an unsafe release after a handler has started.
- The lease token is the ownership fence for job settlement.

### 4.3 Baseline correction at `a383c59`

- `release()` requeues while attempts remain; at the ceiling the job becomes `dead` with `claim_budget_exhausted` (`postgres.ts:245-280`).
- No `IngestionRun` is created or modified by `release()`.
- Shutdown distinguishes an accepted release from a rejected one.
- Not reopened; no source-level contradiction found.

### 4.4 Phase 5.4 — settled design decisions

| # | Decision | Evidence |
|---|---|---|
| E1 | Short-range only; `weather_records` written by `app_system`; no monthly tables, no aggregation, no raw payload retention | scope |
| E2 | `horizon_end` = last returned day with ≥1 non-null requested `(variable, member)`. Null rows inside the horizon are stored; absent rows beyond it are absent. `provider_null` is a statement about payload bytes, never about coverage | earlier settled |
| E3 | Null vs absent is a contract, not an inference | `docs/data-model/temporal-and-weather-semantics.md:198-202` |
| E4 | Ensemble member index is 0-based from 1-based `memberNN`; provider `_mean` row stored as given, never computed; absent mean → members + `partial` | earlier settled |
| E5 | Only zero-conversion variables in 5.4; `wind_speed_10m_max` → `unsupported_unit` | `climate-data-foundation.md` §7.1 |
| E6 | `forecast_runs.received_at` = first receipt, `NOT NULL`; `horizon_end` may only be extended (`forecast_runs_horizon_check`, `domain_tables:361`) | schema |
| E7 | `weather_records_live_key` excludes `ingestion_run_id`, includes `forecast_run_id` (`domain_tables:515`) | schema |
| E8 | Supersession is a linked list: `supersedes_id` (immediate), `superseded_by_id` (deferred) | schema |
| E9 | `forecast_runs` insert is `DO NOTHING` + read-back; it never updates `horizon_end` (`climate.ts:152-209`) | source |
| E10 | Runner defaults: lease 60 000, heartbeat 20 000, poll 1 000, shutdown grace 20 000, reaper 30 000 ms (`runner.ts:98-104`) | source |
| E11 | `jobs.attempt` counts claims; `ingestion_runs.attempt` counts handler starts | source |
| E12 | An old handler may still run after a lease takeover; Phase 5.4 must account for it | Phase 5.3 record |

---

## 5. Master decision register

Status vocabulary: **Approved** only with explicit owner approval; **Open**; **Rejected**; **Deferred**. Two approvals exist (`D21`, `D15c`) and are recorded verbatim from the owner's decision. No approval is inferred for any other ID.

| ID | Topic | Current decision | Alternatives | Owner status | Evidence | Deps | Implementation impact | Recommendation |
|---|---|---|---|---|---|---|---|---|
| D1 | Supersession FK + self-supersession | `superseded_by_id` becomes `DEFERRABLE INITIALLY DEFERRED NOT VALID` + `VALIDATE`; `supersedes_id` stays immediate; add `weather_records_no_self_supersession CHECK (superseded_by_id IS DISTINCT FROM id) NOT VALID` + `VALIDATE`; prechecks (dangling, pairing, self-link, cycle) must return 0; acyclicity by write-path construction + recursive-CTE test | keep immediate FK; enforce cycles with a trigger | **Open** | probes: plain `ADD CONSTRAINT` yields `convalidated=t`; `NOT VALID` yields `f` then `VALIDATE` enforces `23503`; `id = superseded_by_id` is accepted today; a two-row cycle commits | D16 | one migration | approve |
| D2 | Who creates the `IngestionRun` | Fetch first; `opensIngestionRun: false`; handler calls `beginIngestionExecution` itself; T1 `upsertForecastRun` → T2 `beginIngestionExecution` → fenced T3 | runner creates the run before `handle()` | **Open** | `contracts/src/job.ts:55-61` is `z.strictObject` requiring `forecastRunId`, so the payload cannot exist before the fetch; `runner.ts:250` | D2a | handler owns T1/T2 | approve |
| D2a | D2 wording confirmation | confirms the handler-owned run lifecycle | — | **Open** | — | D2 | none | approve |
| D3 | Forecast cycle instant | content not recoverable from durable sources; was tracked as partially blocking the adapter lane | — | **Open** | adapter lane record | D5 | adapter `cycleAt` | restate and approve |
| D4 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D5 | Validated grid gate | `requireValidated()` forbids **real ingestion** on a `synthetic` entry. It does **not** forbid adapter development or normalizer unit tests against synthetic fixtures — that is the existing development path | block all adapter work | **Open** | `grid.ts:380,606`; `syntheticGridRegistry`; `OPEN-18` | C-2 | adapter code unblocked; validated integration + production ingestion blocked | approve the narrowed gate |
| D6 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D7 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D8 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D9 | DB-side timeout policy | `ALTER ROLE app_system SET transaction_timeout='15s'`; `SET LOCAL statement_timeout='10s'`; `SET LOCAL idle_in_transaction_session_timeout='10s'`; startup probe refuses to start in production when the value is `0` | pool-wide assertion | **Open** | all four GUCs are `0` today; `transaction_timeout` appears 0 times in the repo | D9a, D9b, D9c | every transaction | approve |
| D9a | Startup probe | `SHOW transaction_timeout` at boot; refuse to start in production on mismatch | trust deployment | **Open** | `main.ts:21-30` reads only the DSN | D9 | worker bootstrap | approve |
| D9b | Pool assumptions A1–A5 | five named, testable assumptions replace a single assertion | one assertion | **Open** | `index.ts:118-125` forwards only `connectionString` and `max` | D9 | test plan | approve |
| D9c | Provisioning + verification | add `ALTER ROLE app_system SET transaction_timeout='15s'` to `bootstrap/roles.sql:22-28`; startup probe; assertion in `verify-privileges.mjs` | per-transaction `SET` | **Open (dependency)** | 0 occurrences of `transaction_timeout` | D9 | bootstrap rerun required | approve |
| D10 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D11 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D12 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D13 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D14 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D15 | T3 atomicity | T3 is strictly atomic: records + supersession + `horizon_end` + served coords + run terminal + job terminal commit together. The **handler** emits an operational outcome; the **runner** decides whether a retry is available; `settlePair` performs the transition | handler performs the retry-budget check | **Open** | `markIngestionStatus` has no lease predicate (`climate.ts:335-366`) | D15a-e | T3 shape | approve |
| D15a | Settlement ownership | The handler settles atomically **inside T3 only**, because atomicity requires it. All failure-side settlement is runner-invoked | handler owns terminal settlement generally | **Open** | `runner.ts:148-215` | D15 | handler contract | approve |
| D15b | `HandlerResult` first revision | superseded by D15e | — | **Superseded** | — | — | — | none |
| D15c | `settlePair` primitive | one primitive, three modes `succeed`/`failed`/`adopt`; `expectsRun`; authoritative run id from the locked job row; **job-then-run lock order**; lease predicate; `ROW_COUNT` assertions | separate success primitive | **Approved** — owner decision: Approve, no notes recorded | `runner.ts:148-215` | D15, D15d, D21 | replaces `failTerminal`/`settle` and their run→job order; implementation pending | approved |
| D15d | Retry-budget ownership | runner owns `attempt`/`maxAttempts`; handler returns an operational outcome only; `retryable` at the ceiling goes to `settlePair(mode:'failed')`; `unknown` is never treated as `not_committed` | handler decides terminality | **Open** | `runner.ts:195-201` — the ceiling branch already lives in the runner | D15c | removes `attempt` from the handler | approve |
| D15e | Final `HandlerResult` | `settled` (+`anomaly?`) \| `succeeded` \| `retryable` \| `terminal` \| `abandoned{reason}`; `runId?` removed; `settled` never carries `failed` | keep `runId?` | **Open** | `runner.ts:65` exposes `opensIngestionRun` | D15c | type change | approve |
| D16 | Concurrency | transaction-scoped advisory lock on `'weather_records:'||forecastRunId`; lock order job row → advisory → guard → data; lease revalidated **after** the advisory wait; `FOR UPDATE` added to `upsertCell` read-back; served-coordinate drift > 1e-6° is whole-run terminal `provider_changed`; exact `(cellKey, variable)` footprint matching; one ordering relation | per-key advisory locks; unlocked read-back | **Open** | `climate.ts:68-95` read-back has no `FOR UPDATE`; `lock_timeout` does cancel an advisory wait (probe) | D17, D19, D21 | T3 shape | approve |
| D17 | Ordering event | priority is assigned at **enqueue**; ordering key is the proposed `jobs.enqueue_seq` | fetch start; fetch completion; claim time; `jobs.id` | **Open** | `started_at` and `created_at` both `DEFAULT now()` (`domain_tables:376-419`); uuidv7 is ms-resolution | D20, D20a | new column | approve |
| D18 | — | content not recoverable | — | **Deferred** | none | — | presumed none | owner may reopen |
| D19 | Lock timeout | `LOCK_TIMEOUT_MS = 5000` for T2, T3, T4/T5 and the witness; `55P03` is `retryable` in write paths and `unknown` in the witness | 2 s in T3 / 5 s in witness | **Open** | `lock_timeout` cancels `pg_advisory_xact_lock` (probe) | D16, D15c | three call sites | approve |
| D20 | `enqueue_seq` column | `enqueue_seq bigint GENERATED ALWAYS AS IDENTITY` + unique index on `app.jobs`, joined via `jobs_ingestion_run_idx` | `jobs.id` fallback | **Open** | `jobs` is empty; `jobs_ingestion_run_idx` exists (`jobs/migration.sql:103`) | D17 | one migration | approve |
| D20a | Supersession semantics | **newest successfully persisted ingestion wins**; a pending newer submission does not block an older one | newest submitted wins | **Open** | G2 reaches newer runs only through `weather_records → ingestion_runs → jobs` | D17, D20 | semantics + docs | approve |
| D21 | Single lock order | job → run in **every** transaction. `beginIngestionExecution` acquires the job row `FOR UPDATE` — same transaction, same lease predicate (`id AND lease_token AND status='running' AND lease_expires_at > now()`) — **before** any statement touches `ingestion_runs`. `settlePair` is job → run by construction. Both changes are required; neither alone restores a single order | keep run→job and classify `40P01` retryable | **Approved** — owner decision: Approve, no notes recorded | `climate.ts:253-296` (T2 run→job); `runner.ts:156-183` (`failTerminal`/`settle` run→job); `postgres.ts:288-330` (reaper job→run) | D15c, D16 | one added statement in T2 + replacement of two settlement paths; implementation pending | approved |

**Tally:** 31 IDs — **2 approved**, **18 open**, **1 superseded**, **10 deferred**.

Approved: `D21`, `D15c`. Owner decision recorded as "Approve", no notes, no timestamp invented. Approval is limited to these two IDs and implies nothing about any other decision.

Open: `D1`, `D2`, `D2a`, `D3`, `D5`, `D9`, `D9a`, `D9b`, `D9c`, `D15`, `D15a`, `D15d`, `D15e`, `D16`, `D17`, `D19`, `D20`, `D20a`.

### 5.1 Deferred historical IDs

| ID | Status | Reason | Reopening rule |
|---|---|---|---|
| D4, D6, D7, D8, D10, D11, D12, D13, D14, D18 | **Deferred — content unrecoverable; presumed outside 5.4 scope** | No resolution text exists in any durable source. The register above (D1–D21 plus E1–E12) covers the entire 5.4 design surface: lifecycle, persistence, supersession, concurrency, settlement, timeout, selector, ordering. A decision that does constrain 5.4 and is absent here would surface as a concrete hole during implementation | The owner may reopen any of them with one line. A decision that surfaces during implementation is escalated as a new decision, never improvised |

**Historical trace retained:** these IDs were tracked as gating decisions during planning; their content was never recorded and is not reconstructable. This document does not attempt it.

---

## 6. Resolved issues

| # | Issue | Resolution |
|---|---|---|
| R1 | Supersession FK could not express a two-phase write | Deferred FK on `superseded_by_id` only; `supersedes_id` stays immediate |
| R2 | Self-supersession was accepted by the database | Explicit `CHECK (superseded_by_id IS DISTINCT FROM id)`; probe confirmed the hole |
| R3 | Cycles were possible | Prevented by write-path construction; asserted by a recursive-CTE suite, not by an FK |
| R4 | `VALIDATE` after a plain `ADD CONSTRAINT` is a no-op | Probe: `convalidated=t` on plain add; `NOT VALID` + `VALIDATE` is the only meaningful form |
| R5 | The payload cannot exist before the fetch (`z.strictObject` requires `forecastRunId`) | Fetch-first; handler owns T1/T2 |
| R6 | T3 wrote a run terminal state without holding a lease | `settlePair` requires token + unexpired lease + `ROW_COUNT = 1` |
| R7 | A job could be settled `dead` over a `succeeded` run | `failed` mode on a terminal-success run degrades to adoption; job becomes `succeeded` |
| R8 | A connection failure at COMMIT was treated as a rollback | Three outcomes: known rollback / known commit / **unknown**; unknown never reaches T4 |
| R9 | The witness read could return a pre-commit snapshot and be mistaken for proof of rollback | Witness takes `FOR UPDATE` on job then run; it blocks until any in-flight T3 resolves |
| R10 | The advisory-lock wait could outlive the lease | Mandatory second lease revalidation **after** the lock is acquired |
| R11 | Advisory waits were assumed bounded only by `statement_timeout` | Probe: `lock_timeout` does cancel `pg_advisory_xact_lock` |
| R12 | `started_at` was treated as ingestion recency | It records run creation = fetch completion, which inverts business order under fetch-first |
| R13 | uuidv7 was treated as a sufficient ordering key | Monotonic within one backend (20 000 samples, 0 inversions); arbitrary across backends in the same millisecond |
| R14 | Two different ordering relations were in use | Collapsed to one unique scalar; `>` for G2, `<=` for retirement, no equality case |
| R15 | "Disjoint selectors do not block each other" was wrong | The advisory lock serialises all jobs for one `forecastRunId`; the guard merely does not reject them |
| R16 | T3 steps 3–6 were described as checks/metadata | `upsertCell`, the served-coordinate `UPDATE`, and the horizon extension are writes |
| R17 | G2 used a Cartesian product of cells × variables | Exact `(cellKey, variable)` matching via `unnest` zipping, with cardinality assertion and canonicalised inputs |
| R18 | "Newest submitted wins" was an overclaim | Retracted; semantics are "newest successfully persisted" |
| R19 | Retry was assumed to always be available | `retryable` at the ceiling is routed to `settlePair(mode:'failed')` |
| R20 | `dead + running` was described as unreachable without qualification | Classified per stage: latently reachable in 5.3 code, configured-unreachable today, unreachable by design after the settlement change |
| R21 | Job-missing reachability was justified by an FK | Corrected: the FK guarantees only that a non-null `ingestion_run_id` resolves |
| R22 | `queued` was treated as a terminal job state in settlement | `queued` → `lease_lost`, never a no-op |
| R23 | `unknown` and `inconsistent` were conflated | Two classifications: `unknown` = evidence not obtained; `inconsistent` = state read and invariant violated. Neither reaches T4 |
| R24 | `runId?` on `HandlerResult` was redundant | Removed; the locked job row is authoritative, `execution.runId` is a cross-check only |
| R25 | A-1 claimed `jobs_active_ingestion_idx` blocks a replacement job | **Withdrawn.** The index is partial on `status='running'` (`jobs/migration.sql:108-110`); a `dead` job is outside it. The real blocker is `jobs_identity_key`, and the real defect is the absence of any automated transition for the orphaned run |
| R26 | D15/D15a contradicted D15d over retry-budget ownership | Three layers: handler emits the outcome; runner owns the budget; `settlePair` performs the atomic transition. T3's success path is handler-settled because atomicity requires it, not because the handler owns policy |
| R27 | "The adapter lane is fully blocked by D5" | **Overstated.** D5 forbids real ingestion on a synthetic grid; adapter development and normalizer tests on synthetic fixtures are unaffected |
| R28 | Ten decision IDs were left as an open owner request | Dispositioned as deferred with a stated reason and a reopening rule |

Additional settled points carried from earlier rounds: the lease-margin question (no margin; revalidation plus transaction-start settlement are jointly sufficient, and lease extension would self-deadlock on the row the transaction already holds); sequence allocation is non-transactional so gaps are normal (probe: 1 → 2 rolled back → 3); retries never allocate a new sequence.

---

## 7. Outstanding issues by category

### A. Implementation blockers

**A-1 — A `dead` job can coexist with a `running` run, and nothing recovers it.**

| Field | Detail |
|---|---|
| Concrete impact | The `IngestionRun` stays `running` permanently. No actor transitions it, so every consumer joining run status observes an ingestion in flight forever. The same logical ingestion cannot be re-enqueued, because the `dead` job still occupies its identity key |
| Trigger | `failTerminal(job, error, execution)` with `execution === null` and `job.ingestion_run_id IS NOT NULL`: the run write is skipped (`runner.ts:154`), the job write is not |
| Evidence | `runner.ts:148-165`; reaper filter `postgres.ts:285-296`; `jobs_identity_key` + migration comment `jobs/migration.sql:24-26,53` |
| Is it still an invariant violation? | **Yes.** Phase 5.3 pairs `dead` with `failed`; a `running` run with no owner is a state the design declares impossible and provides no exit from |
| Can a replacement job reuse the run? | The partial index does **not** block it. `jobs_identity_key` blocks re-enqueue of the same `(kind, idempotency_key)`. A new `ingestionVersion` or selector yields a different key and a **different** run, orphaning the original rather than repairing it |
| What `jobs_active_ingestion_idx` actually prevents | Two **simultaneously running** jobs owning one `IngestionRun` |
| What the identity key prevents | A second job for the same `(kind, queue, forecastRunId, ingestionVersion)` |
| Automated recovery path today | **None.** The reaper scans `running` jobs only; no other actor writes run terminal state |
| Why not an accepted risk | The state is terminal-unreachable, silently inflates in-flight metrics, and its only exit is undocumented operator SQL that must also reset `attempt` |
| Why it does not trigger today | `handlers: []` (`main.ts:32`) — `execute` is never reached |
| Minimum action | Route every terminal settlement through `settlePair` (D15c), which reads the run id from the locked job row and does not depend on `execution`. Must ship in the same delivery as 5.4 |
| Current status | **Open.** `D15c` is approved, but the rest of the settlement contract — `D15` (T3 atomicity), `D15a` (settlement ownership), `D15d` (retry-budget ownership), `D15e` (`HandlerResult`) — is still open, so the blocker cannot yet be closed by decision. Nothing is implemented |

**A-2 — Lock-order inversion between the write paths and the reaper.**

| Field | Detail |
|---|---|
| Concrete impact | Two baseline paths lock **run → job**; the reaper, `settlePair`, T3, T4 and the witness lock **job → run**. Two transactions can close a cycle and PostgreSQL aborts one with `40P01` |
| Paths inverting | (1) `beginIngestionExecution` — INSERT/`ON CONFLICT DO UPDATE` on `ingestion_runs` at `climate.ts:253`, then `UPDATE app.jobs` at `:287`. (2) `failTerminal` and `settle` — `markIngestionStatus` (run) then `queue.fail`/`queue.succeed` (job), both inside one `db.$transaction` (`runner.ts:156-183`) |
| Interleaving A (T2) | A takes the run row at `climate.ts:253`; the reaper takes the job row at `postgres.ts:288` (the lease is already expired, so the job is a candidate); A waits for the job row, the reaper waits for the run row |
| Interleaving B (settlement) | The handler's `failTerminal` holds the run row via `markIngestionStatus` and waits for the job row via `queue.fail`; a concurrent reaper pass holds the job row and waits for the run row. This one is *more* reachable than A, because an exhausted retry budget is exactly the condition under which the lease is likely already expired |
| Frequency | Low, but ordinary — lease expiry coinciding with a claim or a terminal settlement. Not rare-by-construction |
| Consequence | The loser aborts. T2's rollback undoes its `attempt + 1` and `status='running'` write, and the settlement transaction rolls back entirely, so **no data damage**. But the handler receives an unclassified `40P01`, neither `LeaseLostError` nor `IngestionTerminalError` |
| Why not an accepted risk | The consolidation asserts a single lock order (job → run) for T3/T4/T5/witness. Two baseline paths falsify that assertion, so the design statement is currently untrue |
| Minimum action | **D21 + D15c together.** D21 adds a job-row `FOR UPDATE` — in the same transaction, with the same lease predicate — before `beginIngestionExecution` touches `ingestion_runs`. D15c replaces `failTerminal`/`settle` with `settlePair`, whose order is job → run by construction. Neither change alone restores a single order |
| Residual check | After both, no statement touches `ingestion_runs` before the owning job row is locked in the same transaction. This is the assertion D21 must be reviewed against, not the query count |
| Design status | **Approved.** `D21` and `D15c` are owner-approved; the design disagreement is closed and the ordering contract is now binding |
| Implementation status | **Pending.** Neither `beginIngestionExecution` nor the settlement paths have changed. The source still inverts, so A-2 remains an open implementation blocker |
| If D21 and D15c are declined | Not applicable — both are approved. The conditional fallback (classify `40P01` as `retryable`) is no longer the selected path |

### B. Owner decisions required

| Group | IDs | What it gates |
|---|---|---|
| Settlement contract | `D15`, `D15a`, `D15d`, `D15e` | T3/T4/T5 shape, `HandlerResult`, retry-budget ownership. `settlePair` (`D15c`) and the single lock order (`D21`) are approved but cannot be implemented until these are settled |
| Timeout policy | `D9`, `D9a`, `D9b`, `D9c`, `D19` | every transaction, worker bootstrap |
| Supersession + ordering | `D17`, `D20`, `D20a` | G2 predicate, retirement predicate, one migration |
| Schema/constraint change | `D1`, `D16` | one migration |
| Lifecycle ownership | `D2`, `D2a` | handler contract |
| Provider gate | `D3`, `D5` | adapter cycle instant; production ingestion |

Deferred, not requested: `D4`, `D6`–`D8`, `D10`–`D14`, `D18` (§5.1).

### C. Operational dependencies

| # | Dependency | Blocks |
|---|---|---|
| C-1 | `OPEN-03` — Open-Meteo commercial plan / non-commercial gate | any production ingestion |
| C-2 | `OPEN-18` — validated provider grid evidence | real ingestion only; adapter development on synthetic fixtures is unaffected |
| C-3 | `transaction_timeout` provisioning in `bootstrap/roles.sql` + bootstrap rerun (D9c) | the 15 s transaction bound; until then `lock_timeout` and `statement_timeout` are the only DB-side bounds |
| C-4 | `OPEN-05` — raw payload retention deferred | every derived artifact must record `reproducible: false` with a reason |
| C-5 | `gridSpecHash` fixtures for the two adapters | adapter tests |
| C-6 | `APP_SYSTEM_DATABASE_URL` + pool sizing | worker start |
| C-7 | Reaper/worker scheduling in the target environment | recovery latency |

### D. Accepted risks

| # | Risk | Mitigation |
|---|---|---|
| D-1 | G2 is blind to a newer submission that has not persisted | Accepted by D20a; bounded to one job interval at daily cadence; readers always see a coherent set because writers are serialised |
| D-2 | `jobs.id` fallback weakens same-millisecond cross-backend ordering | Documented; only acceptable if version bumps are operationally spaced |
| D-3 | Sequence gaps | Normal by construction; never a health signal |
| D-4 | Witness `lock_timeout` returns `unknown` | Safe; costs one cycle of latency |
| D-5 | `abandoned{unknown}` at the ceiling waits for the reaper | Up to one lease (60 s) on a rare path |
| D-6 | Inconsistent witness states self-heal through a retry, consuming attempt budget | Loud logging; if it fires, the cause is a bug elsewhere |
| D-7 | `settled` on an inconsistent state is a no-op, not a success | Contract wording: terminal, no further action |
| D-8 | The advisory lock serialises disjoint selectors | Bounded by `selectors_per_cycle × 15 s`; per-key locks are the measured escape hatch |
| D-9 | A lease can expire mid-transaction | Cosmetic `renewal_gap` logs; the outcome is still committed-or-rolled-back |
| D-10 | `lock_timeout = 5000` may starve under contention | Measurable; remedy is a longer witness budget, not a longer T3 budget |
| D-11 | `targetSelectorSchema` does not canonicalise — only the hash does | Handler must canonicalise identically to `canonicalArrayRules.cells`; unit test on the array builder, not only on the query |
| D-12 | A pre-existing database could contain a `dead`+`running` pair from the 5.3 latent path | Both tables are empty here; operator handling documented |
| D-13 *(not applicable)* | The lock-order inversion would be tolerated if D21 and D15c were declined | Both are approved, so this fallback is not the selected path. Retained for the historical record; A-2 is an open blocker until implemented |

### E. Deferred / out of scope

| # | Item | Destination |
|---|---|---|
| E-1 | `field_outlook_cells` write | follow-up phase (W2, `app_api` + `withTenant`) |
| E-2 | Raw payload retention | `OPEN-05` |
| E-3 | Strict newest-submission-wins | requires a durable submission registry + dead-submission lifecycle — a new phase |
| E-4 | Per-key ordered advisory locks | only if contention is measured |
| E-5 | Monthly aggregation and Phase 5.5–5.8 | later phases |
| E-6 | BMKG | licence-gated |
| E-7 | ERA5 / dataset-shaped ingestion | `OPEN-16` |
| E-8 | `wind_speed_10m_max` km/h→m/s | not approved; `unsupported_unit` |
| E-9 | Computed ensemble mean | rejected permanently |
| E-10 | Redis / BullMQ | rejected; PostgreSQL is the queue |

---

## 8. Master readiness matrix

| Area | Current state | Blocker? | Owner decision? | Dependency? | Evidence | Required action |
|---|---|---|---|---|---|---|
| Provider / licence | plan unconfirmed; free tier is non-commercial only | no | no | **yes (C-1)** | `OPEN-03` | confirm plan before production |
| Adapter / normalizer | development against synthetic fixtures is permitted and is the existing pattern; no forecast or ensemble adapter exists | no | **yes (D3, D5)** | no (dev) | `adapters/open-meteo-seasonal.ts`; `syntheticGridRegistry` | approve D3; build on synthetic fixtures |
| Grid registry | one `synthetic` entry; `requireValidated()` blocks real ingestion | no | **yes (D5)** | **yes (C-2)** | `grid.ts:380,606` | register a validated entry before production |
| ForecastRun | table + constraints exist; insert is `DO NOTHING` + read-back, never extends horizon | no | no | no | `climate.ts:152-209`; `domain_tables:347-361` | none |
| IngestionRun | table + constraints exist; `markIngestionStatus` lacks a lease predicate | no | **yes (D15c)** | no | `climate.ts:241-311,335-366` | settle through `settlePair` |
| Queue / job lifecycle | implemented at `a383c59`; settled | no | no | no | `postgres.ts:109-330` | none |
| Target selector | schema + canonical hash exist; the schema itself does not canonicalise | no | no | no | `contracts/climate.ts:111-119`; `canonical.ts:53-75` | canonicalise in the handler; unit-test the builder |
| WeatherRecord persistence | table + `NULLS NOT DISTINCT` live key exist; no writer | no | **yes (D16)** | no | `domain_tables:431-515` | implement T3 |
| Supersession | linked-list columns exist; FK/CHECK changes designed, not applied | no | **yes (D1, D16, D17, D20, D20a)** | no | probes R1–R4, R13–R17 | approve + one migration |
| Concurrency | advisory lock + ordering relation designed; `upsertCell` read-back lacks `FOR UPDATE`; **two baseline paths invert the lock order** | **A-2** | **yes (D16, D19)**; `D21` approved, implementation pending | no | `climate.ts:253-296`; `runner.ts:156-183`; `postgres.ts:288-330` | approve D16/D19; implement D21 (reorder T2); replace settlement via D15c |
| Lease fencing | client-side fencing exists in `renew`/`succeed`/`fail`; T3 revalidation designed | no | **yes (D9, D19)** | no | `postgres.ts:156-235` | implement revalidation |
| Recovery | witness, five classifications, ceiling routing designed; a `dead`+`running` pair has no automated exit | **A-1** | **yes (D15, D15a, D15d, D15e)**; `D15c` approved | no | `runner.ts:148-165`; `postgres.ts:285-296`; `jobs/migration.sql:24-26` | approve the remaining settlement decisions; ship settlement change with 5.4 |
| Settlement | `failTerminal` can write `dead` over a `running` run; `settlePair` contract approved, not implemented; ownership layers distinct | **A-1** | **yes (D15, D15a, D15d, D15e)**; `D15c` approved | no | `runner.ts:148-215` | approve the rest; implement `settlePair` |
| Database privilege | `app_system` has the needed grants; no `field_outlook_cells` | no | no | no | grants in `domain_tables` | none |
| Timeout | all four GUCs are `0`; `transaction_timeout` appears 0 times in the repo | no | **yes (D9, D9a–c, D19)** | **yes (C-3)** | `roles.sql:22-28`; grep = 0 | provision + startup probe |
| Observability | log vocabulary defined; none implemented | no | **yes (D15e)** | no | design record | implement with handler |
| Testing | plan covers settlement modes, run-NULL, retry budget, witness matrix, commit ambiguity, lock ordering, consistency | no | **yes (D15, D15a, D15d, D15e)**; `D15c` and `D21` approved | no | §9 | approve the rest, then implement |

---

## 9. Test plan (consolidated)

**Settlement modes**

1. `succeed` + run `running` → run = desired, job `succeeded`, both `ROW_COUNT = 1`.
2. `succeed` + run `partial` → run untouched, job `succeeded`.
3. `succeed` + run `failed` → job `dead`, run untouched.
4. `failed` + run `running` → run `failed` + job `dead`, atomic.
5. `failed` + run `succeeded` → job `succeeded`, **assert not `dead`**.
6. `adopt` + run `running` → `needs_terminal_decision`, zero writes.
7. `adopt` + run terminal → job follows run, zero writes to run.
8. Any mode with job `UPDATE` `ROW_COUNT = 0` → `LeaseLostError`, full rollback.

**Run NULL**

9. `failed` + `$run` NULL → job `dead`, no run write.
10. `adopt` + `$run` NULL → `InvariantViolation`.
11. `succeed` + `expectsRun=true` + NULL → `InvariantViolation`.
12. `succeed` + `expectsRun=false` + NULL → job `succeeded`.

**Retry budget**

13. `retryable` at the ceiling → `settlePair(mode:'failed')`; assert the pair is `dead`+`failed`, never `dead`+`running`.
14. `retryable` below the ceiling → `queue.fail(retryable)`; `attempt` unchanged; run stays `running`.
15. `abandoned{unknown}` at the ceiling → runner writes nothing; lease expires; the reaper writes run `failed` + job `dead` atomically.
16. `enqueue_seq` unchanged on every retry; `attempt` increments only in `claim`.

**Witness matrix**

17. `queued` + non-null run ref + run `running` (produced by a real reaper pass, not a seed) → `lease_lost`, no T4, no status change.
18. `running` + different token + run `running` (produced by a second claim) → `lease_lost`.
19. `running` + matching token + expired lease → `lease_lost`.
20. `running` + run terminal (seeded) → `inconsistent`; converges via retry → T2 refusal → `adopt`.
21. `dead` + run `running` (seeded via the legacy path) → `inconsistent`, `abandoned`, `orphan_running_run` logged, no automatic repair, job not resurrected.
22. `succeeded` + run `failed` (seeded) → `inconsistent`, `abandoned`, no T4.
23. `55P03` from the witness → **`unknown`**, explicitly asserted not `not_committed`; no T4.
24. `unknown` and `inconsistent` emit different log events and different counters.

**Commit ambiguity**

25. T3 commits on connection 1; the client socket is cut before the acknowledgement is read; the witness on connection 2 blocks, then reads `succeeded` → `settled`, zero extra writes, no second provider call.
26. T3 terminated server-side; the witness acquires immediately, reads `running`/`running` → `retryable`; retry converges to the same row count.
27. Takeover during the ambiguous window (token changed) → `lease_lost`; the reaper's attempt wins; no duplicate live rows.

**Lock ordering (A-2 / D21)**

28. **Structural assertion:** after D21, no statement in the T2 transaction touches `ingestion_runs` before the job row is locked. Verified by holding the job row in another session and asserting T2 blocks *before* any run row is created or updated.
29. **Structural assertion:** after D15c, `settlePair` touches the job row before the run row in all three modes; assert by holding each row in turn.
30. **Interleaving A:** lease expires; T2 blocks on the job row held by a reaper pass; assert no `40P01`, and that T2 either proceeds (job requeued and reclaimed) or raises `LeaseLostError`, with a rollback that leaves no `attempt + 1`.
31. **Interleaving B:** retry budget exhausted; hold the job row in a reaper pass while `failTerminal`/`settlePair` runs; assert no `40P01`, and that the settlement completes or aborts wholly.
32. **Regression:** run the full settlement suite against a frozen `a383c59` build and assert the inversion is reproduced (two `40P01` capable paths), then assert it is absent after D21 + D15c.

**Timeouts**

33. Advisory lock held by X: A blocks, then either `55P03` or `LeaseLostError` depending on timing; zero writes either way.
34. Witness and T4 on the same job concurrently → no `40P01`, because both take job then run.
35. `LOCK_TIMEOUT_MS` is one constant used by T2, T3, T4/T5 and the witness (asserted by import, not four literals).
36. `SHOW` of each `SET LOCAL` inside all transactions.

**Consistency invariants**

37. Property test over mode × run status × outcome: no input produces `dead` + `running`, or `dead` over `succeeded`/`partial`.
38. Post-suite: `count(*) FROM ingestion_runs r JOIN jobs j ON j.ingestion_run_id = r.id WHERE r.status IN ('succeeded','partial') AND j.status = 'dead'` = 0.
39. `weather_records` checksum unchanged across every adoption and failure path.
40. Exact footprint: disjoint selectors both succeed, correct live row count, no cross-supersession, serialised execution asserted rather than parallel.
41. Whole-run `provider_changed`: drift on one cell → zero `weather_records`, zero new `outlook_cells`, `horizon_end` unchanged, run `failed`, job `dead`.

---

## 10. Accepted risks

See §7.D (D-1 … D-12). D-13 is retained as not applicable because `D21` and `D15c` are approved. None is promoted to a blocker.

---

## 11. Operational dependencies

See §7.C (C-1 … C-7). Two are hard gates already recorded in the repository: `OPEN-03` and `OPEN-18`.

---

## 12. Final planning gate

| # | Criterion | Current |
|---|---|---|
| G1 | Every §7.A blocker is closed | **fails** — A-1 and A-2 remain open; both are implementation blockers, and neither is resolved by a decision alone |
| G2 | Every §7.B decision is explicitly approved | **fails** — 2 of 31 approved; 18 open |
| G3 | The ten deferred historical IDs are accepted as deferred, or reopened | **fails** |
| G4 | C-1 … C-3 satisfied or covered by an approved rollout plan | **fails** |
| G5 | No contradiction between the design and the source at `a383c59` | **fails** — the contradiction is decided (D21) but the source still inverts until D21 is implemented |
| G6 | Transaction boundaries, lease fencing and lock ordering fully defined and mutually consistent | **passes** — D21 and D15c are approved, so the ordering contract is defined and consistent |
| G7 | Retry and recovery defined for both attempt branches | **passes** |
| G8 | Persistence and supersession defined, including exact footprint and ordering relation | **passes** |
| G9 | Test plan covers failure and concurrency cases | **passes** |
| G10 | Scope not expanded beyond §2.1 | **passes** |
| G11 | No claim asserts a state the source does not support | **passes** |

**Six of eleven pass. Five fail.** Document completeness is not a gate criterion, which is why G6–G11 passing does not imply readiness. G6 passing records that the ordering *contract* is settled; it does not record that the code follows it.

---

## 13. Historical and superseded notes

| Item | History | Current position |
|---|---|---|
| Supersession ordering | "last completed write wins" → "newest started ingestion wins" → "newest submitted wins" → **"newest successfully persisted wins"** | last is current proposal, not approved |
| Ordering key | `started_at` → `(started_at, id)` → `jobs.id` (uuidv7) → `jobs.enqueue_seq` | `enqueue_seq` is the current proposal |
| Settle contract | `failTerminal` + `settle` (two implementations) → `settlePair` with `failed`/`adopt` → `settlePair` with `succeed`/`failed`/`adopt` | last is current; D15b superseded by D15e |
| Settlement ownership | "handler performs the retry-budget check" / "handler owns terminal settlement" | corrected into three layers (R26) |
| Witness | unlocked `SELECT` → `FOR UPDATE` on job only → `FOR UPDATE` job then run, five classifications | last is current |
| Lock ordering | assumed job→run everywhere | **two baseline paths are run→job**; A-2 open. `D21` approved; implementation pending |
| Owner approvals | none | `D21` and `D15c` approved. No timestamp or note recorded, because none was given. All other decisions remain open |
| `transaction_timeout` | assumed active at role level → **verified absent (0 occurrences)** | dependency C-3 / D9c, not a contract |
| A-1 impact | "the partial unique index blocks replacement" | **withdrawn** — the index is partial on `running`; `jobs_identity_key` is what blocks |
| `dead + running` | "unreachable" → "reachable via the legacy path" → stage-classified | latent in code, configured-unreachable, design-unreachable after `settlePair`; **not auto-recoverable** |
| Disjoint selectors | "do not block each other" → "serialised by the run-level advisory lock, not rejected by the guard" | last is current |
| G2 footprint | `cell_key = ANY(...) AND variable = ANY(...)` → exact `unnest` pair matching | last is current |
| Lease margin | "require a margin" → "no margin; revalidation plus transaction-start settlement are sufficient" | last is current |
| Retry ownership | handler decides terminality → runner owns the budget | last is current |
| `runId?` on `HandlerResult` | proposed → removed as redundant | last is current |
| D5 gate | "adapter lane fully blocked" | narrowed to real ingestion only |
| D4, D6–D8, D10–D14, D18 | tracked as gating decisions | deferred; content unrecoverable |

Resolved findings from earlier rounds are in §6 and must not be re-raised as active blockers.

---

## 14. Open owner decisions requiring explicit approval

No decision outside this list is approved.

**Two approved:** `D21` (single lock order) and `D15c` (`settlePair`). Owner decision: Approve. No notes were given, and none are recorded.

**Eighteen open:** `D1`, `D2`, `D2a`, `D3`, `D5`, `D9`, `D9a`, `D9b`, `D9c`, `D15`, `D15a`, `D15d`, `D15e`, `D16`, `D17`, `D19`, `D20`, `D20a`.

**Ten deferred decisions** (`D4`, `D6`–`D8`, `D10`–`D14`, `D18`): accept the disposition, or reopen with one line.

---

### Consolidation verdict

`CONSOLIDATION COMPLETE — READY FOR OWNER REVIEW`

**Scope of that verdict, stated precisely:** the *artifact* is complete — internally consistent, every claim checked against `a383c59`, every contradiction either reconciled or surfaced as a named blocker, and every remaining item an explicit owner decision. The *design* is not complete: 2 implementation blockers and 5 failed gate criteria remain.

**Readiness NOT claimed.** Phase 5.4 is not ready for implementation. Two approved decisions do not authorise implementation; `A-1` and `A-2` are open until their contracts are complete and the code follows them.

### Summary

| Metric | Count |
|---|---|
| Decisions approved | **2** (`D21`, `D15c`) |
| Decisions open | **18** |
| Decisions superseded | **1** (`D15b` → `D15e`) |
| Decisions deferred | **10** |
| Total decision IDs | **31** |
| Resolved issues | **28** |
| Implementation blockers | **2** (A-1 open; A-2 design approved, implementation pending) |
| Operational dependencies | **7** (2 hard gates: `OPEN-03`, `OPEN-18`) |
| Accepted risks | **12** (D-13 retained as not applicable) |
| Deferred items | **10** |
| Gate criteria passing | **6 of 11** |

### Top remaining actions

1. **Approve `D15`, `D15a`, `D15d`, `D15e`.** They complete the settlement contract; `D15c` and `D21` are approved but cannot be implemented until these are settled, and A-1 cannot close without them.
2. **Accept or reopen the ten deferred IDs.**
3. **Approve `D20a`, `D20`, `D17`** — supersession semantics and the ordering column; they decide one migration and two predicates.
4. **Approve `D9c` and provision `transaction_timeout`**, then rerun bootstrap. Until then the 15 s bound does not exist.
5. **Settle `OPEN-03` and `OPEN-18`.** Both are hard gates already recorded in the repository.
6. **Approve `D1`, `D16`, `D19`** — the remaining migration content and the lock policy.
7. **Approve `D2`, `D2a`, `D3`, `D5`** to start adapter work on synthetic fixtures.

---

## 15. Implementation outcome — 2026-11-23

This section records what was **built**, not what was approved. The approval
counters in §14 are unchanged: `D21` and `D15c` are owner-approved, and the rest of
the register is still open. Where implementation went beyond, or diverged from, the
approved list, it is named below.

### 15.1 Built on the consolidated text without owner approval

These were implemented because the consolidated text is the only coherent contract
that exists and the register's own verdict (`A-1` blocks until they are settled)
cannot be satisfied by waiting:

| Decision | What was built | Status |
|---|---|---|
| `D15`, `D15a`, `D15d`, `D15e` | `settlePair` in `packages/database/src/settlement.ts`: modes `succeed`/`failed`/`adopt`, authority re-verified from the locked job, run id from the locked row, row-count assertions, `partial` terminal, reaper adopts a terminal run instead of overwriting it | **implemented, not approved** |
| `D1` | Migration `20261123000000_weather_supersession`: `weather_records.superseded_by_id` → `DEFERRABLE INITIALLY DEFERRED`, plus `weather_records_no_self_supersession`; pre-flight validation block before either change | **implemented and applied, self-approved by the implementer — flagged for review** |
| `D20`, `D20a`, `D17` | Supersession predicates: cross-run ordered by `forecast_runs.initialized_at`, same-run by `ingestion_runs.created_at`; born-superseded INSERT; `supersedes_id` back-link; `GREATEST` horizon | implemented, not approved |
| `D9c` | **not implemented.** `transaction_timeout` is not configured and no document claims the 15 s rung | open, blocking nothing that is live |
| `D2`, `D2a`, `D3`, `D5` | One adapter module, `open-meteo-daily.ts`, both products, fixtures synthetic | implemented, not approved |

### 15.2 Implementation decisions the plan did not cover

- **`targetSelector` in the job payload.** Only the hash was stored, and a handler
  cannot fetch a cell it cannot name. The payload now carries the selector and the
  handler verifies it against the hash before fetching. This is a contract extension,
  recorded here because it changes `ingestionJobPayloadSchema`.
- **`succeed`/`fail` kept as thin delegations.** They remain on the `JobQueue`
  interface but both terminal writes now go through `settlePair`; `FailOutcome.terminal`
  survives as an alias so the existing integration suite keeps its subject.
- **The handler settles its own T3.** `HandlerResult` gained `settled` and
  `commit_ambiguous`, and the runner no longer writes the run status before the job
  status. Without this the pair could be split across two transactions, which is
  exactly what `D15c` exists to prevent.
- **The reaper adopts.** Writing `dead` over a `succeeded` run reports a failure that
  did not happen; one existing queue test was rewritten to the new contract.
- **`advisoryLockKeyOf`** maps a run UUID to a two-`integer` key (the tail 8 bytes).
  A text key would not match any `pg_advisory_xact_lock` signature.

### 15.3 Executed evidence

| Suite | Command | Result |
|---|---|---|
| contracts | `pnpm --filter @agroclimate/contracts test` | 12 files, **408 pass**, 0 fail |
| weather-core | `pnpm --filter @agroclimate/weather-core test` | 4 files, **61 pass**, 0 fail (9 new) |
| database unit | `pnpm --filter @agroclimate/database test` | **34 pass**, 0 fail |
| database integration | `pnpm --filter @agroclimate/database test:integration` | **91 pass**, 0 fail |
| worker unit | `pnpm --filter @agroclimate/worker test` | **2 pass**, 0 fail |
| worker integration | `pnpm --filter @agroclimate/worker test:integration` | **39 pass**, 0 fail (6 new `ingest.forecast` cases) |

Not executed in this round: the API suites, root `typecheck`, `prettier --check`,
`db:verify`, `test:schema`. No test calls a provider.

### 15.4 Still blocked

- `OPEN-03`: commercial production ingestion. The handler is registered, so a
  deployment that supplies a `validated` registry *and* a licence is the only thing
  between this code and live ingestion.
- `OPEN-18`: no grid is `validated`. The worker is given `syntheticGridRegistry`, so
  every real job dies `grid_not_validated` before a provider call.
- `peer-run writes`: two different forecast runs writing the same cells are not
  serialised; the per-run advisory lock does not cover that pair.

### 15.5 Corrections to earlier claims in this document

- `provenance-storage.md` and `tables-climate.md` **do exist**, under
  `docs/data-model/`. Any note that called them missing was wrong.
- The EC46 branch at `data-flow.md:62-66` is **not dead**: `ADR-001` keeps EC46 for
  15–45 days. It is unimplemented (Phase 5.6), which is a different statement.
- The job identity at `climate-data-foundation.md` §5.3 was corrected from
  `ingest:{queue}:{forecastRunId}:{targetSelectorHash}` to
  `…:{ingestionVersion}`, which is what `ingestionJobIdentityOf` has always built.
