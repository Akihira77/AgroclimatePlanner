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

## Phase 2 — Implementation (**complete**)

| Sub-phase | Outcome | Evidence |
|---|---|---|
| 2.0 monorepo + shared contracts | done | 3 deployables, 1 package, 42 files, commit `d4b4b89` |
| 2.0.x contract corrections | done | calendar-valid dates, UTC-only instants, canonical `firstRefId`, commit `9c21576` |
| 2.1 canonical JSON + SHA-256 | done, runtime-verified | `packages/contracts/src/canonical.ts`, `hash.ts`, golden vectors |
| 2.1.x canonical serializer hardening | done, runtime-verified | explicit key order, dense arrays, plain objects, no accessor execution |
| 2.2.1 PostgreSQL + PostGIS foundation | done, runtime-verified | `docker-compose.yml`, `packages/database`, `20261118000000_init_extensions` |
| 2.2.1.x database foundation hardening | done, runtime-verified | single env source, fail-closed production, generated-client lifecycle, loopback binding, `pg_catalog` guard |
| 2.2.2 roles and privilege boundary | done, runtime-verified | `bootstrap/roles.sql`, `db:bootstrap`, `db:verify` (61 assertions as the real roles) |
| 2.2.2.x role boundary hardening | done, runtime-verified | per-run probe names, `db:verify:probes`, bootstrap idempotency, fresh-volume reset in an isolated Compose project (65 assertions) |
| 2.2.3 tenant tables, RLS, `withTenant` | done, runtime-verified | `app.users`/`app.farms`/`app.fields`, 3 RLS policies, `createTenantScope`, 10 RLS tests + 9 unit tests, 118 assertions in `db:verify` |
| 2.3 physical data model specification | **done (specification only), approval withheld** | `docs/data-model/` (16 files: 13 numbered + 2 supporting + README), `docs/adr/ADR-003-trusted-tenant-context.md`; no migration, no schema change |
| 2.3.x documentation corrections | done, documentation-only | severity scheme reconciled (no P0), `OPEN-26` added to the blocker matrix, geometry-hash terminology corrected, `area_ha` nullability corrected to the measured DDL, cross-reference and count audit |
| 2.3.x.1 blocker classification | done, documentation-only | all 14 P1 items classified in one matrix: 1 `Phase 3 DDL` (`OPEN-09`), 12 `after Phase 3`, 1 `not blocking`; `OPEN-09`'s DDL dependency found and recorded; "ingestion can proceed" corrected |
| 2.4 decision closure | done, documentation-only | every `OPEN-nn` given one disposition — 0 `RESOLVED`, 20 `DEFERRED`, 9 `BLOCKED_EXTERNAL_INPUT`, 0 `NOT_APPLICABLE`; `D26` removes the last `Phase 3 DDL` blocker by omission; blocking split from severity |
| 3 physical database implementation | done, runtime-verified | `20261118030000_domain_tables`: 19 tables → 22 total, 36 FK, 116 `CHECK`, 20 policies, `app_system` still default-deny on tenant data; 355 `db:verify` assertions, 39 RLS tests, 12 schema-conformance tests, clean-volume install |

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

Next at the time: 2.2.2 roles and privileges, then 2.2.3 RLS, then 2.2.4 security tests as the real roles. Delivered in the 2.2.2 outcome below.

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

### Phase 2.2.2 outcome — roles and privilege boundary

Three roles, one schema, default deny, and 61 assertions that run over TCP as the role they are about. A denial counts only at SQLSTATE `42501`, so a missing table or a bad credential fails the check rather than passing as a boundary.

| Decision | Effect |
|---|---|
| Roles are created by a bootstrap script as the cluster admin, not by a migration | `CREATE ROLE` is a cluster privilege; a compromised migration connection cannot mint roles |
| Roles are created `NOLOGIN`; passwords applied afterwards from the environment | no credential in any committed file, and none in a statement that gets logged |
| `NOINHERIT` on all three, no memberships | no privilege path to walk and no `SET ROLE` escalation |
| Application objects live in schema `app`, owned by `migration_owner` | `public` stays PostGIS's; the ledger moves out of the extension namespace |
| Runtime roles get `USAGE` on `app` and nothing else | no table, sequence, or function privilege exists until a migration grants one |
| `db:reset` re-runs `db:bootstrap` before `db:migrate` | the volume owns the roles too — `initdb` runs once |
| Privileges are verified, not merely granted | the grant matrix is a claim; `db:verify` is the check |

Two of these were decided by measurement, not by preference.

**`ALTER DEFAULT PRIVILEGES … IN SCHEMA app REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC` does nothing.** It records no `pg_default_acl` row, and a function created afterwards was still executable by `app_api`. The unqualified form stores `{migration_owner=X/migration_owner}` and works. Both forms were tried, and the schema-qualified one, with `FOR ROLE migration_owner`, and as the owning role itself — all no-ops.

**Default-privilege entries for tables and sequences are unnecessary.** PostgreSQL grants no table or sequence privilege to other roles by default, so a `REVOKE` for them records nothing because there is nothing to remove. The assertion that matters is behavioural — a table created after the bootstrap is unreadable by both runtime roles — not the presence of a catalogue row.

Probe objects (`app.privilege_probe`, its sequence, its function) exist only for the duration of a verification run and are dropped in a `finally` block.

Not verified here: `app_system` denied `SELECT geom FROM fields` and `SELECT body FROM ai_briefings`. Those tables are Phase 3. The column-level mechanism is proven against a probe table instead — one granted column readable, its neighbour denied, `SELECT *` denied, and removal of the grant taking effect immediately.

