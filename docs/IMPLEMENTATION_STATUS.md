# Implementation Status

Last updated: 2026-11-21.

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
| S6 — privilege verification | **implemented, committed, pushed, and verified on canonical** | `e9d1621` | `db:verify` 493 → **499** PASS / 0 FAIL / 0 SKIP (four `23514` deadline probes, clamped-extension equality, PUBLIC has no privilege on `app.sessions`); new `test/rls/auth-boundary.test.mjs` — **49 cases**, real roles, denials exact at `42501`, `23514`/`23503` separately, 21 non-authentication tables enumerated from `pg_tables` (count asserted); `test:schema` 13 → **22**; `test:rls` **88** (39 unchanged isolation + 49 boundary); all three suites green on canonical and on a fresh isolated project (`agroclimate-s6-fresh`, port 5546, own volume, removed afterwards). `OPEN-13` resolved on that evidence. |
| S7 — registration and credential verification | **implemented, verified, committed, pushed** | `7eef8ce` | `POST /v1/auth/register` exists and creates a user; credential verification with a dummy hash is **not yet implemented** (it lands with S8's login). Decisions: `IG-1`/`IG-2`/`IG-3`/`IG-7`/`IG-10` approved, `IG-4` approved with its revised rule, `IG-6` **conditional** — `docs/review/phase-3.2-s7-owner-decisions.md` *Amendment 1*. Delivered: `registerRequestSchema` + `normalizeEmail` + code-point/byte password rule in `packages/contracts`; Argon2id via `@node-rs/argon2@2.2.2` with configuration-driven cost (`ARGON2_MEMORY_KIB`/`ARGON2_TIME_COST`/`ARGON2_PARALLELISM`, defaults `19456`/`2`/`1`); in-process fixed-window limiter, 30 req/min/IP, before hashing and lookup; `insertRegisteredUser` in `packages/database` writing through `app_auth` and returning five safe columns; unique violations mapped to `409 CONFLICT` without a prior existence check; explicit 16 KiB body limit. Tests: contracts 208, api 118, database unit 34, `test:schema` 22, `test:rls` 88, `test:integration` 6 (real `app_auth`, including concurrent duplicate and 42501 denials for `app_api`). Benchmark: local latency-only run 2026-11-21 (`m=19456,t=2,p=1`, concurrency 1, no memory limit) — hash p95 16.2 ms, verify p95 16.0 ms, peak RSS 76.1 MiB; it does **not** satisfy `IG-6`. No session, cookie, token, or CSRF exists |

@106@
| S8 — login, session flow, guard, `/me`, logout, CSRF token | **complete: implemented and verified, CSRF synchronizer token included; migration applied to the canonical development database; the CSRF work is uncommitted** | `7c7b61a`, `913b041` + CSRF and lock-wait work in the working tree | `POST /v1/auth/login`, `GET /v1/auth/me`, `POST /v1/auth/logout`, `AuthGuard`, the `__Host-` session cookie, and login-side rate limiting are implemented and tested against a real database. Credential lookup reads `password_hash` through `app_auth` with no `withTenant` and no `app.user_id`, which is what `OPEN-01` required. `ADR-006` §D2.2 (`Origin` validation) and §D2.1 (the session-bound synchronizer token) are both implemented. The token is a plaintext, nullable `app.sessions.csrf_token`, minted lazily on first retrieval at `GET /v1/auth/csrf`, never rotated, and required on authenticated `POST`/`PUT`/`PATCH`/`DELETE` with `403 FORBIDDEN` on failure. `register`, `login`, and `logout` stay exempt because they are not behind `AuthGuard`; `Origin` validation still covers them. The decisions are *Amendment 4* of `docs/review/phase-3.2-owner-decisions.md`; the implementation record is `docs/review/s8-csrf-token-design-proposal.md`. `S8` is therefore **complete** — but the CSRF work is uncommitted, so the deployed state is `913b041` plus this working tree. |
| S9 — docs reconciliation | partially done | — | `ADR-004`/`ADR-005` accepted, `ADR-006` accepted 2026-11-21 (`IG-8`/`IG-9`, *Amendment 3*); `entity-catalog` now carries `sessions` (23 tables) and `IMPLEMENTATION_STATUS` records S3–S6 — done in `e9d1621`. `api-conventions` now documents registration and the S7/S8 split (§8.1), and §8 carries the approved cookie and CSRF wording. Still absent: the `auth-deferred.md` pointer (`consistency-checklist.md` §6.1) |

Gates this phase answered: `AG-1`, `AG-2`, `IG-5`, `IG-11`, plus `IG-5-A1` and
`IG-12`. Gates it did not answer: `IG-1`–`IG-4`, `IG-6`–`IG-10` — none of which changed
this phase's DDL. All seven are recorded on 2026-11-20 in
`docs/review/phase-3.2-s7-owner-decisions.md`.

**Update, 2026-11-21.** `IG-8` (session cookie) and `IG-9` (CSRF) are no longer
unanswered: the owner approved both on 2026-11-21, recorded in *Amendment 3* of
`docs/review/phase-3.2-owner-decisions.md` and formalised in
`docs/adr/ADR-006-session-transport-and-csrf.md`. Approval is not implementation — no
cookie, token, or `Origin` check exists.

**Update, 2026-11-21 (S7).** The S7 policy round is also closed: `IG-1`, `IG-2`, `IG-3`,
`IG-7`, `IG-10` are **approved**, `IG-4` is **approved with its rule revised** (Unicode
code-point minimum, 1024 UTF-8 bytes maximum, no charset restriction), and `IG-6` is
**conditionally approved** — the algorithm and encoding are final, the numeric parameters
are not. `docs/review/phase-3.2-s7-owner-decisions.md` *Amendment 1* is the record;
`api-conventions.md` §8.1 was corrected to match. S7 is still unimplemented.

`OPEN-01`'s external-input blocker is also removed by the earlier amendment (the dedicated
`app_auth` boundary is confirmed as final); the register entry
still closes only when a login path reads a credential through it.

**Update, 2026-11-21 (S7 registration implemented).** `POST /v1/auth/register` now exists
and is verified against the real roles. The write path is `insertRegisteredUser` in
`packages/database`, using the `app_auth` client; `app_api` was checked and is still
refused `42501` on both `SELECT password_hash` and `INSERT` into `app.users`. Duplicate
registration is decided by `users_email_key` (concurrent insert test included), never by a
prior `SELECT`, and the response omits `createdAt` because the grant does not cover it.
`OPEN-01` remains **unresolved**: registration is not the credential-*read* path, and
`ADR-004` closes the entry only when a login endpoint reads a credential through the
boundary. `IG-10` remains deferred and a public-deployment blocker; no mail infrastructure
exists. `IG-6` remains conditional — the local run has no memory limit and no concurrency
4, so it cannot satisfy the resource criterion.

**Update, 2026-11-21 (S8).** Login, session validation, the guard, `/me`, and logout are
implemented; `POST /v1/auth/login` reads the credential through `app_auth` and is verified
against the real roles, so `OPEN-01`'s remaining condition is met — see the *S8 verification*
section below. Two gates moved: `IG-8` is implemented, `IG-9` is **partially** implemented
(`Origin` yes, synchronizer token no). S7's post-commit corrections landed in the same pass
and are listed there.

### S8 verification, 2026-11-21

The base implementation is committed and pushed as `7c7b61a` (`feat(auth): implement S8
login and sessions`); the session-resolution and CORS `PUT` hardening is committed and
pushed as `913b041` (`fix(auth): resolve sessions in one locked statement`). The
expiry-during-lock-wait correction described at the end of the hardening section is in the
working tree after `913b041` and is not committed.

