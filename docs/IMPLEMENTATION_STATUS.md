# Implementation Status

Last updated: 2026-11-18.

## Phase 0 — Research & validation — **DONE (revised after adversarial review)**

| Deliverable | Status | File |
|---|---|---|
| Weather source matrix | done, corrected | `docs/research/weather-source-matrix.md` |
| Agronomic reference matrix | done, corrected | `docs/research/agronomic-reference-matrix.md` |
| Forecast horizon capabilities | done, corrected | `docs/research/forecast-horizon-capabilities.md` |
| Data licensing & attribution | done | `docs/research/data-licensing-and-attribution.md` |
| ADR-001 provider strategy | done (Proposed, revised) | `docs/adr/ADR-001-weather-data-provider-strategy.md` |
| UI reference analysis (Phase 2 input) | done | `docs/design/ui-reference-analysis.md` |
| Adversarial review + amendment log | done | `docs/review/phase-0-review.md` |
| `council` review | **not run — agent not configured in this environment.** Substituted with an oracle adversarial pass; recorded as a process gap. | — |

### Verified by live request (2026-11-18, twice — second pass fixed the first pass's errors)

`api.bmkg.go.id` 3-day village forecast, 17 slots, `tp` present · Open-Meteo forecast cap 16 d · **ensemble: 50 members, data null after day 14** · EC46: 46 daily rows, no monthly product · SEAS5: 50 members, **6 monthly rows by default / 7 at `forecast_days=200–217`**, cap 217 · archive API from 1940 · historical-forecast API `ecmwf_ifs04` · NASA POWER monthly 1991–1993 · seasonal `*_spread` variables rejected (400).

### Blocking constraints recorded

1. BMKG ToU §9.3 — commercial integration needs written permission; feature flag OFF by default.
2. Open-Meteo free tier is non-commercial only — paid plan or self-host required.
3. No free gridded annual outlook — months 8–12 are climatology, permanently labelled.
4. CHIRPS bulk host unreachable from this environment — ERA5 archive is the shipped baseline fallback.
5. Model-relative anomalies are the primary user-facing number; baseline differences require grid matching and offset disclosure.
6. **ECMWF Set VII (13-month) is real but unproven for access** — months 8–12 stay climatology until a licence enquiry + GRIB POC succeed (ADR-001 D2a).
7. **All probes were one location (Jakarta).** No provider is validated for real plot coordinates yet; see `forecast-horizon-capabilities.md` §4.

### Review rounds

1. Oracle adversarial pass — found the wrong ensemble horizon (35 d → 14 d), wrong member count, wrong seasonal row count, and a bias-contaminated anomaly contract. Amended.
2. External (GPT) review — accepted on CHIRPS licensing (public domain **and** CC BY 4.0), on overclaiming "bias-free by construction", on coarse data classes, and on single-location validation. Set VII finding verified as a real product but not as accessible data. Amended.

## Next phases

Phase 1 (product requirements, system architecture, ADR-002) — **complete; reconciled in Phase 1.1 and accepted**.

| Phase 1 deliverable | Status | File |
|---|---|---|
| Product definition | done | `docs/PROJECT.md` |
| System architecture + Mermaid | done | `docs/architecture/system-architecture.md` |
| Domain model (conceptual) | done | `docs/architecture/domain-model.md` |
| Data flow | done | `docs/architecture/data-flow.md` |
| Background processing | done | `docs/architecture/background-processing.md` |
| API conventions | done | `docs/architecture/api-conventions.md` |
| **Provenance & evidence contract (normative)** | done | `docs/architecture/provenance-contract.md` |
| ADR-002 monorepo & backend | done (Proposed) | `docs/adr/ADR-002-monorepo-and-backend-architecture.md` |
| Phase 1.1 architecture review | done | `docs/review/phase-1-architecture-review.md` |

### Phase 1.1 outcome

Twelve findings, ten decisions accepted, six rejected. The two that change the physical design, not just the prose:

1. **`ForecastRun` and `IngestionRun` are separate identities**, so re-normalizing a retained payload cannot surface to users as a new forecast.
2. **`PlantingWindow` carries `EvidenceSegment[]`**, so a window crossing daily → weekly → monthly → climatology reports what it actually used instead of one class that must be a lie.