### Phase 2.2.2.x outcome — role boundary hardening

Four defects in the 2.2.2 verification itself, all closed and each re-measured.

| Defect | Was | Evidence | Now |
|---|---|---|---|
| Probe fixtures had static names | `app.privilege_probe`, `_sequence`, `_function` | two concurrent runs would `drop table` each other's fixture; a real object with that name would be deleted | 12-hex token per run, `privilege_probe_{t,s,f}_<token>`; only objects this run created are dropped |
| Cleanup could not be tested | `finally` block, untested | a failed setup was never exercised | verification is a library; `db:verify:probes` drives the failure path through an `afterProbeSetup` hook and asserts the schema is clean |
| Direct schema grants were never normalised | only `REVOKE ALL … FROM PUBLIC` + `GRANT USAGE` | a hand-added `GRANT CREATE ON SCHEMA app` would have survived a re-bootstrap | `REVOKE ALL ON SCHEMA app FROM app_api, app_system` before granting `USAGE`, plus `REVOKE CREATE ON SCHEMA public` for both |
| The reset path was never executed end to end | `db:reset` existed, had only ever run against the development volume | role bootstrap was added to it in 2.2.2 without a fresh-volume run | executed in an isolated Compose project (port 5542, own container name, own volume) |

Bootstrap idempotency is now an assertion rather than a claim: `db:verify` plants a direct `CREATE` grant, re-runs `bootstrap.mjs` as the cluster admin, and asserts the grant is gone while `USAGE` remains. Where cluster-admin credentials are unavailable the check reports `SKIP` with its reason and is excluded from the pass count.

Fresh-volume run, isolated project `agroclimate-reset-check` on port 5542: `db:reset` applied the baseline migration, `db:verify` reported 65 passes and 0 failures, `db:status` reported "Database schema is up to date!". The development container was untouched (same start timestamp, same volume, same ledger row count) and the isolated project's container, network, and volume were removed afterwards.

Also fixed while doing this: connection resolution for the three scripts had drifted into three copies, and the two that loaded the root `.env` had already disagreed about its path. It is now `scripts/lib/connections.mjs`, one implementation for bootstrap, verification, and the RLS tests.

Next: 2.2.3 tenant-owned tables and RLS with transaction-scoped `set_config(..., true)`, then 2.2.4 security assertions against the real domain tables.

### Phase 2.2.3 outcome — tenant isolation enforced by PostgreSQL

Three tables, three policies, one entry point, and ten tests that run as the roles they are about.

| Decision | Effect |
|---|---|
| `users`, `farms`, `fields` only | `docs/data-model/` does not exist; the derived entities have columns specified as discriminated unions and creating them would invent the schema |
| `user_id` denormalised onto `fields` | the policy compares the row's own column instead of joining through `farms` |
| `ENABLE` + `FORCE ROW LEVEL SECURITY` | without `FORCE` the owner — `migration_owner`, i.e. the fixture and migration connection — reads every tenant's rows, and no test running as `app_api` would notice |
| explicit `*_owner_full_access` policy per table | `FORCE` otherwise locks the owner out of its own table, which reads as a mysterious "new row violates row-level security policy" during a data migration |
| policy `USING` **and** `WITH CHECK` | `USING` alone lets a tenant `UPDATE` a row into another tenant's ownership |
| `NULLIF(current_setting('app.user_id', true), '')::uuid` | unset and empty both yield `NULL` and match nothing: fail-closed, not a cast error and not all rows |
| `(farm_id, user_id) → farms (id, user_id)` | ownership travels with the reference; a mismatched pair is a `23503`, not a cross-tenant row |
| `app_system` granted nothing | `BYPASSRLS` confers no SQL privilege, and background-processing §10 says a new tenant-owned table ships without a grant |
| `app_api` granted nothing on `users` | email lookup is the authentication path, which runs before a tenant context exists; deferred rather than half-built |
| `schemas = ["app"]` + `@@schema("app")` in `schema.prisma` | without it the adapter emits `public.farms` and reports a missing table |
| `geom` and `area_ha` as `Unsupported` | both are unreadable or unwritable through the client; the alternatives are a schema file that lies or a client that writes values PostgreSQL rejects |

`createTenantScope(prisma).withTenant(userId, fn)` is the only tenant entry point: `set_config(…, true)` inside a Prisma interactive transaction, through the row-returning raw API (`set_config` returns a row, and a write-path call would discard a silent failure), with the callback receiving the transaction client. Nested scopes throw — an inner scope would open an independent transaction with a different tenant, and on a single-connection pool it would deadlock behind its caller.

Verified by running, not by reading:

- `test:rls` — 10 tests as `app_api`/`app_system` over TCP. Fixtures from `migration_owner`; every negative assertion pinned to a SQLSTATE, so `23503` (cross-tenant FK) and `42501` (RLS/grant) are never conflated.
- Pool reuse is forced with `poolMax: 1`: context must be gone after commit and after rollback, on the same physical connection.
- `db:verify` — 118 assertions, including `relrowsecurity`, `relforcerowsecurity`, owner, policy `cmd`/`roles`/`qual`/`with_check`, no `PUBLIC` policy, the effective privilege matrix per table, `has_column_privilege` for `app_system` on `fields.geom`/`fields.soil_ph`, and the composite FK definition.
- `test` — 9 unit tests, no database: UUID validation before the transaction opens, `set_config(..., true)` shape, nesting rejection, error propagation, concurrent scopes not treated as nesting.