| Check | Command | Result |
|---|---|---|
| Workspace build | `pnpm build` | exit 0 — 5/5 tasks |
| Workspace typecheck | `pnpm typecheck` | exit 0 — 7/7 tasks |
| Workspace lint | `pnpm lint` | exit 0 — 5/5 tasks |
| Workspace tests | `pnpm test` | exit 0 — contracts **213**, api **199**, database **34** |
| Schema suite | `pnpm --filter @agroclimate/database test:schema` | **22 passed** |
| RLS suite | `pnpm --filter @agroclimate/database test:rls` | **90 passed** |
| Real-role integration | `NODE_ENV=development pnpm --filter @agroclimate/database test:integration` | **38 passed** |
| Prettier | `pnpm format:check` | exit 0 |
| Whitespace | `git diff --check` | exit 0 |

What the real-database suite proves that a double cannot: the session insert writes only
the granted columns and the database owns `created_at`; both deadlines are computed from
`now()` and land at exactly 30 and 90 days; `app_auth` is refused `42501` when it tries to
rewrite `token_hash`, `user_id`, `absolute_expires_at`, or `created_at`, and when it tries
to `DELETE`; `app_api` is refused `42501` on every session statement and on
`SELECT password_hash`; and two concurrent requests produce exactly one extension,
because the throttle is rechecked against the winner's committed row under a row lock.

Session boundaries are also asserted at the SQL level: a row past its sliding deadline and
a row past its absolute deadline are both rejected while the row remains present, and a
revoked row never resolves. The fixtures that age a row rewrite `created_at` together with
the deadlines, because `sessions_expiry_order_check` (`expires_at > created_at`) correctly
refuses a row whose deadlines precede its own creation.

`OPEN-01`'s remaining condition is now met: `POST /v1/auth/login` reads `password_hash`
through `app_auth`, the lookup needs no `app.user_id`, and `findAuthUserByEmail` is
covered by an integration test that asserts `current_user = app_auth` and
`current_setting('app.user_id') = NULL`. `IG-10` and `IG-6` are unchanged.

### S8 CSRF completion, 2026-11-21

**Approved, implemented, verified, applied to the canonical development database, not
committed.** These are four different states and only the first three hold.

| Layer | State |
|---|---|
| Owner decision | *Amendment 4* (A4.1–A4.4) — storage, lifecycle, validation, migration ownership |
| Migration file | `prisma/migrations/20261121000000_session_csrf_token/migration.sql` |
| Applied to canonical dev DB | **yes** — `pnpm db:migrate`, 6/6 migrations; custom-format backup taken and validated first |
| Runtime code | `packages/database/src/auth-csrf.ts`, `apps/api/src/auth/csrf-token.ts`, `csrf-validator.ts`, `AuthGuard`, `GET /v1/auth/csrf` |
| Committed / pushed | **no** |

**Schema and grants.** One nullable `text` column (`csrf_token`), one CHECK
(`csrf_token IS NULL OR csrf_token ~ '^[A-Za-z0-9_-]{43}$'`), and two column grants to
`app_auth` — `SELECT (csrf_token)` and `UPDATE (csrf_token)`. No `NOT NULL`, no default,
no backfill, no generated column, no `SECURITY DEFINER`, no RLS change, no table
privilege, and `app_api`/`app_system` still hold nothing on `app.sessions`. Every existing
session kept `NULL` and stayed valid.

**Behaviour.** `GET /v1/auth/csrf` (behind `AuthGuard`) mints 32 CSPRNG bytes as
base64url on the first retrieval, stores them, and returns the same value on every later
retrieval — no rotation, so a second tab or a reload keeps working. The write is
conditional (`WHERE csrf_token IS NULL`), so a race leaves one token and the loser adopts
it. `Cache-Control: no-store`; the token appears in no other response, log line, or error
detail.

**Enforcement.** `AuthGuard` validates `X-CSRF-Token` on `POST`/`PUT`/`PATCH`/`DELETE`
after the session is resolved and before the handler. It is deliberately not route
metadata: a route behind the guard is protected by construction, so a new authenticated
mutation cannot be added with the check forgotten. `register`, `login`, and `logout` are
exempt because they never reach the guard, and `Origin` validation — unchanged and still
independent — covers them.

**Verification.** Real PostgreSQL, real roles: the migration applies; a `NULL`-token
session still resolves; lazy init mints once and never rotates; two concurrent retrievals
leave one value; revoked and both classes of expired session can neither read nor mint;
the CHECK refuses 42/44-character, padded, `+`/`/`, dot, space, and empty values with
`23514`; `app_api` is refused `42501` on `SELECT csrf_token`, `UPDATE csrf_token`, and any
`SELECT` of the table; `app_auth` still cannot rewrite `token_hash`, `created_at`,
`absolute_expires_at`, cannot `DELETE`, and cannot insert `csrf_token`. API tests cover
retrieval, `no-store`, `401` for every unusable session, stable repeat retrievals, the
guard's method matrix (missing/empty/short/non-canonical/duplicate/joined/foreign/absent
token → one `403 FORBIDDEN`), safe methods needing no token, the three exemptions, and
`Origin` still refusing a foreign origin on those exempt routes.

### S8 hardening, 2026-11-21 (committed as `913b041`, except the last correction)

**Session authentication could accept stale state.** `authenticate` ran
`findActiveSession` and then `extendSession`. The second call returned `null` both when
the five-minute throttle held and when the session had been revoked, had expired, or had
been deleted in between — and the caller could not tell them apart, so it fell back to the
deadline it had read *before* the revocation and answered `200`. A logout that committed
inside that window was silently ignored.

**Fix: one statement, with a row lock.** `resolveSession` replaces both calls:

1. `candidate` — `SELECT … FROM app.sessions WHERE token_hash = $1 FOR UPDATE`, which
   locks the row for the rest of the statement.
2. `extended` — `UPDATE … FROM candidate` that re-checks `revoked_at IS NULL`, both
   deadlines, and the five-minute window, and clamps with
   `LEAST(now() + INTERVAL '30 days', absolute_expires_at)`.
3. A final `SELECT` that classifies the row (`active` / `revoked` / `expired`) and returns
   the post-statement deadlines plus the user it belongs to.

Because the lock is held to the end of the statement, a concurrent revocation either
commits before the read — the row is then seen revoked — or after the subject has been
established. It can no longer land in between and be reported as "throttled". The
classification is used for the operator's log only; every non-active outcome is the same
`null` and the same `401`.

`FOR UPDATE` needs `UPDATE` on at least one column, which `app_auth` already holds
(`expires_at`, `last_seen_at`, `revoked_at`). No migration, grant, policy, role, or
`SECURITY DEFINER` object was added, and `app_api` still cannot read a session row.

**CORS methods.** `PUT` was added to the CORS method list. `originValidation` protects
`PUT` (`ADR-006` §D2.1.5), but the preflight did not advertise it, so a browser would have
refused to send the request the middleware was written for.

New tests (real PostgreSQL, real roles): throttled extension still authenticates and keeps
the old deadline; revoked / sliding-expired / absolutely-expired / unknown are classified;
extension after the window moves the sliding deadline and preserves the absolute one;
clamping holds; two concurrent requests produce exactly one extension and agree on the
deadline; a revocation that commits while the authentication statement is blocked on the
row lock is rejected; an extension that races a revoke cannot resurrect the session. API
tests add the same distinction against the double, plus `503 DEPENDENCY_UNAVAILABLE` when
the session store is unreachable.