Vocabulary is now fixed: `dataClass` (canonical), `evaluationBasis`, `dataAvailability`, `forecastRunId`/`ingestionRunId`, `inputRefs[]` + `fieldSnapshot` + `inputSnapshotHash`. `temporalClass`, `precision`, bare `runId`, `outlookRunId`, `inputRunRefs`, `sourceRunIds`, and `DATA_STALE` are removed or deprecated with no live uses.

Queues reduced 10 → 6 by merging sets that shared provider, budget, retry shape, and failure mode, and by deleting `recompute.briefings` (cache invalidation is not a queue).

Phase 2 gate (unblocked): implement `withTenant` as the only DB entry point and prove isolation before features land; make `dataClass`/`evaluationBasis`/`dataAvailability`/`freshness` required in `packages/contracts` from the first weather-emitting commit; build adapters against the split run identity from the start.

### Phase 1.2 outcome — final consistency correction

Ten further findings (F13–F22), all resolved. These change **types**, not architecture; no Phase 1.1 decision was overturned.

| Correction | Effect |
|---|---|
| `inputRefs` is a four-variant union (forecast / baseline / observation / dataset) | climatology no longer needs a `forecastRunId` it does not have |
| API `WeatherValue` is a union discriminated on `dataClass`, with `source?: never` on climatology | "climatology with an `initializedAt`" is now a compile error; `displayedClass` deleted |
| `FieldSnapshot` (soil, pH, drainage, irrigation, geometry, extraction policy, resolved cells, observations) enters `inputSnapshotHash` | the hash finally means *identical computation inputs*, not just identical weather |
| One id space: UUIDv7 for PKs, URLs, and `app.user_id` | ULID removed; the `::uuid` cast in the RLS policy is now true |
| `withTenant` uses `$queryRaw` (row-returning) | `$executeRaw` was discarding `set_config`'s result — that failure mode is a cross-tenant read |
| Worker roles split: `app_system` (`BYPASSRLS`) for non-tenant jobs, `app_api` + `withTenant` for `recompute.windows` | fan-out re-specified as per-owner batches of ≤100, since a cross-tenant batch cannot run under one `app.user_id` |
| Climatology licensed **only** by `beyond_horizon` | obsolete "falls to climatology when SEAS5 is unavailable" rule removed from `background-processing` §8 |
| `IngestionRun.ingestionVersion` (identity) vs `attempt` (retry counter) | a retry storm no longer mints rows or multiplies record counts |
| v1 rejects >5 000-vertex polygons instead of simplifying them | removed a metre-tolerance claim that was actually degrees |
| Segment partition invariant is executable | `segments ∪ missingRanges` must cover the window exactly, or the window is not persisted |

Phase 2 gate unchanged and confirmed: `withTenant` first, `oneOf` contract with a negative climatology fixture, separate DB roles from the first commit.

### Phase 1.3 outcome — final contract corrections

Six cross-document contradictions (F23–F28), all closed. No Phase 0/1.1/1.2 decision reopened.

| Correction | Effect |
|---|---|
| `maintenance` is read-and-enqueue only (§10) | briefing invalidation has exactly one executor: `recompute.windows` under `app_api` + `withTenant(ownerId)`. `BYPASSRLS` no longer appears to write `ai_briefings`. |
| Derived freshness is **computed at read time**, not stored | "mark stale" is not an operation, so no tenant write is needed to keep a status honest. Failed recompute is the one stored stale state, because it is an event. |
| `ForecastRun.id` = UUIDv7; `(provider, model, product, initializedAt)` = natural key only | the composite string is now used only to name what is forbidden, not as an identifier anywhere |
| `purpose` is orthogonal to `kind`/`role` | `verification_truth` is no longer a role; CHIRPS-as-truth is `dataset/satellite_estimate` + `purpose:"verification_truth"`. `annual_outlook` added as a forecast role. Role→`dataClass` table is explicit. |
| `withTenant(userId: UUID, fn)` | requests pass `user.id`, workers pass `ownerId`; no job has to fabricate a user object |
| `SegmentProvenance` names `ingestionRunIds` too | a segment can explain why the same forecast day changed after a normalizer bump |
| Hash descriptor: one name (`inputRefs`), snapshot hash not snapshot body | duplicated `extractionPolicy`/`resolvedCells` removed |