Two defects were found by running it, both in the setup rather than the design: the migration first failed with `type "geometry" does not exist` because the migration connection's `search_path` is `app`, not `public` — every PostGIS type and function in the migration is now schema-qualified; and Prisma asked for `public.farms` until the schema file declared `schemas = ["app"]`.

Not verified: `app_system` reading `planting_windows`/`suitability_runs`/`ai_briefings` columns, because those tables do not exist. Not implemented: authentication lookup for `app.users`, and any `app_system` grant.

### Phase 2.3 outcome — physical data model specified, not implemented

Documentation only. No migration, no Prisma model, no policy, no grant, no runtime change, and no destructive operation on the database.

| Deliverable | Content |
|---|---|
| `docs/data-model/README.md` | document order, precedence rules, and the non-negotiables inherited from earlier phases |
| `entity-catalog.md` | 22 tables — 3 implemented, 19 specified — with ownership class and state; 9 entities deliberately not specified, with the reason |
| `physical-model.md` | the grammar every table is written in: naming, `uuidv7()` ids, time types, numeric precision (no storage-layer rounding), enums as `text` + `CHECK`, hash columns, the JSONB test, standard columns |
| `tables-identity.md` | `users`, `farms`, `fields`, `field_outlook_cells`, `field_observations`, `plantings`, `harvests` |
| `tables-catalog.md` | `crops`, `cultivars`, `crop_profile_versions`, `growth_stages`, `constraints`, `source_refs` |
| `tables-climate.md` | `outlook_cells`, `forecast_runs`, `ingestion_runs`, `weather_records`, `monthly_outlooks`, `climatology_normals` |
| `tables-derived.md` | `suitability_runs`, `planting_windows`, `ai_briefings` |
| `relationships.md` | every FK, the composite ownership keys, the self-referencing supersession chains, and the relationships that are deliberately refused |
| `ownership-and-rls.md` | the 22-table privilege matrix, the policy text, the login-lookup problem with three options and no decision |
| `spatial-model.md` | the single geometry column, `area_ha`, the GiST index, coordinates that are not geometry, and `geometryHash` |
| `provenance-storage.md` | how each contract type is stored, and the three places the answer is "not as a column" |
| `temporal-and-weather-semantics.md` | every date/timestamp meaning, the horizon map, freshness thresholds, and five distinct missing-data representations |
| `indexes-and-query-patterns.md` | 25 named queries and every index justified by one |
| `lifecycle-and-retention.md` | three removal mechanisms and no others; append-and-supersede in full |
| `open-decisions.md` | 26 `D-nn` decisions taken, 29 `OPEN-nn` questions left open with severity, scope, disposition, and what would settle each; one authoritative blocker matrix (none P0) |
| `consistency-checklist.md` | 50+ cross-document checks, three defects found in other documents, and the withheld approval |
| `docs/adr/ADR-003-trusted-tenant-context.md` | what `app.user_id` actually guarantees, measured |

The measurement that changed a claim into a fact: `app_api` can set `app.user_id` to any tenant. Transaction-scoped `set_config(..., true)` dies with the transaction (autocommit: the next statement sees nothing); a session-scoped `SET` survives it and would hand one request's tenant to the next request on a pooled connection. A `SECURITY DEFINER` helper reads the caller's setting, so it cannot validate it. No privilege mechanism exists to restrict a custom GUC — the parameter is created by whichever role first sets it and does not even appear in `pg_settings` while unset. RLS is therefore documented as containment of forgotten filters, not as protection against a holder of `app_api` credentials, and the current `withTenant` is confirmed to be on the safe side of both hazards.

**Approval withheld.** The register is 14 P1 + 15 P2, no P0. Four P1 items block the first slice that consumes a Phase 3 table: `OPEN-01` (the authentication lookup cannot be built against this schema), `OPEN-17` (a `POINT` field has `area_ha = 0` and cannot satisfy `FieldSnapshotPayload.areaHa: positive()`; `POLYGON` fields unaffected), `OPEN-26` (no `EvidenceSegment` partition validator, so a broken window is storable once the write path exists), and `OPEN-27` (the recompute fan-out reads a tenant-owned table with a credential that has no grant on it). Ten further P1 items complete the register — `OPEN-09`, `-11`, `-13`, `-18`, `-21`, `-02`, `-03`, `-04`, `-05`, `-28` — of which `OPEN-09` is the only one that changes a Phase 3 migration (`plantings.status DEFAULT 'active'` and `plantings_active_idx` would encode an undecided vocabulary) and `OPEN-02` blocks nothing at all (BMKG falls back to labelled Open-Meteo). No answer was invented for any of them. The classification, with what continues independently, is `docs/data-model/open-decisions.md` §1.1.

Next: decide `OPEN-09` (or ship `plantings` without the default and the index), then Phase 3 creates the 19 specified tables as hand-written SQL applied with `prisma migrate deploy`. The other 13 P1 items do not gate the DDL: twelve block a slice that lands after it, and `OPEN-02` blocks nothing because the labelled fallback ships.

### Phase 2.3.x outcome — documentation corrections

Correction pass over Phase 2.3, driven by the independent architecture review. Documentation only: no migration, no Prisma model, no policy, no grant, no role, no runtime change, and no database mutation.