**Expiry during the lock wait (correction, working tree after `913b041`).** The row lock
closed the revocation race, not the clock. `now()` is `transaction_timestamp()`: it is
fixed when the transaction begins, which for a single statement is *before* the scan
reaches the row. An authentication statement that queues behind another transaction's
`FOR UPDATE` could therefore outlive the session's deadline and still classify the row
`active` on the earlier instant — and, because the throttle was open, extend it. The
statement now reads `clock_timestamp()` once into a `MATERIALIZED` CTE that selects `FROM
candidate`, and every deadline check, the throttle, `last_seen_at`, the `LEAST(...)` clamp,
and the final classification use that one value. `MATERIALIZED` is required, not stylistic:
an inlined CTE is re-evaluated per reference, so the extension and the classification could
disagree. The dependency is the guarantee — `evaluation` cannot run before the candidate
scan yields its row, and the scan cannot yield it before the lock is granted. Proven by a
real PostgreSQL test that holds the row, asserts via `pg_locks` that the authentication
backend is blocked, waits past the deadline, releases the lock, and gets `expired` with
`last_seen_at` untouched. The same test fails against the `now()` form.

Remaining concurrency limitation, stated rather than implied: the guarantee is about the
window *inside* the statement. A revocation that commits after the statement returns but
before the response is written is not visible to that request — no design can close that,
and it is the price of not holding a transaction open across response serialisation. What
is closed is the window that the two-call shape created.

### S8 CSRF hardening, 2026-11-21 (working tree after `0d43c82`)

**The cookie lost its extension when CSRF refused.** `AuthGuard` authenticated, the
statement extended the sliding deadline, and only then did the CSRF check run — but
`setSessionCookie` was called after it, so a `403` discarded the new deadline the
database had already committed. The browser would keep a cookie expiring up to 30 days
earlier than the row, then appear signed out on a session that was still alive. The
cookie is now written once, immediately after authentication and before the CSRF check.
A `403` refuses the request, not the session, so the two are independent; the deadline is
still the one the statement returned, never a locally computed one, and the attributes
are unchanged.

**The CSRF statements read the clock more than once.** `clock_timestamp()` appeared twice
per `WHERE`, so the two deadlines could be compared against different instants and a
session expiring between them was half-live. Each statement now reads the clock once into
a `MATERIALIZED` CTE and compares both deadlines against `ev.at`. The claim additionally
takes the instant *after* its row lock: `candidate AS (SELECT id … FOR UPDATE)` followed
by `evaluation AS MATERIALIZED (SELECT clock_timestamp() FROM candidate)`, the same
dependency that fixes `resolveSession`. A concurrent claim also queues at that lock
instead of racing, so the single-winner rule still holds.

Proven on real PostgreSQL: a test holds the row, asserts through `pg_locks` that the claim
is blocked, lets the deadline pass, releases the lock, and gets `null` with `csrf_token`
still `NULL`. The same test fails against the previous shape — it minted a token for a
session that had already expired. Boundary tests cover issuing just inside the deadline and
refusing just after it. API tests assert the cookie deadlines: extended on success,
extended and still sent on a `403`, unchanged when the throttle holds, absent for an
unusable session, and the clearing behaviour unchanged.

### S7 corrections applied with S8

| Defect | Correction |
|---|---|
| `FixedWindowRateLimiter` evicted a live bucket to admit an unseen client, which could reset the requesting client's own counter | an existing bucket is always served from; an unseen client at capacity is refused (`429`, `Retry-After` pointing at the earliest real reset); only expired buckets are swept |
| `isUniqueViolation` treated every `23505` as a duplicate address | matched on `users_email_key` by constraint name, read structurally from wherever the driver nested it; an unattributable violation stays an internal error |
| `verifyPassword` returned `false` for every throw, turning a native failure into a silent `401` | a PHC shape check separates `MalformedPasswordHashError` from an operational failure, which propagates; the auth service maps the first to the uniform failure after doing the dummy work |
| No `Origin` validation existed | exact-match middleware on `POST`/`PUT`/`PATCH`/`DELETE`, ahead of the body parsers, answering `403 FORBIDDEN` with the standard envelope and the request id |
| CORS could not carry the session cookie | `credentials: true`, `X-CSRF-Token` allowed, rate-limit headers exposed; still an exact allowlist |
| The S7 row above said "not committed" | corrected |

What S2 deliberately does not contain: an auth endpoint, session issuance, an
`app_auth` role, a grant, a policy, or a migration. (This paragraph describes S2 at the
time it was written; the role, grants, and migrations arrived in S3–S5.) `OPEN-01`
remains unresolved because no login path exists; `OPEN-13` was resolved on 2026-11-20
once `ADR-005` was accepted **and** `20261118050000_sessions` was applied to the
canonical database **and** the S6 session suite was green there.

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
database application: **applied 2026-11-20** — `auth_boundary` and `sessions` were
applied together from 5/5, and `db:verify` on `127.0.0.1:5442` is 499 PASS / 0 FAIL /
0 SKIP. `OPEN-01`: **unresolved** (no login path yet).

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

## Phase 4 — Tenant-scoped Farm & Field

### Phase 4.1 — domain contracts, **design only**

Status: **designed, not implemented** — as a phase of its own. This phase added no source file,
migration, grant, policy, role, or dependency; the layers designed here shipped in 4.2–4.4. The
document is `docs/architecture/farm-field-domain-contracts.md`.

Phases 4.5–4.6 remain **not started**. Nothing below claims their work.

| Item | State |
|---|---|
| Domain definitions for Farm and Field | designed (§3) |
| Invariants, each assigned to contract / database / derived | designed (§5) |
| Tenant API surface, 10 endpoints | designed (§6) |
| Contract schemas | `farm` and `pageMeta` **written in 4.3**; `field` and `geometry` **written in 4.4** (§7) |
| Tenant isolation behaviour, including nested access | designed (§9.4) |
| Implementation sequence 4.2–4.6 | proposed (§13) |
| Migration | **none needed** — `farms`/`fields` were applied in Phase 2.2.3 |
| Owner decisions | `Q1`–`Q8` **approved 2026-11-21** (§12) |

What the design rests on, verified rather than assumed: `app.farms` and `app.fields` exist with
`FORCE` RLS and `app_api` RW grants (`20261118020000_tenant_tables`); the composite FK
`(farm_id, user_id) → farms (id, user_id)` makes a cross-tenant parent a `23503`, not a row;
`withTenant` is transaction-local and rejects nesting (`tenant.ts`); contracts enforce
`strictObject` + a branded `*_NOT_FOUND` family, so `FARM_NOT_FOUND`/`FIELD_NOT_FOUND` need no
enum change; `api-conventions.md` §5 fixes `?page&pageSize` (max 100) and `?sort=`; the Farm
collection implements it in 4.3.

Scope decision recorded: the contract accepts `POLYGON` only and the database is left unchanged.
`OPEN-17` (`POINT` ⇒ `area_ha = 0`, which `FieldSnapshotPayload.areaHa` rejects) therefore stays
open rather than resolved by this phase; `Q1` was answered afterwards — point fields are not a
v1 requirement, and the database CHECK remains untouched.

Three `ST_GeomFromGeoJSON` behaviours were measured against the applied database. The first
statement of this paragraph was wrong when written and is corrected here: an unclosed ring is
stored unclosed (so `ST_IsValid` refuses it), and a `crs` member is **honoured** (so the SRID
CHECK refuses it, and `ST_SetSRID` must not be used to mask it). The third statement was wrong
too: this paragraph originally said 3D positions were accepted with no database objection.
Measured against the applied column, a `POLYGON Z` is **refused** — `app.fields.geom` is
`geometry(Geometry,4326)`, whose typmod is two-dimensional, so PostGIS answers `22023`
(`Geometry has Z dimension but column does not`). The correction was made in 4.4.2 and the
dimensionality is now asserted by `packages/database/test/schema/schema-conformance.test.mjs`.
See Phase 4.2 and §Phase 4.4.2.

### Phase 4.2 — database layer — **implemented and verified**

Status: implemented in `packages/database`, verified against real PostgreSQL and the real
roles. **No HTTP route, no contract schema, no migration, no grant, policy, role, or dependency
was added.** `createTenantScope` remains the only entry point for tenant data.