Verification is **static only** — document agreement, not runtime behaviour. Phase 2 gate sharper: `withTenant` isolation test, `oneOf` negative fixture, and a test asserting `app_system` cannot write a tenant-owned table.

### Phase 1.4 outcome — hash contract closable

Four findings (F29–F32), all from an external read verified against the files. Two were blockers.

| Correction | Effect |
|---|---|
| `fieldSnapshotHash` preimage is `Omit<FieldSnapshot, "fieldSnapshotHash">` | the hash no longer contains its own output — it was unimplementable as written |
| `DerivationDescriptor` is a four-variant union | `"artifact": "planting_window"` previously served three artifact types, so a suitability run could hash-collide with a window; `artifact` is inside the hash, so the collision was silent |
| `ai_briefing` gains `sourceArtifactHashes` | without it, a new `engineVersion` produced different windows while the briefing hash stayed put — a direct violation of the invariant |
| `app_system` restriction expressed as column-level `GRANT`s | prose does not bind a `BYPASSRLS` role; Phase 2 asserts the forbidden reads and writes actually fail |
| "flagged stale" removed from `background-processing` §8 | no `is_stale` column is written; staleness is computed |

Rejected: a separate `contextHash` for briefings (R14), one descriptor shape with optional fields (R15), an `is_stale` column for query convenience (R16).

Phase 2 readiness: **yes, and no further architecture pass is warranted**. Remaining uncertainty is implementation, which documents cannot resolve.

## Phase 2 — Implementation (in progress)

| Sub-phase | Outcome | Evidence |
|---|---|---|
| 2.0 monorepo + shared contracts | done | 3 deployables, 1 package, 42 files, commit `d4b4b89` |
| 2.0.x contract corrections | done | calendar-valid dates, UTC-only instants, canonical `firstRefId`, commit `9c21576` |
| 2.1 canonical JSON + SHA-256 | done, runtime-verified | `packages/contracts/src/canonical.ts`, `hash.ts`, golden vectors |
| 2.1.x canonical serializer hardening | done, runtime-verified | explicit key order, dense arrays, plain objects, no accessor execution |
| 2.2.1 PostgreSQL + PostGIS foundation | done, runtime-verified | `docker-compose.yml`, `packages/database`, `20261118000000_init_extensions` |
| 2.2.1.x database foundation hardening | done, runtime-verified | single env source, fail-closed production, generated-client lifecycle, loopback binding, `pg_catalog` guard |

### Phase 2.1 outcome

Canonical JSON is one implementation with declared rules, and every artifact hash is `sha256Hex(canonicalJson(...))` — there is no per-artifact serialiser to drift.

| Decision | Effect |
|---|---|
| Arrays are canonicalised depth-first, then the parent sorts | `inputRefs` order is computed from canonical values, never from provider emission order |
| An array with no declared rule throws | a new array on a hashed type must be classified as set or sequence before it can be hashed |
| `undefined`, `NaN`, `±Infinity`, cycles throw | nothing is silently dropped or written as `null` |
| Numbers use `Number::toString`; `-0` → `0` | deterministic without reformatting or rounding |
| Timestamps are representation-preserving | `…:00Z` and `…:00.000Z` are distinct preimages, by decision rather than omission |
| Known-answer digests come from coreutils | the hash test does not validate itself against itself |

Verification is **runtime for the contract layer** (125 tests including permutation, change-detection, dedupe-conflict, and known-answer vectors) and **absent for everything else** — no database, no queue, no provider adapter exists to verify.

### Phase 2.1.x outcome

Three serializer defects were reproduced before being fixed, and a fourth was found by external review.

| Defect | Evidence | Fix |
|---|---|---|
| Sorted keys were re-ordered on emit | `Object.keys({"10":…,"2":…})` returns `2, 10` | objects carried as an explicit sorted entry list |
| Own `__proto__` was lost or mutated the prototype | `out["__proto__"] = v` invokes the setter | same entry list; nothing is assigned |
| Sparse arrays emitted invalid JSON | `[,'x']` from `map()` + `join()` | every index read through `getOwnPropertyDescriptor` |
| Array accessors were executed | `map()` calls the getter | descriptor check rejects, getter invocation count asserted `0` |

