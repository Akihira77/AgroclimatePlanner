# Owner Decisions

The short list of questions that **only the product owner can answer**. Everything
else is engineering work and proceeds without asking.

This is a request queue, not a register. `docs/data-model/open-decisions.md` remains
authoritative for all 29 `OPEN` items, their severity, what each blocks, and what
would settle it. When an item here is settled, the settlement is recorded **there**,
in §4, and the row here is marked `SETTLED <date>`.

Answering is cheap: name the option, or say "your recommendation". A row left
unanswered keeps its default, and the default is always "stay blocked, do not
guess" — no threshold or vocabulary is invented to fill a gap.

## 1. Decide now — these gate the next slice

| ID | Question | Options | Recommendation | Unblocks | Cost of waiting |
|---|---|---|---|---|---|
| `OPEN-20` — **SETTLED 2026-11-28** | *Answered (b).* Which graded thresholds ship in the first published crop profiles? | (a) padi + jagung only, hard gates only where evidence is grade A; **(b) all four crops with `water = insufficient_data` where evidence is thin — chosen**; (c) wait for a full agronomic baseline | (b) — shipping a profile that says "insufficient_data" is honest and lets the engine, UI, and window generator be exercised end to end; a profile set of two crops does not | Catalog seed, suitability runs, window generation, the agronomy screens | Settled: seed shipped as `pnpm db:seed:catalog`; resolution recorded in `docs/data-model/open-decisions.md` §3 |
| `OPEN-21` | How do `soil_type`, `drainage_class`, `irrigation_availability` become a `FieldSnapshot`, and how does `irrigation_available` become the boolean the contract requires? | (a) `CHECK` list per column + an explicit mapping table; (b) lookup tables with FK; (c) a boolean column replacing the text | (a) — a `CHECK` plus one documented mapping keeps the values closed without a join, and the mapping is the part that must be written down | Field → snapshot construction, every water-dependent verdict, `fieldSnapshotHash` | No field can produce a snapshot; suitability cannot run at all |
| `OPEN-27` | How does the worker learn which fields a cell serves without reading tenant rows? | (a) a `security definer` function returning field ids for a cell; (b) a narrow `app_system` grant on a projection table maintained by trigger; (c) worker reads nothing — API enqueues per-field jobs | (c) first, if the API can enqueue cheaply; otherwise (a) — no standing cross-tenant grant on a tenant-owned table | `recompute.windows`, the job that delivers a new forecast to a dashboard | Phase 9's recomputation pipeline, and the "new run changes the window" scenario |
| `OPEN-11` | What shape is a `ClimateBriefing` body? | (a) a bounded JSON document with sections that each cite evidence segment ids; (b) free-form text plus citations; (c) not in v1 | (a) — deterministic validation is the point; free text cannot be checked against evidence and cannot be tested | `ai_briefings` writes and validation, the AI slice | AI slice stays unimplementable |
| `OPEN-18` | Accept `ADR-008` grid-cell selection semantics, and which `(provider, model)` entries are `validated`? | (a) accept `ADR-008` and ship `ecmwf_ifs025` as `unvalidated` with nearest-centre selection; (b) accept but require a second evidence pass for grade A geometry first; (c) keep `centroid` policy only | (a) — an entry labelled `unvalidated` is a truthful label, and it makes the resolver expressible without claiming evidence that does not exist | Per-provider grid configuration, field → cell resolution for real data | Real-data climate reads stay on synthetic fixtures |
| `OPEN-17` | Are point-shaped fields supported in v1? | (a) disallow `POINT` for now; (b) `areaHa` nullable for a point, declared area unknown; (c) derive an area from a declared radius | (b) — "I do not know my plot boundary" is a real user, and nullable keeps the unknown visible instead of inventing a number. Costs an ADR because the contract changes | Snapshot for point fields | Point fields create, but cannot produce a snapshot |
| `OPEN-09` | `plantings.status` vocabulary | `active` · `harvested` · `failed` · `abandoned` | that four, as the workflow already implies | Default and partial index on `plantings`, the first writer | Planting/harvest records stay unwritable |
| `OPEN-04` | Account deletion policy | (a) soft delete + anonymise after a grace period; (b) hard delete with cascade; (c) defer deletion out of v1 | (a) — reversible during the grace window, and the partial unique email index then has an unambiguous definition | Deletion path, `users` email index | No deletion workflow; the index question stays open |

## 2. Deliberately deferred — do not ask again until the trigger

| ID | Standing decision | Revisit when |
|---|---|---|
| `OPEN-03` | No Open-Meteo paid plan committed | commercial production deployment, or scheduled production ingestion |
| `OPEN-05` | Raw payload retention postponed | legality, storage cost, and reproducibility need are all settled |
| `OPEN-02` | BMKG adapter off, labelled fallback ships | written permission obtained |
| `OPEN-28` | Signed tenant context not required | a leaked DSN is in scope |

## 3. Acceptance — yours, not the agent's

Implementation and tests can be proven by the repository. Whether the product is
**useful** cannot. These are checked off by you, against a running app, after the
evidence is presented.

| Group | What you are accepting | Evidence that will be put in front of you |
|---|---|---|
| Core platform | auth, tenant isolation, farm/field management, catalog and profile versioning | integration test output, two-tenant isolation run |
| Climate intelligence | daily + subseasonal, seasonal, climatology, 12-month timeline, provenance and freshness | route responses with `dataClass`/`model`/`initializedAt` on every day |
| Agricultural intelligence | suitability, stage alignment, window generation, evidence partition, explainable reasons, versioned sourced rules | one scenario per crop with its verdict, reasons, and the thresholds behind them |
| User experience | dashboard, fields, catalog, charts, calendar, opportunities, records, responsive | screenshots against seeded data |
| AI | grounded briefing, structured validation, deterministic fallback, prompt model audit | one briefing with segment citations, plus the fallback path |
| Operations | monitoring, forecast verification, security review, backup/restore, deployment runbook | dashboards, a restore rehearsal log, the review report |

Nothing in this section is ticked by the agent. A green test suite is a
precondition, not an acceptance.

## 4. Proceeds without any decision

Recorded so the answer to "why is work still happening?" is on the page:

- Suitability assembly over caller-supplied profile + snapshot + daily series, with
  fixture-only inputs — the constraint evaluator and stage alignment already exist.
- Planting-window generation as a pure function over a suitability series; only its
  **persistence** waits on `OPEN-26`/`OPEN-27` and a generated window.
- Frontend work on the contracts that already ship.
- Monitoring, observability, and operational documentation that reads existing tables.
- Test and type hardening of anything already merged.

These stay blocked until §1 is answered: field snapshot construction (`OPEN-21`),
real-data cell resolution (`OPEN-18`), production recomputation (`OPEN-27`), AI
briefing (`OPEN-11`), point-field snapshots (`OPEN-17`), planting records
(`OPEN-09`), account deletion (`OPEN-04`). Catalog seed content (`OPEN-20`) came off
this list on 2026-11-28; the queue keeps the answered row for its record.