| Correction | Before | After |
|---|---|---|
| open-decision count | "25 questions left open" in two places (a real 25 that matched the `D-nn` count, not the `OPEN-nn` count) | **29 defined, 29 referenced, 0 dangling**; 25 of them cited outside `open-decisions.md`, and the document now says so instead of implying all are cross-referenced |
| decision count | 25 `D-nn` | 25 `D-nn`, 12 cited outside the decision table, 0 dangling (`D26` added in 2.4) |
| severity scheme | P0 = "blocks Phase 3 start", which was false for every item that carried it | severity is **scope**: P0 = blocks the whole phase, P1 = blocks one named subsystem, P2 = settle during implementation. **Nothing is P0**, because every table, constraint, index, policy, and grant can be created today |
| `OPEN-17` severity | P0 in `open-decisions.md`, P1 in `spatial-model.md` | **P1 in both**, with the scope stated: only point-shaped fields are blocked; escalates to P0 if point fields become a v1 requirement |
| `OPEN-26` visibility | P1 in the detail list, absent from the blocker summary | in the authoritative matrix as a `planting_windows` **write-path** blocker; `tables-derived.md` now states that no invalid partition may be persisted as a valid window once the writer exists |
| geometry hash terminology | "canonical EWKB", which reads as *normalized* | "SHA-256 of the stored EWKB representation, without geometry normalization", with an explicit table of what is and is not equal. `provenance-contract.md`'s wording is left alone (out of scope) and recorded as a discrepancy |
| `area_ha` nullability | "it is not nullable in the DDL" | measured: `is_nullable = YES`, `attnotnull = false`. Three claims separated — declared, always present, always meaningful — and the third is false for a point |
| dangling reference | `open-decisions.md` pointed at `ADR-004`, which does not exist | says so explicitly; no ADR invented |

The blocker matrix in `open-decisions.md` §1.1 is the single authoritative statement of what each blocker stops and what continues independently. `consistency-checklist.md` §8 then reproduced it as scope only and pointed back, so the two could not drift into two different stories. *(Amended in 2.3.x.1: §8 now summarises the same matrix by category — one `Phase 3 DDL`, twelve `after Phase 3`, one `not blocking` — because reproducing four of fourteen rows was itself the drift.)*

Two things the review asked for that this phase deliberately did **not** do: resolve any of the four blockers it had named, and restate the `CREATE INDEX CONCURRENTLY` constraint as a new migration mechanism. The operational note now says a future large-table concurrent index needs a separately planned procedure; nothing about how migrations run was changed.

Verification was documentation-only: identifier and severity scans over 18 files, terminology scans including multi-line phrase joins, `git diff --check`, `pnpm format:check`, `git status --short`. `docs/` is in `.prettierignore`, so Prettier passing says nothing about these files — stated in the report rather than claimed as validation.

### Phase 2.3.x.1 outcome — blocker classification

Second documentation-only correction pass, driven by a review of the §1.1 matrix. No migration, Prisma model, role, grant, policy, or runtime change; no database mutation.

The defect: `open-decisions.md` §1.1 presented four P1 items as *the* blocker matrix, the register actually held fourteen, and nothing said what the other ten stopped. A reader could not tell whether the matrix was a selection or the whole set — which is the one thing a blocker summary must never leave ambiguous.

| Correction | Before | After |
|---|---|---|
| matrix scope | four rows, no statement of what was excluded | **one matrix, all 14 P1 items**, with an `Applies` column that separates "changes the Phase 3 DDL" from "blocks a later slice" from "blocks nothing" |
| classification of the other ten P1 | each had a `Blocks:` line, none said *when* | every one is a matrix row: `OPEN-09` and `OPEN-21` (catalog/vocabulary), `OPEN-11` (AI), `OPEN-13` (auth with `OPEN-01`), `OPEN-18` (cell resolution and ingest), `OPEN-02`/`-03`/`-05` (provider, deployment, retention), `OPEN-04` (lifecycle), `OPEN-28` (hardening) |
| **`OPEN-09`** | P1, described as blocking "the partial index" | the **only Phase 3 DDL blocker** — `plantings.status DEFAULT 'active'` and `plantings_active_idx WHERE status = 'active'` both spell a value whose vocabulary is undecided. Creating either would implement `OPEN-09` by guessing |
| **`OPEN-18`** | "Phase 3's write path needs it" | Phase 3 is DDL only, so it does not. It blocks the first **ingest**, because a cell identity needs a key — which also means the earlier claim that "ingestion and aggregation can proceed" was wrong, and is corrected |
| `OPEN-11` | "the table can be created; the row cannot be validated" | the three states named separately: table createable, row unvalidatable, subsystem unimplementable |
| `OPEN-04` | "blocks the `users` unique index design" | also states that `users` is already implemented, so any option amends an applied table through a later migration rather than changing Phase 3 |
| `OPEN-02` | P1 alongside blockers | P1 by severity, **blocking by nothing** — the labelled fallback ships. Kept in the register rather than dropped |
| counts | 14 P1 stated nowhere | **29 = 14 P1 + 15 P2**, published in `README.md`, the register, the checklist and here |

Four things this phase deliberately did **not** do: resolve any `OPEN-nn`, invent a classification where the documents did not support one, renumber an id, or soften `OPEN-17`'s escalation clause. `OPEN-09` appears in the matrix as a finding, not as a decision — `plantings.status` has no vocabulary today and this phase did not choose one.

Verification was documentation-only: one script over 18 files checking definition uniqueness, matrix coverage in both directions, severity agreement, reference integrity and exhaustive-sounding phrasing, plus `git diff --check` and `git status --short`. `docs/` is in `.prettierignore`, so `pnpm format:check` says nothing about these files.