| File | Contents |
|---|---|
| `packages/database/src/farms.ts` | `createFarm`, `listFarms`, `findFarm`, `updateFarm`, `softDeleteFarm`; `Farm`, `FarmCreate`, `FarmUpdate`, `FarmSort`, `FarmPage`, `FarmDeleteOutcome` |
| `packages/database/src/fields.ts` | `createField`, `listFields`, `findField`, `updateField`, `softDeleteField`; `Field`, `FieldCreate`, `FieldUpdate`, `FieldSort`, `FieldPage`, `PolygonGeometry`, `FieldGeometryError` |
| `packages/database/src/index.ts` | barrel exports for both modules |
| `packages/database/test/integration/farm-field.test.mjs` | 26 assertions, `app_api` + real RLS |

Every function takes the transaction `withTenant` opened; none opens its own scope, so nesting
stays rejected. The tenant is never an argument: the predicate is
`user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`, the same expression the
policy reads, and an unscoped insert fails closed on `NOT NULL`. `deleted_at IS NULL` is written
on every statement because RLS does not filter it.

**Delete/create concurrency.** `softDeleteFarm` locks the farm row with `FOR UPDATE`, then checks
for live fields in a *separate statement* — a separate snapshot under READ COMMITTED, so a field
committed while the lock was queued is seen — and only then updates. `createField` takes
`FOR SHARE` on the parent, which conflicts with that `FOR UPDATE` in both directions. Two
integration tests hold each transaction open across the other lane's call and assert both the
lock queue (`pg_locks`) and the outcome. Both were shown to fail against a real regression:
removing `FOR SHARE` lets a field land under a deleted farm, and folding the check into the
locking statement (one snapshot) returns `deleted`.

**Geometry.** GeoJSON `Polygon` in, `ST_GeomFromGeoJSON($::text)` (the cast is required: three
overloads), `ST_AsGeoJSON(geom)::jsonb` out, `area_ha` read from the generated column and never
written. No `ST_SetSRID` wrapper: the parser **honours** a `crs` member (measured: SRID 3857), so
wrapping it would store coordinates mislabelled 4326 with a wrong but positive area. The layer
refuses a non-`Polygon` type and any `crs`/`bbox` member before SQL (`FieldGeometryError`),
because the column still accepts `POINT` (`OPEN-17`); a raw `POINT` row read back is refused
rather than typed as a polygon.

| Check | Command | Result |
|---|---|---|
| Database unit tests | `pnpm --filter @agroclimate/database test` | **34 pass, 0 fail** |
| Farm/Field integration | `NODE_ENV=development node --test test/integration/farm-field.test.mjs` | **26 pass, 0 fail** |
| All integration suites | `NODE_ENV=development pnpm --filter @agroclimate/database test:integration` | **66 pass, 0 fail** |
| Tenant/RLS suites | `NODE_ENV=development pnpm --filter @agroclimate/database test:rls` | **90 pass, 0 fail** |
| Schema conformance | `NODE_ENV=development pnpm --filter @agroclimate/database test:schema` | **22 pass, 0 fail** |
| Privilege verification | `NODE_ENV=development pnpm --filter @agroclimate/database db:verify` | all checks pass, exit 0 |
| Workspace typecheck / build / lint | `pnpm typecheck`, `pnpm build`, `pnpm lint` | exit 0 |
| Format / whitespace | `pnpm format:check`, `git diff --check` | exit 0 |

`db:verify` failed on one pre-existing assertion before this phase's tests ran: the `app.sessions`
column inventory still said "eight approved columns" after `20261121000000_session_csrf_token`
added `csrf_token`. That expectation was corrected in `scripts/lib/privilege-verification.mjs`;
it is not a Phase 4.2 code change, but leaving a red verification suite would have hidden the
result of the run above.

Not done, and not claimed: HTTP endpoints, contract schemas in `packages/contracts`, `409`
mapping (the primitive returns `has_live_fields`), rate limiting, `If-Match`, and every question
in `Q5`–`Q8`.

### Phase 4.3 — Farm CRUD API — **implemented and verified**

Status: implemented. Five endpoints are routed, validated, authenticated, tenant-scoped, and
tested through the real HTTP pipeline against PostgreSQL. No Field route, no migration, grant,
role, policy, or dependency was added.

| File | Contents |
|---|---|
| `packages/contracts/src/page.ts` | `pageMetaSchema`, `PageMeta` |
| `packages/contracts/src/farm.ts` | `farmCreateSchema`, `farmUpdateSchema`, `farmSchema`, `farmSortSchema`, `farmListQuerySchema`, `farmIdSchema`, `farmEnvelopeSchema`, `farmListEnvelopeSchema` |
| `packages/contracts/src/farm.test.ts` | 12 contract assertions (lengths, strictness, presence semantics, paging, envelopes) |
| `apps/api/src/farm/farm.controller.ts` | the five routes, path/query/body pipes, `Location`, `404`/`409` mapping |
| `apps/api/src/farm/farm.service.ts` | one `withTenant` per request, resource mapping, offset clamp |
| `apps/api/src/farm/farm.module.ts` | controller + service |
| `apps/api/src/app.module.ts` | registers `FarmModule` |
| `apps/api/src/auth/auth.module.ts` | `global: true`; exports `AuthGuard`, `AuthService`, `CsrfValidator` |
| `apps/api/test/integration/farm.test.mjs` | 25 assertions, real `app_api`/`app_auth`, real RLS |

Endpoints: `POST /v1/farms` (`201` + relative `Location`), `GET /v1/farms`
(`{ data, meta: { page, pageSize, total } }`, default `page=1&pageSize=20&sort=-createdAt`),
`GET /v1/farms/:farmId`, `PATCH /v1/farms/:farmId` (last-write-wins, `Q8`),
`DELETE /v1/farms/:farmId` (`204`; `409 CONFLICT` when live fields exist, `Q2`).

Integration: the tenant comes only from `request.auth.user.id`; every request opens exactly one
`createTenantScope(prisma).withTenant(...)` and hands the transaction to the 4.2 primitive. The
service contains no SQL. `AuthGuard` authenticates the session and, because it derives the
requirement from the HTTP method, enforces `X-CSRF-Token` on `POST`/`PATCH`/`DELETE`; `Origin` is
validated by middleware before body parsing. `GET` requires no CSRF token.

`AuthModule` became global and exports the guard with its two dependencies. Nest resolves a
class-reference enhancer in the consuming module, so `FarmModule` must see `AuthService` and
`CsrfValidator`; the alternative was importing `AuthModule.register(...)` a second time, which
would create a second `app_auth` pool and a second rate limiter. The auth database client and the
password hasher remain unexported.

| Check | Command | Result |
|---|---|---|
| Farm HTTP integration | `pnpm --filter @agroclimate/api test:integration` | **25 pass, 0 fail** |
| API unit suite | `pnpm --filter @agroclimate/api test` | **206 pass, 0 fail** |
| Contract suite | `pnpm --filter @agroclimate/contracts test` | **223 pass, 0 fail** |
| Database suites | `pnpm --filter @agroclimate/database test:integration`, `test:rls`, `test:schema` | run in §Phase 4.2; unchanged by 4.3 |
| Workspace typecheck / build / lint | `pnpm typecheck`, `pnpm build`, `pnpm lint` | exit 0 |
| Format / whitespace | `pnpm format:check`, `git diff --check` | exit 0 |

The Farm HTTP suite is a separate script (`test:integration`) because it needs a migrated database
and `NODE_ENV=development` for role DSN derivation; `pnpm test` stays database-free.