Non-plain objects (`Date`, `Map`, `Set`, `RegExp`, class instances), accessor properties, and symbol keys now throw instead of serialising as `{}`. The reference payload hash `42e89699…` is unchanged, so supported input produces byte-identical output.

### Phase 2.2.1 outcome — PostgreSQL + PostGIS foundation

Runtime-verified against a live container: PostgreSQL 18.6, PostGIS 3.6.4, `uuidv7()` native, `ST_SRID` 4326, session time zone UTC, migration ledger applied, all reached through the Prisma 7 client.

| Decision | Effect |
|---|---|
| PostgreSQL 18, so `uuidv7()` is native | no extension, no application generator, no hand-rolled PL/pgSQL; the migration aborts if `uuidv7()` is absent |
| Migrations are hand-written SQL, applied with `migrate deploy` | `migrate dev` would diff against a shadow database that contains PostGIS's own `spatial_ref_sys` table — verified via `prisma db pull --print` |
| Prisma 7 driver adapter (`@prisma/adapter-pg` over `pg`) | no bundled query engine; pool behaviour is `pg`'s, which 2.2.3 assertions will target |
| No domain tables | Phase 3 owns them; nothing is persisted yet, so `inputSnapshotHash` still has no consumer |
| Port 5442 | the host already runs unrelated PostgreSQL on 5432 and 5433 |
| `prisma` pinned to 7.10.1 | npm's `latest` tag currently points at `8.0.0-rc.34` |

Next: 2.2.2 database roles and privileges (`app_api`, `app_system`, explicit grants, default-deny), then 2.2.3 RLS with transaction-scoped `set_config`, then 2.2.4 security tests executed as the real roles.

### Phase 2.2.1.x outcome — hardening

Five findings, all corrected and each verified by running something, not by reading the diff.

| Finding | Was | Evidence it was real | Now |
|---|---|---|---|
| Configuration could diverge (P1) | Compose read root `.env`; Prisma read only `process.env` from a different cwd | a root `.env` existed and Prisma silently ignored it | `.env` resolved from `prisma.config.ts`'s own path; URL derived from the same `POSTGRES_*` Compose uses; `DATABASE_URL` overrides |
| Generated client lifecycle (P1) | `typecheck` was `tsc` only; Turbo's `^build` does not build the package itself | clean checkout + `pnpm typecheck` had no client to compile against | `typecheck` runs `prisma generate` first; verified with `rm -rf src/generated` **and** an empty Turbo cache |
| Port exposure (P2) | `0.0.0.0:5442` | `ss -ltn` showed all interfaces | `127.0.0.1:${POSTGRES_PORT}:5432` |
| Weak `uuidv7()` guard (P2) | `pg_proc.proname` + `pronargs`, any schema | with a `public.uuidv7()` stub the old predicate matched 2 functions | `to_regprocedure('pg_catalog.uuidv7()')`; wrong signature aborts |
| Production config not fail-closed (P2) | fell back to localhost unless `NODE_ENV === "production"` | unset `NODE_ENV` reached localhost | only `NODE_ENV === "development"` may guess; connecting commands throw without a URL |

Also recorded: schema migrations require a dedicated privileged owner connection, not `app_api` or `app_system` (role itself lands in 2.2.2). The dev password default changed from the project name to `agroclimate-dev`, because a credential identical to an identifier appears in logs and greps where it does not belong — and, concretely, the old value collided with every `@agroclimate/*` package name in tool output.

One measurement changed a documented assumption rather than confirming it: `migrate deploy` does not compare migration checksums. Tampering with an applied migration's checksum left `migrate status` reporting "up to date" and `migrate deploy` reporting "no pending migrations". Editing applied SQL is therefore silently accepted, which makes review the only gate — recorded in `database-foundation.md` in place of the earlier claim that Prisma would refuse.

Verification: runtime for all five. Clean-checkout typecheck with an empty Turbo cache (`0 cached, 6 total`), custom `.env` (port 5443, `agro_alt`/`agro_alt_db`) reaching the intended database, process-env override failing on the overridden host, and both absence cases aborting before connecting.