### Phase 2.4 outcome — decision closure, one DDL blocker removed by omission

The phase asked one question: does anything unresolved make a Phase 3 table or
security boundary unsafe to implement? After auditing all 29 `OPEN-nn` and all 26
`D-nn` decisions, the answer is **no** — and it is an answer about the *DDL*, not
about the subsystems those items block.

| Decision | Content |
|---|---|
| `D26` | `plantings.status` ships with no `DEFAULT` and `plantings_active_idx` is **not created**. Both would spell a value `OPEN-09` has not chosen. They arrive together, in one additive migration with no data rewrite, once the vocabulary is settled — and no row can exist before then |
| disposition vocabulary | `RESOLVED` / `DEFERRED` / `BLOCKED_EXTERNAL_INPUT` / `NOT_APPLICABLE`, applied to every id in `open-decisions.md` §5. **0 resolved, 20 deferred, 9 blocked on external input, 0 not-applicable** |
| blocking vs severity | two independent axes, because "not P0" and "not blocking" were being used as the same claim. `Blocking` now reads `hard` / `conditional` / `mitigated` / `none`; `OPEN-02` is P1 and `mitigated`, `OPEN-28` is P1 and `conditional` |

**Zero `RESOLVED` is the honest result.** Every remaining `OPEN` is a question whose
answer has an owner outside this task: a product decision (`OPEN-17`, `OPEN-04`), a
licence (`OPEN-02`, `OPEN-03`, `OPEN-05`), an agronomic vocabulary (`OPEN-09`,
`OPEN-21`, `OPEN-06`), or a security review (`OPEN-01`, `OPEN-27`, `OPEN-28`).
Resolving `OPEN-17` by assuming a 500 m radius "for now" would have made the
database lie about a plot's area, and that lie would be inside a hash.

`OPEN-09` is therefore **deferred, not closed**: the DDL half is settled by
omission, the vocabulary is still open, and the first writer is still blocked.

Two normative documents were corrected against the per-table specifications while
auditing the `D-nn` set, both recorded in `consistency-checklist.md` §10 because a
silent edit to a normative document is worse than a recorded one:
`physical-model.md` §4 named `constraints.value_min` (a column `D6` replaced with
`threshold_lower`/`threshold_upper`) and gave it `numeric(6,2)` where
`tables-catalog.md` §5 gives `numeric(10,2)`.

### Phase 3 outcome — the nineteen tables exist

One migration, hand-written SQL, applied with `prisma migrate deploy`:
`packages/database/prisma/migrations/20261118030000_domain_tables/migration.sql`.

| Group | Tables |
|---|---|
| field operations (tenant, RLS forced) | `field_outlook_cells`, `field_observations`, `plantings`, `harvests` |
| catalog (reference, no RLS) | `crops`, `cultivars`, `crop_profile_versions`, `growth_stages`, `constraints`, `source_refs` |
| weather plane (global, no RLS) | `outlook_cells`, `forecast_runs`, `ingestion_runs`, `weather_records`, `monthly_outlooks`, `climatology_normals` |
| derived artifacts (tenant, RLS forced) | `suitability_runs`, `planting_windows`, `ai_briefings` |

`app.users`, `app.farms` and `app.fields` are untouched. The database now holds 22
domain tables, 20 policies (10 tenant tables × tenant isolation + owner access), and
36 new indexes. `app_system` received **nothing** on any tenant-owned table and
`RW` on the twelve global ones; `app_api` received `R` on the catalog and the
weather plane, `R` plus one column-level `INSERT (provider, model, cell_key)` on
`outlook_cells`, and `RW` on the tenant tables it owns.

Three things the migration deliberately does not do: no `DEFAULT` on
`plantings.status`, no `plantings_active_idx` (`D26`), and no
`crop_profile_versions_immutable` trigger (`tables-catalog.md` §3 specifies it and
defers it). Nothing is `CONCURRENTLY`: the tables are empty, and `migrate deploy`
wraps each migration in one transaction anyway.

Verified by running, not by reading:

| Check | Command | Result |
|---|---|---|
| applies to the development database | `pnpm db:migrate` | 3 migrations, "All migrations have been successfully applied", exit 0 |
| `app` schema shape | `pg_class` / `pg_constraint` / `pg_indexes` | 22 domain tables (+ `_prisma_migrations`), 36 FK, 116 `CHECK`, 13 `UNIQUE`, 75 indexes, 20 policies |
| blocking invariants | `pg_attribute` / `pg_index` | `plantings.status` `column_default` NULL; `plantings_active_idx` absent; `weather_records_live_key.indnullsnotdistinct = true`; `app_api` holds `INSERT` on exactly `outlook_cells.provider/model/cell_key`; no `app_api` privilege on `users` |
| installs from empty | isolated compose project `agroclimate-cleanverify`, port 5499, own volume | bootstrap + `db:migrate` exit 0; all 23 relations, 7 forced-RLS tables, 20 policies, and the `app_system`/`app_api` matrices as above; re-run reports "No pending migrations to apply"; project and volume removed, development container untouched |
| constraint behaviour | savepoint-isolated inserts as `migration_owner` on the development database, rolled back | `plantings` without `status` → `23502`; `pending` with a value → `23514` on `value_state`; `beyond_horizon` on a non-climatology class → `23514` on `beyond_horizon_check`; a climatology `beyond_horizon` month → accepted; cross-tenant field on `plantings` → `23503` on `plantings_field_owner_fkey`; duplicate live `weather_records` row with `ensemble_member` NULL → `23505` on `weather_records_live_key` |
| point geometry | `ST_Area(POINT(…))` | **0**, which is the measured basis of `OPEN-17`: a point-shaped field has `area_ha = 0` and cannot satisfy a positive-area snapshot |