What the suite covers: `201` + `Location` + server-assigned ownership read back as
`migration_owner`; unknown keys, blank name, and the `Q6` length boundaries; `401` without a
session on all five endpoints; `403` for an untrusted `Origin`, a missing token, and a wrong
token; list scoping, default sort, explicit sort, paging, `meta`, and the `400`s for unknown
parameters, unlisted sorts, `page=0`, `page=1.5`, and `pageSize=101`; identical `404
FARM_NOT_FOUND` for missing, foreign, and deleted farms on read, update, and delete; `400` for a
non-UUID path; PATCH presence semantics (`null` clears, absent keeps), empty update rejection,
`name: null` rejection, and last-write-wins; `204` soft delete with the row still present and
absent from reads and lists; `409` for a farm with a live field, then `204` once that field is
soft-deleted; and two seeded tenants proving isolation.

Not done, and not claimed: Field CRUD (4.4), `geometry.ts`/`field.ts` contracts, `If-Match`,
additional rate limiting (`Q7`), viewport queries, and every 4.5 hardening item.

### Phase 4.4 — Field CRUD API — **implemented and verified**

Status: implemented. Five endpoints are routed, validated, authenticated, tenant-scoped, and
tested through the real HTTP pipeline against PostgreSQL, including geometry. No migration,
grant, role, policy, or dependency was added; no Field agronomic column is exposed.

| File | Contents |
|---|---|
| `packages/contracts/src/geometry.ts` | `polygonGeometrySchema` (Polygon only, 2D, closed ring, WGS 84 bounds, strict) |
| `packages/contracts/src/field.ts` | `fieldCreateSchema`, `fieldUpdateSchema`, `fieldSchema`, `fieldSortSchema`, `fieldListQuerySchema`, `fieldIdSchema`, both envelopes |
| `packages/contracts/src/field.test.ts` | 16 contract assertions (type, dimension, closure, extra members, bounds, strictness, paging) |
| `apps/api/src/field/field.controller.ts` | five routes, pipes, relative `Location`, `FIELD_NOT_FOUND`/`FARM_NOT_FOUND` |
| `apps/api/src/field/field.service.ts` | one `withTenant` per request, geometry→resource mapping, offset clamp |
| `apps/api/src/field/field-errors.ts` | `FieldGeometryError` + SQLSTATE `23514` → `400 VALIDATION_FAILED` |
| `apps/api/src/field/field.module.ts` | controller + service, no imports |
| `apps/api/src/app.module.ts` | registers `FieldModule` |
| `apps/api/src/auth/auth.guard.ts` | `authenticatedUserId(request)`, shared by both controllers |
| `packages/database/src/fields.ts` | `listAllFields(tx, options)` for the flat collection |
| `apps/api/test/integration/field.test.mjs` | 30 assertions, real `app_api`/`app_auth`, real RLS |
| `apps/api/test/integration/support.mjs` | harness shared with the Farm suite |

Endpoints: `POST /v1/fields` (`201` + relative `Location`), `GET /v1/fields`
(`{ data, meta }`, default `page=1&pageSize=20&sort=-createdAt`, optional `?farmId=` filter),
`GET /v1/fields/:fieldId`, `PATCH /v1/fields/:fieldId` (last-write-wins, `Q8`),
`DELETE /v1/fields/:fieldId` (`204`). The nested `POST/GET /v1/farms/:farmId/fields` shape is not
routed: `Q3` chose the flat collection, and the `farmId` filter carries the parent semantics.

Geometry is validated in two places on purpose. The contract owns everything structural — type
must be `Polygon`, positions are exactly two finite numbers in WGS 84 range, rings have at least
four positions and are closed, `crs`/`bbox`/other members are refused — and PostgreSQL owns
topology (`ST_IsValid`, `ST_IsEmpty`, the SRID check). A self-intersecting ring passes validation
and is refused by the database with `23514`; the API maps that SQLSTATE to
`400 VALIDATION_FAILED` with `details: [{ path: "geometry", issue: "invalid_geometry" }]`. No
geometry is repaired, simplified, reprojected, or re-serialised in JavaScript: `ST_GeomFromGeoJSON`
parses the request and `ST_AsGeoJSON` renders the response. `ST_SetSRID` is not used, so a declared
foreign CRS cannot be relabelled as 4326. `areaHa` is read from the generated column and never
accepted as input.

Integration: tenant from `request.auth.user.id` only; exactly one `withTenant` per request; the
service holds no SQL. A create whose parent is missing, foreign, or deleted returns
`FARM_NOT_FOUND`; a field that is missing, foreign, or deleted returns `FIELD_NOT_FOUND`, always
identically. `GET` needs no CSRF token; `POST`/`PATCH`/`DELETE` need session, trusted `Origin`, and
`X-CSRF-Token`, all from the existing guard and middleware.

| Check | Command | Result |
|---|---|---|
| Farm + Field HTTP integration | `pnpm --filter @agroclimate/api test:integration` | **55 pass, 0 fail** (30 Field, 25 Farm) |
| API unit suite | `pnpm --filter @agroclimate/api test` | **206 pass, 0 fail** |
| Contract suite | `pnpm --filter @agroclimate/contracts test` | **239 pass, 0 fail** |
| Database integration / RLS / schema | `pnpm --filter @agroclimate/database test:integration`, `test:rls`, `test:schema` | **66 / 90 / 22 pass, 0 fail** |
| Privileges | `pnpm --filter @agroclimate/database db:verify` | all checks passed |
| Workspace typecheck / build / lint | `pnpm typecheck`, `pnpm build`, `pnpm lint` | exit 0 |
| Format / whitespace | `pnpm format:check`, `git diff --check` | exit 0 |

What the Field suite covers: `201` + `Location` + the seven public keys only + ownership read back
as `migration_owner`; `areaHa` equal to the stored generated value and rejected as input;
`FARM_NOT_FOUND` for a foreign, missing, or deleted parent with no row written; every geometry
refusal (Point, MultiPolygon, LineString, GeometryCollection, 3D, empty, short ring, unclosed
ring, `crs`, `bbox`, string ordinates, out-of-range); the self-intersecting ring as `400` with the
documented detail and no row; `userId`, `deletedAt`, agronomic columns, and snake_case columns
rejected; `401` without a session on all five routes; `403` for an untrusted `Origin` and a
missing CSRF token; flat list scoping, `farmId` filter with farm-scoped `total`, paging, `sort=areaHa`
ordering, and `400`s for an unknown parameter, a non-UUID filter, `page=0`, `page=1.5`,
`pageSize=101`; `404` for a foreign or deleted farm filter; soft-deleted fields hidden from list,
read, and update; PATCH presence semantics (`name` only leaves geometry and area unchanged,
geometry replacement recomputes the area) and rejection of `{}`, unknown keys, `areaHa`, `farmId`,
and `name: null`; a rejected geometry rolls the whole transaction back (name, geometry, area, and
`updated_at` unchanged); `204` soft delete with the row still present and a second delete `404`;
`409 CONFLICT` while the farm has a live field, then `204` after it is soft-deleted; and two
tenants proving read, update, delete, and create-under-foreign-farm isolation.

Not done, and not claimed: the nested farm collection route, `If-Match`, additional rate limiting
(`Q7`), the eight agronomic columns, viewport queries, farm geometry, and every 4.5/4.6 item. No
database test asserts `listAllFields` directly; it is covered through the HTTP list suite and the
RLS suite's predicates, and that is a gap rather than a claim.

### Phase 4.4.1 — stored geometry validation — **implemented and verified**

Status: corrective fix. `FieldService` re-validates every stored geometry with
`polygonGeometrySchema` before serialising it; a row outside the public contract is an explicit
`500 INTERNAL_ERROR`, never a rewritten shape. No migration, constraint, grant, dependency, or
route changed.

Root cause: `toResource` rebuilt the response with `ring.map(([longitude, latitude]) => …)`. A
third ordinate would have been dropped, and out-of-range ordinates were passed through, so the
API could serve a geometry that its own request contract rejects.