Four implementation deviations are recorded in `consistency-checklist.md` §11 rather
than left for a reader to find: `monthly_outlooks_value_state_check` written as an
implication (the specification's prose states the rule, its literal constraint does
not enforce half of it), a nine-value `data_class` `CHECK` on `monthly_outlooks`
mirroring the contract enum, a `beyond_horizon` ⇒ value-present check, and
`field_outlook_cells` carrying `resolved_at` instead of `created_at`.

| RLS isolation, seven new tenant tables | `pnpm test:rls`, as `app_api` through `withTenant` | 39 tests / 39 pass. Tenant A sees zero rows of tenant B for SELECT, UPDATE and DELETE on all seven; an INSERT naming tenant B's parent fails `23503` on all seven; no tenant context returns zero rows. UPDATE/DELETE report **zero rows affected, no error** — the `USING` clause filters the row before `WITH CHECK` is reached, and the suite asserts the row count rather than inventing a `42501` |
| schema conformance | `pnpm --filter @agroclimate/database test:schema` | 12 tests / 12 pass: 22-table inventory with no extras, PK on all 22, RLS forced on 10 and off on 12, `plantings.status` default NULL, no `plantings_active_idx`, `weather_records_live_key` unique + NULLS NOT DISTINCT, all nine composite ownership edges present with `conkey` length 2 and their `(id, user_id)` targets existing, `fields.geom` `geometry(Geometry,4326)`, `fields.area_ha` `attgenerated = 's'`, zero unconstrained `geometry` columns |
| privilege matrix, all 22 tables | `pnpm db:verify` | 355 assertions / 0 fail (was 118 covering three tables); `db:verify:probes` 12 / 0 |
| tenant boundary, actual roles | direct `pg` connections as `app_api` and `app_system` | `app_system`: `SELECT app.fields`, `INSERT app.fields`, `UPDATE app.planting_windows`, `DELETE app.harvests`, `CREATE TABLE app.evil`, `SET ROLE app_api`, `SET ROLE migration_owner` → all `42501`; `SELECT app.weather_records` allowed. `app_api`: the three-column `INSERT` on `outlook_cells` succeeds with `served_lat` NULL, naming `served_lat` → `42501`, `INSERT app.crops` → `42501`, `CREATE TABLE` → `42501` |

**Still not done, and not claimed:** `OPEN-27` is unimplemented — `app_system`
cannot answer "which fields does this cell serve", because granting that read is the
decision it is waiting on. `OPEN-01` is unimplemented — `app_api` holds no
privilege on `app.users`. `OPEN-26`'s six-check partition validator does not exist,
so a malformed `planting_windows` partition is storable by any path that can write
the table, and the `jsonb_typeof = 'array'` check is not that validator. The
`crop_profile_versions_immutable` trigger is not created.

Prisma was synchronized by hand, because `migrate dev` cannot diff a schema that
contains PostGIS's own objects: `schema.prisma` now carries 22 models, and
`prisma validate` and `prisma generate` both pass. The file is a *representation*,
not the source of truth, and it says so in its header. Three things it cannot
express, each named in the model it belongs to rather than dropped silently:

| Not representable | Where it lives |
|---|---|
| every `CHECK` constraint (116 of them) | SQL only. A Prisma `enum` was deliberately **not** introduced for any text-plus-`CHECK` column: it would claim a vocabulary the database enforces and Prisma does not |
| partial and `NULLS NOT DISTINCT` indexes (12: `weather_records_live_key`, the live/superseded keys on the derived tables, `plantings`-adjacent partials, `ingestion_runs_running_idx`) | SQL only |
| RLS, policies, grants, the composite-FK *targets* on `farms`/`fields`, and the deferred trigger | SQL only |

One deliberate omission in the other direction: no new model carries `@updatedAt`.
`updated_at` is a plain column with a `now()` default and no trigger maintains it
(`OPEN-19`), so marking it `@updatedAt` would have Prisma write a value the
database never enforces and a migration never creates.

## Phase 3.2 — Authentication & tenant identity

Design and decision inputs: `docs/review/phase-3.2-design-review.md` (verdict
`READY FOR OWNER DECISIONS`) and `docs/review/phase-3.2-owner-decisions.md` (four
approvals, one amendment `IG-5-A1`, one later gate `IG-12`).

| Step | Status | Commit | What exists |
|---|---|---|---|
| S1 — contracts | **implemented** | `c44cf5b`, `0bb9792`, `c762171`, `38486fd`, `75607d8` | response and error envelopes, `errorCodeSchema` with the branded `NotFoundErrorCode`, `requestIdSchema`, and `validationDetailsSchema` — bounded details at `c762171`, the encoded path grammar enforced in the contract at `38486fd`, canonical numeric segments at `75607d8` |
| S2 — API plumbing | **implemented and remediated** | `ad6235b`, `6d36741`, `c762171`, `38486fd`, `75607d8` | `/v1` prefix, request-id middleware, exception filter, `ZodValidationPipe` bound per parameter, `cookie-parser`, helmet, explicit CORS allowlist, explicit trust proxy, database client + lifecycle, `/health` and `/health/ready` |
| S3 — `app_auth` bootstrap | **implemented** | `70a614f`, `d9d774e`, `f5e4d1c`, `a4f1fa0` | fourth role with zero memberships and no `BYPASSRLS`; `APP_AUTH_DATABASE_URL` parsed and role-validated at boot (dev default, production must state it); non-global `AuthDatabaseModule` + `AuthDatabaseLifecycle`, proven by module-assembly tests, not yet imported by `AppModule`; `db:verify` 387 assertions |
| S4 — `auth_boundary` migration | **committed and pushed** | `b9a27c6`, `cf0d1c2` | `20261118040000_auth_boundary`: two column grants and two policies on `app.users`; `db:verify` 419 assertions, 0 FAIL, 0 SKIP after the corrective pass |
| S5 — `sessions` migration | **implemented, committed, pushed, and applied to the canonical development database** | `8fb2270` | `20261118050000_sessions`: eight columns, three CHECKs (`D-1`, `D-2`, expiry order), unique `token_hash`, the two `D-3` indexes, `ENABLE`+`FORCE` RLS, two policies, three column grants to `app_auth`, `purge_expired_sessions()` (`SECURITY DEFINER`, pinned `search_path`, `EXECUTE` to `app_system` only); Prisma `Session` model + `User.sessions`. Canonical `127.0.0.1:5442` is at 5/5 (`db:bootstrap` first, then `db:migrate` applying `auth_boundary` + `sessions`); canonical evidence: `db:verify` 493 PASS / 0 FAIL / 0 SKIP, `db:verify:probes` 12/12, `test:schema` 13/13, `test:rls` 39/39, `pnpm test` 87 API + 34 database. Isolated project `agroclimate-db-s5-check` (5545) reproduced the same numbers. Pre-deployment backup: `/tmp/opencode/agroclimate-canonical-pre-s4-s5.dump` |
| S6 — privilege verification | **implemented and verified on canonical, uncommitted** | — | `db:verify` 493 → **499** PASS / 0 FAIL / 0 SKIP (four `23514` deadline probes, clamped-extension equality, PUBLIC has no privilege on `app.sessions`); new `test/rls/auth-boundary.test.mjs` — **49 cases**, real roles, denials exact at `42501`, `23514`/`23503` separately, 21 non-authentication tables enumerated from `pg_tables` (count asserted); `test:schema` 13 → **22**; `test:rls` **88** (39 unchanged isolation + 49 boundary); all three suites green on canonical and on a fresh isolated project (`agroclimate-s6-fresh`, port 5546, own volume, removed afterwards). `OPEN-13` resolved on that evidence. |
| S7 — register + login | blocked | — | needs `IG-1`–`IG-4`, `IG-6`, `IG-7`, `IG-10` |
| S8 — session guard, `/me`, logout | blocked | — | needs `IG-8`, `IG-9` |
| S9 — docs reconciliation | not started | — | `ADR-004` and `ADR-005` are accepted; the reconciliation changes are pending |

Gates this phase answered: `AG-1`, `AG-2`, `IG-5`, `IG-11`, plus `IG-5-A1` and
`IG-12`. Gates it did not answer: `IG-1`–`IG-4`, `IG-6`–`IG-10`.

What S2 deliberately does not contain: an auth endpoint, session issuance, an
`app_auth` role, a grant, a policy, or a migration. `OPEN-01` and `OPEN-13` remain
unresolved — an acceptance and an implementation are not a migration applied to the
canonical database; `ADR-005` is accepted (2026-11-20), and that applies nothing.

Verification history, by commit, because the four commits fixed different things:

| Commit | Scope |
|---|---|
| `6d36741` | Initial S2 remediation — credential boundary, log sanitisation, 405/406/415 documentation, `statement_timeout` readiness, `IG-5-A1`, `IG-12` |
| `c762171` | Error-details trust boundary, validation-path sanitisation in the pipe, log category, readiness budget |
| `38486fd` | Shared contract path grammar, producer reuse of the identifier rule, segment-boundary truncation |
| `75607d8` | Explicit path-parser state machine, canonical numeric-segment guard, producer/contract round-trip proof |

The results below are the ones reported for the committed implementation at
`75607d8`. They are recorded here, not re-executed by this documentation change:

| Check | Result |
|---|---|
| API tests | **76 passed**, 0 failing |
| Contracts tests | **187 passed**, 0 failing |
| Database tests | **9 passed**, 0 failing |
| Workspace build | exit 0 |
| Workspace typecheck | exit 0 |
| Workspace test | exit 0 — API 76, database 9, contracts 187 |
| Workspace lint | exit 0 |
| Prettier (`pnpm exec prettier --check .`) | exit 0 |
| `git diff --check` | exit 0 |

Two limitations stated rather than implied: the readiness budget bounds the HTTP
response and lets PostgreSQL cancel its own statement, but a pending pool connect
attempt is not aborted; and no endpoint takes input yet, so `ZodValidationPipe` is
exercised by unit, contract-boundary, and filter-level tests rather than by a live
route. **No Prisma-adapter integration test was run** — the credential lives in
`.env`, which this work does not read — and **no live HTTP route test exists**,
because no route takes input yet.

### Phase 3.2.3 — S3 and S4 outcome

**S3** added the fourth role and the second credential; **S4** gave it the only table
it may reach. Both are `app.users`-shaped work: no session, no endpoint, no guard.