Measured before the fix (`migration_owner` seeded row, real `app_api` request): an off-grid
polygon (`lon 206.8`) was served as `200` with the out-of-range coordinates; a `POLYGON Z` could
not be stored at all — the column typmod is two-dimensional and PostGIS refuses the write with
`22023`, so the truncation was latent rather than observed; stored `POINT` and `MULTIPOLYGON` rows
were already `500`. After the fix the off-grid and non-polygon rows are `500 INTERNAL_ERROR` with
no geometry echoed, and a valid stored 2D polygon is still returned unchanged.

The mapper now uses the contract schema rather than a second copy of the rules, so input and
output agree by construction; it also returns mutable coordinate arrays, which removes the copy
that could lose an ordinate. Topological validity remains PostgreSQL's (`23514` → `400` on write).

| Check | Command | Result |
|---|---|---|
| Farm + Field HTTP integration | `pnpm --filter @agroclimate/api test:integration` | **60 pass, 0 fail** (35 Field, 25 Farm) |
| API unit suite | `pnpm --filter @agroclimate/api test` | **206 pass, 0 fail** |
| Contract suite | `pnpm --filter @agroclimate/contracts test` | **239 pass, 0 fail** |
| Workspace tests | `pnpm test` | database 34 pass, 0 fail |
| Database integration / RLS / schema | `test:integration`, `test:rls`, `test:schema` | 66 / 90 / 22 pass, 0 fail |
| Privileges | `db:verify` | all checks passed |

Limitation, deliberate: one unrepresentable row makes the whole page `500` rather than the row
being skipped, because omitting it would be silent data loss. The row can only be created outside
the API.

### Phase 4.4.2 — geometry documentation and transaction consistency — **implemented and verified**

Status: corrective. Documentation and comments were reconciled with measured PostGIS behaviour,
the schema suite now asserts geometry dimensionality, and `FieldService.update()` maps its
resource inside the tenant transaction. No migration, contract, route, grant, or dependency
changed. Scope was one runtime file, one schema test, one HTTP test, and two documents.

Geometry dimensionality: three places claimed or implied that a 3D position was stored as
`POLYGON Z`. None do now. `app.fields.geom` is `geometry(Geometry,4326)`; its typmod is
two-dimensional, so PostGIS refuses a `Z` assignment with `22023`. The API accepts a 2D Polygon
only (`polygonGeometrySchema`), and geometry returned by the API must satisfy that same schema
(4.4.1). The historical claim is preserved as a correction rather than deleted — §Phase 4.1
records that the original statement was wrong and why, and
`docs/architecture/farm-field-domain-contracts.md` §8 and §10.2 carry the measured result.

Schema conformance: a new test reads `public.postgis_typmod_dims(a.atttypmod)` for
`app.fields.geom` from the catalogue and requires exactly `2`. Measured on this database
(PostGIS 3.6): `2` for `geometry(Geometry,4326)`, `3` for `geometry(GeometryZ,4326)`, and `NULL`
for an unconstrained `geometry` — so the assertion fails both if the column gains a Z dimension
and if it loses its type modifier. Existing schema assertions were not replaced.

PATCH transaction: previously, the `UPDATE` ran inside `withTenant`, but `toResource` ran after
the transaction resolved. Consequently, a stored geometry the contract refuses produced a
committed `UPDATE` plus a `500`. The mapping now runs inside the callback, which is the same
transaction `withTenant` opens and therefore rolls back on throw. Measured before the change: the
`name` was persisted and `updated_at` moved while the client received `500 INTERNAL_ERROR`. After
it, the request still answers `500` and the row is unchanged.

The regression test seeds an off-grid geometry as `migration_owner`, records `name`,
`updated_at`, `geom`, `area_ha`, and `deleted_at`, sends a `name`-only PATCH as `app_api`, then
reads the row back and asserts all five are identical. The 4.4.1 checks are retained: 2D round
trip, off-grid refusal, `POLYGON Z` refused by the column (`22023`), stored `POINT` and
`MULTIPOLYGON` refused with `500`, and the collection failing closed rather than skipping a row.

| Check | Command | Result |
|---|---|---|
| Schema conformance | `pnpm --filter @agroclimate/database test:schema` | **23 pass, 0 fail** (was 22) |
| Farm + Field HTTP integration | `pnpm --filter @agroclimate/api test:integration` | **61 pass, 0 fail** (36 Field, 25 Farm; supersedes the 60 in §4.4.1) |
| Database integration / RLS | `test:integration`, `test:rls` | 66 / 90 pass, 0 fail |
| Privileges | `db:verify` | all checks passed |
| Workspace typecheck / build / lint / tests / format | `pnpm typecheck`, `pnpm build`, `pnpm lint`, `pnpm test`, `pnpm format:check` | exit 0 |
| Whitespace | `git diff --check` | exit 0 |

Not run: a sensitivity check that alters `app.fields` to `GeometryZ` — a schema mutation outside
this task; `postgis_typmod_dims` returning `3` for such a typmod was measured on a temporary
table instead. `db:reset` and `db:verify:probes` were not run (destructive / grant-mutating).

Phases 4.5 and 4.6 remain **not started**.

---

## Phase 5 — Climate Data Foundation — **5.0 contracts implemented; 5.1 adapter foundation started; 5.2.1–5.2.5 and 5.2.8 implemented, 5.2.6–5.2.7 pending; 5.3–5.8 not started**

Status: **5.0 partially implemented.** Phase 5.0 added contract and resolver code
to `packages/contracts`, with tests. It added no migration, Prisma model, route,
dependency, grant, policy, worker, provider adapter, queue, or persistence. The
design is `docs/architecture/climate-data-foundation.md`.

5.0's contract scope is started but not complete: the `OPEN-14` vocabulary freeze
and the job-lifecycle interface remain. 5.1 has begun: `@agroclimate/weather-core`
exists with a transport, a failure union, one real provider adapter (SEAS5 monthly),
and a monthly normalizer. Nothing here claims an ingestion job, a persisted record,
an aggregation, or a climate endpoint — 5.2 has steps 5.2.1–5.2.5 and 5.2.8 implemented
(literal hash fixtures, a registry keyed by `(provider, model)`, the `SpatialResolution`
result contract, a weather-core registry holding one synthetic entry, a tenant-scoped
field anchor, and the status reconciliation); 5.2.6–5.2.7 are pending and 5.3 through
5.8 are **not started**.

| Item | State |
|---|---|
| Climate plane architecture, adapter boundary, storage and read path | designed (§5) |
| Source evaluation, licensing posture, evidence freshness | designed (§4); evidence dated 2026-11-18 and **not re-tested** |
| Reconciliation of the 13 existing authorities | designed (§2), with three documented-but-absent items (§3.5) |
| Implementation sequence, 9 sub-phases | proposed (§8) |
| Verification strategy | specified (§7); nothing implemented |
| Decision register | 8 `OPEN-*` items assessed; 7 `Q-P5-*` decisions recorded; **none closed** (§9) |
| Owner decisions | 7 recorded; provider grid configuration, BMKG permission, the Open-Meteo commercial evaluation, a CHIRPS route, and the `precipitation_mean` quantity question (`Q-P5-7`) still need **external evidence or an owner call** |
| Migration | **none proposed** — the climate schema is already sufficient for a precipitation outlook |

What was measured rather than assumed, as `migration_owner` on 2026-11-21:

- Seven climate tables exist and are granted as documented: `outlook_cells` (10
  columns), `forecast_runs` (9), `ingestion_runs` (15), `weather_records` (32),
  `monthly_outlooks` (23), `climatology_normals` (11), `field_outlook_cells` (11,
  `FORCE` RLS, no `app_system` grant). Every documented index exists under its
  documented name, including `weather_records_live_key` (`NULLS NOT DISTINCT`) and
  `monthly_outlooks_active_key`.
- `app_api` holds only a **column** `INSERT` on `outlook_cells` (`provider`, `model`,
  `cell_key`), so a cell's served coordinate must be filled by `app_system` — a
  two-phase lifecycle no code implements yet.