| Item | State |
|---|---|
| `bootstrap/roles.sql` | `app_auth` in the role array: `LOGIN`, `NOINHERIT`, `NOBYPASSRLS`, zero memberships, `USAGE` on `app`, no `CREATE` |
| `apps/api/src/config/runtime-config.ts` | `authDatabaseUrl` derived in development (`APP_AUTH_PASSWORD ?? "app_auth_dev"`), required verbatim in production; parsed as a URL; `assertAuthRole` refuses the other three roles |
| `apps/api/src/database/auth-database.module.ts` | non-global module + lifecycle; no pool opened at boot; **not imported by `AppModule`** until S7 |
| `20261118040000_auth_boundary` | `GRANT SELECT (id, email, password_hash, role, locale, timezone)`, `GRANT INSERT (email, password_hash)`, `users_auth_lookup FOR SELECT USING (true)`, `users_auth_register FOR INSERT WITH CHECK (true)` — nothing else |

Verification, executed in an isolated Compose project
(`agroclimate-s4-check`, container `agroclimate-db-s4-check`, port **5543**, own
volume), from zero: `db:up` → `db:bootstrap` → `db:migrate` (four migrations in
order) → `db:verify`.

| Check | Result |
|---|---|
| `db:verify` | **417 PASS, 0 FAIL, 0 SKIP**, exit 0 |
| API tests | **87 passed**, 0 failing |
| Database tests | **21 passed**, 0 failing (7 new, driving `checkAuthUserColumnGrants`) |
| Workspace build / typecheck / lint | exit 0 |
| Workspace test | exit 0 — API 87, database 21, contracts 6 files |
| Prettier (`pnpm exec prettier --check .`) | exit 0 |
| `git diff --check` | exit 0 |

Behavioural evidence from `db:verify`, as the real `app_auth` credential with **no
`app.user_id` set**: an `INSERT (email, password_hash) RETURNING id` succeeds and the
row comes back with `role = 'owner'`, `locale = 'id'`, `timezone = 'Asia/Jakarta'`
from column defaults; the six granted columns are readable; `created_at`,
`updated_at`, `SELECT *`, six unapproved `INSERT` columns, `UPDATE`, and `DELETE` all
fail with **`42501`** and nothing else. `app_api` and `app_system` hold no privilege
on `app.users`, asserted with both `has_table_privilege` and `has_column_privilege`.

### S4 corrective pass — exact policy contract (2026-11-18)

Two review findings, both about truthfulness rather than capability: the verifier
asserted the four policies by name and substring, and the documents still described
S4 as uncommitted after it had been pushed.

Source control: `b9a27c6` (migration, verifier, unit tests) and `cf0d1c2` (status
reconciliation) are on `master`, followed by `03afdc8` (policy-contract assertion, 13
new unit tests) and `af7c01e` (status reconciliation) — `af7c01e` is HEAD as of this
note. Isolated verification: the corrective run used its
own project, `agroclimate-s4-corrective-check` / `agroclimate-db-s4-corrective-check`
on port **5544**, fresh volume, all four migrations applied in order. Canonical
database application: **pending owner action**. `OPEN-01`: **unresolved**.

`checkUsersPolicyInventory` now compares the whole inventory against four records —
command, `permissive`, role set, `USING`, `WITH CHECK` — and fails on a missing
policy, an extra one, or any of those fields changing. The tenant predicate is
compared against the catalogue's normalised form:

`(id = (NULLIF(current_setting('app.user_id'::text, true), ''::text))::uuid)`

which is why `users_self_only` can no longer be widened to `USING (true)` without a
red run. `roles` is selected as `text[]` and parsed, so `{app_auth,public}` is caught
where `roles === "{public}"` would not be.

| Check | Result |
|---|---|
| `db:verify` (5544) | **419 PASS, 0 FAIL, 0 SKIP**, exit 0 (417 before the pass) |
| Negative probe | `CREATE POLICY users_auth_everyone … TO PUBLIC` on the isolated table → `db:verify` **exit 1**, 3 FAIL (`exactly four`, `names PUBLIC`, and the existing cross-table PUBLIC check); policy dropped, green restored, `db:status` up to date |
| Database unit tests | **25 passed** (13 new policy-contract cases) |
| API tests | 87 passed |
| Workspace test | exit 0 — API 87, database 34, contracts 6 files |
| Workspace build / typecheck / lint | exit 0 |
| Prettier / `git diff --check` | exit 0 |

The negative probe is the part worth keeping: an assertion that only ever ran green
is a claim, not evidence.

What this does **not** mean:

- **No authentication workflow exists.** No register, login, logout, `/me`, guard,
  hashing, policy, rate limit, cookie, or CSRF.
- **`OPEN-01` is not closed.** The capability is committed and proven in an isolated
  project; the register entry still waits for the canonical database application and
  S6's suite. ADR-004's definition of done is not shorter than that.
- **Enumeration is an accepted limitation, not a bug to fix later.** `USING (true)`
  filters nothing; the column grant is the boundary. `db:verify` asserts
  `select count(*)` succeeds so the exposure cannot be rediscovered as a surprise.
- **`prisma.user.create()` / `update()` remain unusable** under this grant, by
  design: their client-side defaults name `locale`/`timezone`/`role` and `@updatedAt`
  names `updated_at`. Registration is the raw `INSERT … RETURNING id` above.
- **S4 is committed and pushed** (`b9a27c6`, `cf0d1c2`). What remains outside this
  repository is the owner's canonical database application, not the code.