- `weather_records_data_class_check` admits only the four forecast classes, and
  `monthly_outlooks_variable_check` admits only `precipitation`. Both are load-bearing
  and both constrain what Phase 5 can ingest.
- `apps/worker/src/main.ts` is a stub; no queue library, Redis client, scheduler, or
  HTTP client is installed in any workspace package.

Three divergences recorded, not silently patched:

1. `background-processing.md` §10 names `sync_attempts`, a dead-letter surface, and a
   sweep watermark. **None of those tables exist.**
2. `tables-climate.md` §1 already anticipates the column-level `outlook_cells` grant
   correctly; the second phase of the fill has no implementation.
3. `weather.ts` `valueBase` accepts the broad `evaluationBasisSchema`, which includes
   `mixed`, while `temporal-and-weather-semantics.md` §4 permits `mixed` only on a
   container. `enums.ts` already exports the narrow `singleValueEvaluationBasisSchema`
   that would fix it; the contract did not use it. **Fixed in 5.0** — `valueBase` now
   uses `singleValueEvaluationBasisSchema`, and a test proves `mixed` is rejected on a
   single value while remaining legal on a container.

What Phase 5 deliberately does **not** do: implement a provider adapter, add a
worker, add a climate route, add a migration, close an `OPEN-*` item, or claim any
forecast skill. Months 8–12 remain labelled climatology; BMKG stays disabled by
default; `bias_corrected` stays `false`.

### Architecture reconciliation — 2026-11-21

A review of the Phase 5 design produced five owner decisions and one correction. All
of it is documentation; no sub-phase moved.

| Item | Outcome |
|---|---|
| Months 8–12 count | Corrected from "eight months" to **five** (`OPEN-18`-independent). A 12-month response always has twelve entries; lead months 8–12 are `climatology` with `beyond_horizon`, lead months 1–7 are `pending` when no forecast exists. Lead month is 1-based (`1–12`) |
| `OPEN-18` | Generic resolver contract **approved and implemented** (see below): provider/model-specific, explicit origin/spacing/orientation/revision, decimal-integer arithmetic, re-grid = new `model` string. Five provider grid configurations remain **pending external evidence** |
| `Q-P5-1` queue backing | **PostgreSQL-first**, behind a job interface: atomic claim, lease expiry, retry scheduling, in-place `attempt`, idempotency key, dead-letter status, shutdown, observability. No `jobs` table, no code, no dependency |
| `OPEN-03` Open-Meteo plan | **Deferred**, not closed. No paid-plan commitment; commercial operation conditional on verified licensing and an appropriate plan |
| `OPEN-05` raw payload retention | **Deferred** for the initial release. `reproducible: false` + `raw_payload_not_retained`; that is not the same as missing provenance |
| `OPEN-16` weather-record retention | **No automatic pruning** until at least one month of measured 5.4 ingestion; never delete provenance or audit data silently |
| Register consistency | The disposition counts said 18 DEFERRED / 9 BLOCKED, but the table held seven BLOCKED rows. Recomputed as 2 RESOLVED / 19 DEFERRED / 8 BLOCKED after `OPEN-18` moved; `open-decisions.md` §6 records `Q-P5-1`..`Q-P5-4` without changing the 29-item count |

What remains true: no migration is proposed by the phase; lead months 8–12 stay
climatology; BMKG stays disabled by default; `bias_corrected` stays `false`.
`open-decisions.md` §6 has since grown to `Q-P5-1`..`Q-P5-7`. Sub-phase 5.1 has
started (adapter foundation only); 5.2 has steps 5.2.1–5.2.5 and 5.2.8 implemented and
5.2.6–5.2.7 pending; 5.3–5.8 have no work started.

### Phase 5.0 — contracts and grid resolver — 2026-11-21

| Item | State |
|---|---|
| `packages/contracts/src/climate.ts` | **Implemented.** `ForecastRun` identity + row, `IngestionRun` identity + row, `ingestionVersionOf`, `AdapterResult` (five classes; complete/partial decided by counts, not the rounded percentage), `MonthlyOutlook` + `monthlyOutlookHorizonSchema` (lead month **1–12**, exactly twelve entries, calendar-month binding), monthly bands limited to products that actually return a monthly quantity — `seasonal_forecast` at lead months 1–7, `climatology` at 8–12 |
| `packages/contracts/src/grid.ts` | **Implemented.** `GridSpec`, `defineGridSpec`, `resolveGridCell`, `createGridRegistry`, `gridSpecHash`; integer micro-degree arithmetic; `south-west` orientation only. **Extended by 5.2.1–5.2.3:** four literal `gridSpecHash` fixtures pin the preimage in `grid.test.ts`; the registry is keyed by `(provider, model)` with declared `GridEvidence` and `requireValidated` (a synthetic entry fails with `grid_not_validated`); and `SpatialResolution`, `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"` and `createSpatialResolution` exist (the assembler re-checks the entry's `gridSpecHash` before resolving). `GridSpec` gained no provider, model, or evidence field; `models()` was removed with no replacement; the resolution result carries no served coordinate and no `distanceKm` |
| `packages/contracts/src/provenance.ts` | **Implemented.** `Reproducibility` and `DerivationProvenance`; empty `inputRefs` fails on `inputRefs`, not as "not reproducible" |
| `packages/contracts/src/weather.ts` | **Fixed.** `valueBase` uses `singleValueEvaluationBasisSchema`; `mixed` is container-only |
| Tests | `grid.test.ts` (vectors 1–18 of §5.2.7, orientation, lattice, hash, registry, F-06 immutability) and `climate.test.ts` (bases, identities, adapter coverage invariants, reproducibility, month cross-field rules, twelve-month horizon) |
| Executed | `pnpm --filter @agroclimate/contracts test` — **354 passed** at 5.0 (**392** after 5.2.1–5.2.3); `typecheck`, `lint`, `prettier --check`, `git diff --check` clean |
| Corrective pass | F-03 (lead month 1–12, twelve entries, calendar rollover), F-04 (`coveragePercentOf`, complete/partial invariants, zero-request rejected), F-05 (`dataClass` × `evaluationBasis` cross-checks), F-06 (deep-frozen `GridSpec`, frozen registry value), F-07 (counts decide complete/partial; a rounded 100 stays partial), then the monthly **source capability** rule: a month is accepted only from a product with a monthly quantity, so `weather_forecast` (16 d) and `subseasonal_forecast` (no EC46 monthly product) are rejected at every lead month |
| Not implemented | No adapter, no HTTP client, no queue, no worker runtime, no migration, no Prisma change, no route, no dependency, no persistence. No provider grid is asserted |
| Still open in 5.0 | `OPEN-14` vocabulary freeze; the job-lifecycle interface (now scoped to 5.3) |
| Layout deviation | Resolver is `packages/contracts/src/grid.ts`, not `packages/weather-core/cells/`; creating a package for one pure module had no consumer and `weather-core` is 5.1's |

### Phase 5.1 — provider adapter and normalizer foundation — 2026-11-21

| Item | State |
|---|---|
| `packages/weather-core` | **Created.** `@agroclimate/weather-core`, ESM+CJS build mirroring `contracts`, `zod` from the catalogue plus `@agroclimate/contracts` for the failure taxonomy |
| `src/http.ts` | **Implemented.** `Transport` boundary: `GET`, timeout via `AbortController`, caller `AbortSignal` via `AbortSignal.any`, streaming body cap, `Retry-After` parse. No retry, no JSON parsing, no provider knowledge |
| `src/failures.ts` | **Implemented.** `AdapterOutcome<T>`; the four shared kinds are `Extract<AdapterResult, …>["kind"]` from `@agroclimate/contracts`, so a contract rename fails to compile. Adds `incomplete_horizon`, `invalid_config`, `invalid_payload`, `unsupported_unit` |
| `src/adapters/open-meteo-seasonal.ts` | **Implemented.** Pins `models=ecmwf_seas5`, `monthly=precipitation_mean`, `forecast_days=217`; validates the monthly axis as **seven first-of-month keys that are seven consecutive calendar months** — each the calendar successor of the previous, so a dropped month is refused even though the row count is right (`F-10`); maps 429/4xx/5xx/other/network to the taxonomy; returns the provider-native series with the provider's own unit string and no `valueMm` |
| `src/normalize/monthly.ts` | **Implemented.** Unit gate (`mm` only), calendar continuity, null → `provider_null`, negative/non-finite refused, deterministic, frozen. **No conversion, no anomaly, no aggregation, no climatology fallback** |
| `src/calendar-month.ts` | **Implemented (F-10).** `parseCalendarMonth`, `formatMonthKey`, `isConsecutiveMonth` — `year * 12 + month` adjacency, no `Date`, no timezone, no elapsed-time division. Shared by the adapter and the normalizer so both boundaries enforce the same rule |
| F-10 | A seven-row monthly axis must be **seven consecutive calendar months**, not merely seven increasing keys: a dropped January would otherwise pass. Enforced in both the adapter (`provider_changed`) and the normalizer (`invalid_payload`), naming the index and both months. Row count and `SEAS5_EXPECTED_MONTHS` are unchanged, and this says nothing about what `precipitation_mean` means |
| Open-Meteo daily adapter | **Deferred** — needs record assembly and the daily coverage threshold; nothing would consume it |
| EC46 / ERA5 / CHIRPS adapters | **Deferred** — no monthly product, undecided dataset route, unresolved licensing |
| BMKG / Set VII adapters | **Blocked** — written permission and licence/GRIB proof of concept pending |
| Tests | **36 in `weather-core`** (deliberately every fixture is labelled synthetic; no network) |
| Executed | `pnpm --filter @agroclimate/weather-core test` — 36 passed; `typecheck`, `lint`, `build` clean. `pnpm typecheck` 8/8, `pnpm lint` 6/6 |
| Not implemented | No persistence, no Prisma change, no migration, no worker, no queue, no route, no config loader, no raw-payload store, no cell resolution |
| Open | `Q-P5-7` / `F-09` (`precipitation_mean` vs `valueMm`); `Q-P5-5`, `Q-P5-6` unchanged |

---

### Phase 5.2 — spatial resolution foundation — **5.2.1–5.2.5 and 5.2.8 implemented 2026-11-22; 5.2.6–5.2.7 pending**

| Item | State |
|---|---|
| Status | **Partially implemented.** Six of eight steps are done: literal hash fixtures (5.2.1, `44b278c`), the `(provider, model)` registry with declared evidence (5.2.2, `965f528`), the `SpatialResolution` result contract (5.2.3, `6963709`), the weather-core registry instance (5.2.4), the tenant-scoped field anchor (5.2.5), and the status reconciliation (5.2.8, `1dff5fd`). No route, no persistence, no migration. The design is `climate-data-foundation.md` §5.2.9 and `ADR-007` |
| Implemented — 5.2.1 | four literal `gridSpecHash` fixtures in `grid.test.ts`: 1° global, the same lattice under a second `gridId`, 0.25° global, 0.05° bounded. Editing the preimage, a preimage field, or `canonicalJson`'s treatment of one fails the suite; rewriting the object literal in another order does not, because keys are sorted |
| Implemented — 5.2.2 | `GridKey`, `GridEvidence`, `GridRegistryEntry`; registry keyed by `(provider, model)` through nested maps; `specFor`, `resolve`, `evidenceFor`, `requireValidated`; duplicate pair → `duplicate_grid_spec`, unknown pair → `unknown_model` naming both components, synthetic entry on an ingest path → `grid_not_validated`. No model-only overload; `models()` removed with no replacement. `CONTRACTS_VERSION` and the package version are `0.2.0` |
| Implemented — 5.2.3 | `6963709`. `SpatialResolution` and `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"` (typed as the constant's literal type, not `string`); `createSpatialResolution(entry, request)` re-checks `entry.spec.gridSpecHash` before resolving, so a hand-built entry or an edited lattice fails with `grid_spec_hash_mismatch`; it copies the caller's coordinate into `requested` unchanged, takes `anchor` from the resolver's own node, freezes the result and both nested objects, and never upgrades `evidence` |
| Implemented — 5.2.4 | `packages/weather-core/src/grids/{synthetic,registry}.ts`. Exactly one entry: provider `synthetic`, model `synthetic_1deg_20x20`, `gridId` `synthetic-1deg-20x20`, a bounded 20×20 one-degree lattice, `evidence: "synthetic"`. `syntheticGridRegistry` is `createGridRegistry([…])`, not a second implementation. The exact pair resolves deterministically; an unknown provider, an unknown model, and an unknown pair each fail with `unknown_model` naming both components; there is no model-only lookup and no fallback; `requireValidated` fails with `grid_not_validated`. The entry's `gridSpecHash` is pinned by a literal fixture, so editing the definition fails the suite |
| Implemented — 5.2.5 | `selectFieldAnchor(tx, fieldId)` in `packages/database/src/fields.ts`, returning `FieldAnchor { lat, lon }` as six-decimal **strings**. `ST_Centroid(geom)` inside the statement, `ST_X` → `lon`, `ST_Y` → `lat`, rounded with `round(…::numeric, 6)` so the six decimals are PostgreSQL's, not JavaScript's. Tenant, soft-delete, and existence are the same SQL predicate as `findField`, so another tenant's field, a deleted field, and a missing one all return `null`. Takes the caller's `TenantTransaction`; opens none. **Not** a cell, not a served coordinate, and no `outlook_cells` or `field_outlook_cells` write |
| Implemented — 5.2.8 | status reconciliation recorded in `1dff5fd`: the per-step status in §8.2, the §8.1 capability table, `OPEN-18` and `ADR-007`. No code change. It recorded 5.2.1–5.2.2 at the time; 5.2.3 landed later at `6963709` |
| Not implemented — 5.2.6–5.2.7 | `upsertCell`; `POST /v1/fields/:id/resolve-cell` |
| Evidence is declared, not verified | `GridEvidence` is a registry-entry value. `requireValidated` refuses an entry declared `synthetic`; nothing inspects the grade A + B documents behind `validated`. Admission to `validated` is an explicit review decision, and no provider has been admitted |
| Registry identity | `(provider, model)`, not `model` alone (§5.2.9.1) — **implemented**. One model string may exist under two providers; one `gridId` may label several pairs |
| `gridId` | a label on one definition, not unique and never a lookup key. `gridSpecHash` keeps `gridId` in its preimage because the hash pins a named definition |
| Result | `SpatialResolution` — `provider`, `model`, `gridId`, `gridSpecHash`, `resolutionAlgorithmVersion`, `evidence`, `requested` ≠ `anchor`, `i`, `j`, `cellKey`. **Implemented** in `grid.ts` (§5.2.9.2). No served coordinate, no `distanceKm`, no `extractionPolicy` |
| Longitude | four separate concepts — normalization, domain validation, wrapping, indexing — with a boundary table for `-180`, `180`, `0`, `360`, `-0.5`, `359.5`, and five questions left to the owner: three longitude, the `lonRange` bound, and the `spatialResolutionKm` hash preimage (§5.2.9.3, `OPEN-18`) |
| `field_outlook_cells` | **not written in 5.2.** `distance_km` is `NOT NULL` and is a distance to a served coordinate that does not exist yet; `0` is never a placeholder (§5.2.8) |
| Provider grids | all five still pending. Evidence is graded A (documented), B (measured), C (inferred), with a protocol; grade C never configures a row. The only registered entry is synthetic; no provider grid is configured and nothing is `validated` |
| Next | `climate-data-foundation.md` §8.2 step 5.2.6: `upsertCell` in a new `packages/database/src/climate.ts` |
