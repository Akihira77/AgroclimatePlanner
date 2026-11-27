# Implementation Status

Last updated: 2026-11-23.

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
3. No free gridded annual outlook — months 7–12 are climatology, permanently labelled.
4. CHIRPS bulk host unreachable from this environment — ERA5 archive is the shipped baseline fallback.
5. Model-relative anomalies are the primary user-facing number; baseline differences require grid matching and offset disclosure.
6. **ECMWF Set VII (13-month) is real but unproven for access** — months 7–12 stay climatology until a licence enquiry + GRIB POC succeed (ADR-001 D2a; Set VII's own forecast months 8–13 are its numbering, not this horizon's band).
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

## Phase 5 — Climate Data Foundation — **5.0 complete; 5.1 partially implemented; 5.2 complete (5.2.1–5.2.8); 5.3 complete; 5.4 implemented behind its gates; 5.5 implemented behind its gates; 5.6 implemented behind its gates (values + SEAS5 per-member monthly aggregates), spread not computed; 5.7A (climatology outlook materialisation), 5.7B (climatology read API) and 5.7D (seasonal materialisation, SEAS5) implemented — the 12-month horizon is complete; the 0–45 day read model is implemented (§Phase 5.9); 5.8 not started**

Status: **5.0 complete; 5.1 partially implemented; 5.2 complete, all eight steps;
5.3 complete; 5.4 implemented behind `OPEN-03` and `OPEN-18`; 5.5 implemented
behind the same two gates; 5.6 implemented behind the same two gates — the values,
their storage, and the ADR-001 D8b SEAS5 per-member monthly aggregates are done;
ensemble spread itself and probability are not; 5.7A materialises climatology outlook months, 5.7B serves them, and 5.7D materialises the six `seasonal_forecast` months one SEAS5 run covers, so every lead month 1–12 now has an approved source class; 5.7C's contract is resolved and migrated to the decisions that were implemented — the band is 1–6 / 7–12, run identity is two nullable FK columns, freshness is a read-time `availability` label; 5.8 not started.**
5.0 delivered the contract and resolver code in `packages/contracts` with tests, and
added no migration, Prisma model, route, grant, policy, worker, queue, or persistence.
It is complete as delivered: the `OPEN-14` vocabulary freeze remains a deferred open
decision rather than a missing deliverable, and the job-lifecycle interface moved to
5.3 by design.

5.1 is partial: `@agroclimate/weather-core` exists with a transport, a failure union,
one real provider adapter (SEAS5 monthly), and a monthly normalizer. 5.2 is complete:
literal hash fixtures, a registry keyed by `(provider, model)`, the `SpatialResolution`
result contract, a weather-core registry holding one synthetic entry, a tenant-scoped
field anchor, cell identity persistence, the resolution route, and the status
reconciliation. 5.3 is complete: the `app.jobs` migration, the PostgreSQL queue, the
worker runner, and the `IngestionRun` lifecycle. 5.4 is implemented: the Open-Meteo
daily forecast and ensemble adapters, a daily precipitation normalizer, the
`ingest.forecast` handler, the single settlement primitive, the per-run and
per-footprint advisory locks, and the T3 write transaction, and one additive
migration (deferred `weather_records.superseded_by_id` + a self-supersession
CHECK). It is **not a live
pipeline**: the worker is registered with `syntheticGridRegistry`, `requireValidated`
refuses `synthetic`, so every job terminates `grid_not_validated` before a provider is
called (`OPEN-18`), and `OPEN-03` blocks commercial production ingestion. No test
calls a provider; every adapter fixture is synthetic. 5.5 is implemented: the ERA5
archive adapter, the pure `@agroclimate/climate-core` baseline builder, the
`ingest.climate` handler registered in the worker, the versioned
`app.climatology_normals` write, and the baseline contract/hash. It adds **no
migration** and no queue. Like 5.4 it is not a live pipeline — the shipped registry
refuses `grid_not_validated` (`OPEN-18`), and `OPEN-03` still blocks commercial
ingestion — so no baseline row comes from a provider in this configuration, and the
suites use a fixture validated grid. CHIRPS is **not** implemented. 5.6 is
implemented on that same pattern: the EC46 daily request and the SEAS5 daily-member
request join the SEAS5 monthly one in `open-meteo-seasonal.ts`, and
`apps/worker/src/ingest/seasonal.ts` stores days 15–45 as `subseasonal_forecast`
member rows, the provider's seven months as `seasonal_forecast`, and — per ADR-001
D8b, now resolved on live evidence — **50 per-member monthly totals per month** as
`precipitation_sum`/`monthly_sum` rows. One `ingest.climate` handler serves both the
baseline and the two seasonal products (the payload decides). It adds **no
migration** — the existing CHECKs already permitted `seasonal`, both data classes
and member rows. Ensemble spread itself, probability and any confidence figure are
**not** computed; the aggregates exist so a later phase can compute spread from real
members, and neither mean column is ever stored as a member. 5.7A and 5.7B are
**delivered**: climatology months are assembled, persisted, and served by
`GET /v1/climate/outlook`, and 5.7D adds the seasonal half — six `seasonal_forecast`
months per complete SEAS5 run, band 1–6 with climatology at 7–12. The spread columns stay
`NULL` with a reason. 5.8 is **not started**. Nothing here claims a served coordinate on a
real grid, an anomaly, a spread, or a `field_outlook_cells` row; the seasonal months in the
suites come from fixture rows, because `OPEN-18` and `OPEN-03` still keep every real job
out.

Implementation evidence after the Phase 5.6 corrective pass (2026-11-23), all
executed in this working tree: contracts **413** tests, weather-core **118** (13
archive + 17 daily + 36 seasonal + 16 registry + 23 monthly, of which 8 are the new
member-aggregation cases + 13 SEAS5 member adapter cases), climate-core **14**,
database unit **34** + integration **122**, worker **2** unit + **84** integration
(19 climatology + 18 seasonal `ingest.climate` cases), API **206** unit + **74**
integration, `test:schema` **23**, `pnpm test` green (11 tasks), root `typecheck`
green (11 tasks), root `build` green (7 tasks), `db:verify` all privilege checks
passed (exit 0), `pnpm --filter @agroclimate/database test:rls` **92/92 green**,
Prettier clean. The RLS catalogue guard now expects **23** non-authentication `app`
tables and explains the arithmetic (26 in `app` − `users`, `sessions`,
`_prisma_migrations`); `climatology_baselines` and `climatology_normals` (both from
5.5) are probed like every other table, and no table was excluded to preserve the
old count. The five 5.4 corrective findings (F-01…F-05) and the 5.5 findings
F-01/F-02/F-03/F-05 remain addressed. The 2026-11-23 live probes recorded in
`docs/research/forecast-horizon-capabilities.md` prove the EC46 payload shape and
the SEAS5 daily-member shape, including that the mean of the 50 per-member monthly
sums reproduces the provider's `precipitation_mean` to its 0.1 mm rounding (ratios
0.989–1.011). No row in any table comes from a live provider. Owner decisions are
unchanged — `D21` and `D15c` are approved, `D1`/`D15`/`D15a`/`D15d`/`D15e` remain
implemented without an owner signature.

| Item | State |
|---|---|
| Climate plane architecture, adapter boundary, storage and read path | designed (§5); cell resolution and cell identity implemented (5.2), storage and read path not |
| Source evaluation, licensing posture, evidence freshness | designed (§4); evidence dated 2026-11-18 and **not re-tested** |
| Reconciliation of the 13 existing authorities | designed (§2), with three documented-but-absent items (§3.5) |
| Implementation sequence, 9 sub-phases | §8; 5.0–5.3 delivered, 5.4, 5.5 and 5.6 implemented behind their gates, 5.7A (climatology materialisation), 5.7B (climatology read API) and 5.7D (seasonal materialisation) implemented, 5.8 not started |
| Verification strategy | specified (§7); the 5.0–5.6, 5.7A, 5.7B and 5.7D portions are executed (evidence above), 5.8 not written |
| Decision register | 8 `OPEN-*` items assessed; 11 `Q-P5-*` decisions recorded, of which `Q-P5-7` is resolved (2026-11-24), `Q-P5-RUN` is partially resolved (direction approved, two mechanics open), `Q-P5-BAND` has its band resolved and its lead-1 anchor open, and `Q-P5-SPREAD` remains deferred; `D15`/`D15a`/`D15d`/`D15e` (the settlement contract) are implemented on the consolidated text and still await an owner signature; `D21` and `D15c` are owner-approved |
| Owner decisions | 7 recorded as approvals, plus `D21` and `D15c` in Phase 5.4; provider grid configuration, BMKG permission, the Open-Meteo commercial evaluation, and a CHIRPS route still need **external evidence**; `Q-P5-7` (the `value_mm` quantity) was resolved by the owner on 2026-11-24, and `Q-P5-8` (baseline selection) remains open |
| Migration | additive migrations only, none destructive: `20261122000000_jobs` (5.3), `20261123000000_weather_supersession` (5.4: `weather_records.superseded_by_id` → `DEFERRABLE INITIALLY DEFERRED`, plus `weather_records_no_self_supersession`), and `20261123010000_climatology_baselines` (5.5 corrective: one new table for baseline source metadata; `climatology_normals` unchanged). **5.6 adds no migration**: the existing `forecast_runs_product_check`, `weather_records_data_class_check` and `weather_records_ensemble_check` already admit the seasonal product, both seasonal data classes and member rows. **5.7D adds one additive migration**, `20261124000000_monthly_outlook_run_identity`: nullable `forecast_run_id` / `ingestion_run_id` FKs on `monthly_outlooks` plus a partial index. No existing column, grant, policy or row was altered by 5.5, 5.6 or 5.7D |

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
forecast skill. Months 7–12 remain labelled climatology (the band was 8–12 at the
time of that review; 5.7D restated it, §Phase 5.7D); BMKG stays disabled by
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

What remains true: no migration is proposed by the *plan* for 5.4; lead months 8–12 stay
climatology; BMKG stays disabled by default; `bias_corrected` stays `false`.
`open-decisions.md` §6 has since grown to `Q-P5-1`..`Q-P5-7`. 5.1 has started (adapter
foundation only); 5.2 has all eight steps implemented; 5.3 has the queue, runner and run
lifecycle implemented; 5.4 has its adapters, handler, settlement primitive and write
transaction implemented behind `OPEN-03`/`OPEN-18`; 5.5 has its adapter, builder, handler and versioned write implemented behind the same two gates; 5.6 has its EC46 and SEAS5 handlers, its SEAS5 per-member monthly aggregates (D8b) and its storage implemented behind the same two gates, with ensemble spread itself still not computed; 5.7A assembles and persists the climatology months, 5.7B serves them over HTTP, and 5.7D materialises the seasonal months (band 1–6) from a complete 50-member population; 5.8 has no work started.

### Phase 5.3 — run lifecycle and worker runtime — 2026-11-22

| Item | State |
|---|---|
| `20261122000000_jobs` | **Implemented.** `app.jobs` with four statuses (`queued`/`running`/`succeeded`/`dead`), `UNIQUE (kind, idempotency_key)`, lease columns, `ingestion_run_id` FK `ON DELETE RESTRICT`, five indexes including the unique partial `jobs_active_ingestion_idx`, and `GRANT SELECT, INSERT, UPDATE, DELETE … TO app_system` only |
| `packages/contracts/src/job.ts` | **Implemented.** `jobKindSchema` (six queues), `jobStatusSchema` (four states), `jobErrorSchema`, `ingestionJobPayloadSchema`, and `jobSchema` with refinements mirroring the lease and finish CHECKs. `ingestionJobIdentityOf` and `targetSelectorHashOf` live in `climate.ts`, with `canonicalArrayRules.cells` sorting on `(cellKey, variable)` |
| `packages/database/src/climate.ts` | **Implemented.** `upsertForecastRun` (natural-key upsert, `DO NOTHING` + read-back, `received_at` never rewritten), `beginIngestionExecution` (creates the run at handler start, increments `attempt` on retry without touching `started_at`, assigns `jobs.ingestion_run_id` in the same transaction), `markIngestionStatus` (`running` only; `partial` is terminal) |
| `packages/database/src/run-errors.ts` | **Implemented.** `LeaseLostError`, `IngestionAlreadyOwnedError`, `IngestionTerminalError`, `IngestionRunMissingError`, `JobRetryExhaustedError`, `TransientTransactionError`, `InvariantViolationError`, plus SQLSTATE classification that reads Prisma's driver-adapter envelope (`meta.driverAdapterError.cause`) |
| `apps/worker` | **Implemented, ESM.** `queue/types.ts` (the backing-neutral boundary), `queue/postgres.ts` (single-statement claim with `FOR UPDATE SKIP LOCKED`, renew, succeed/fail on the caller's transaction, release only while `ingestion_run_id IS NULL`, batched reaper), `runner.ts` (one job at a time, heartbeat, retry ladder 1/5/20 min, reaper on a timer even when idle, bounded shutdown), `main.ts` (connects as `app_system`, registers **no** handler) |
| Applied targets | lease 60 s, heartbeat 20 s, poll 1 s, shutdown grace 20 s, reaper 30 s |
| Tests | `job.test.ts` (identity, statuses, payload, refinements); `run-lifecycle.test.mjs` (14 cases: upsert, run creation, retry `attempt`, lease-loss rollback, terminal refusal, single running owner); `apps/worker/test/**` (2 unit + 18 integration: dedupe, dead-key retention, claim concurrency, lease renewal, reaper requeue/dead, stale token, inert handler, retry exhaustion, invalid payload, bounded shutdown) |
| Deliberate deviation | graceful shutdown does **not** release an in-flight lease once a handler has begun. Releasing it would let a second worker start while the first may still be writing; the lease expires and the reaper recovers it. `background-processing.md` §2.1 was corrected to match |
| Not implemented | no provider handler, no HTTP call, no `weather_records` write, no aggregation, no monthly outlook, no `field_outlook_cells` write, no `sync_attempts`, no separate dead-letter table, no pruning, no Redis |
| Known risk | lease takeover is possible: only the terminal transition is fenced, so a worker whose lease lapsed may still be writing when another worker takes over. 5.4 handlers must make writes idempotent. **Addressed in 5.4:** the write transaction re-proves the lease after the advisory wait and inside the same transaction, so a lapsed lease rolls the whole write back |

### Phase 5.4 — short-range forecast ingestion — 2026-11-23

| Item | State |
|---|---|
| `20261123000000_weather_supersession` | **Implemented and applied.** `weather_records_superseded_by_fkey` is now `DEFERRABLE INITIALLY DEFERRED` (a same-run replacement names its replacement id before that row exists) and `weather_records_no_self_supersession` forbids a row superseding itself. Verified against the live catalog: `condeferrable=t, condeferred=t, convalidated=t`. The migration opens with a pre-flight assertion block so it refuses to run on data that violates either invariant |
| `packages/weather-core/src/adapters/open-meteo-daily.ts` | **Implemented.** `fetchDailyForecast` (`forecast_days=15` — lead day 0–14 is the product horizon; 16 is the server's ceiling and is not requested, `timezone=UTC`, `precipitation_sum`) and `fetchDailyEnsemble` (`models=ecmwf_ifs025`, exactly 50 member columns validated by identifier — present, unique, inside `1..50`, malformed and unexpected columns rejected, mean column excluded, per-member nulls retained). Provider-native only: no `weather_records` row, no contract variable name, no unit conversion. Failure mapping is the existing union — 429 → `rate_limited`, 4xx → `request_invalid`, 5xx/timeout → `transport`, short or long axis → `incomplete_horizon`, shape drift → `provider_changed` |
| `packages/weather-core/src/normalize/daily.ts` | **Implemented.** `normalizeDailyPrecipitation`: `precipitation` / `mm` / `daily` / `daily_sum`, `valid_at` = the day's `00:00Z`, nulls preserved. Refuses a unit it has no approved conversion for. Temperature is deliberately **not** mapped: `OPEN-14` has no `daily_max`, and inventing one would put unapproved vocabulary in a provenance column |
| `packages/database/src/settlement.ts` | **Implemented (D15c).** `settlePair` — one primitive, modes `succeed`/`failed`/`adopt`, authority re-verified from the locked job (`authorityHolds` for a worker lease, a separate expired-lease predicate for the reaper), run id read from the locked job row, row counts asserted, both terminal statuses written atomically. `JobQueue.succeed`/`fail(terminal)` delegate to it; the worker path uses `settlePairAsWorker`. `partial` stays terminal success |
| `packages/database/src/weather.ts` | **Implemented.** Two advisory namespaces: `advisoryLockKeyOf` (two-integer tail of the run UUID) and `footprintLockKeyOf` (SHA-256 over `(cell_key, variable)`), acquired by `lockForecastWriteScope` — run key first, then the de-duplicated footprint set in ascending key order, which is the deadlock defence. `configureTransactionTimeouts` (transaction-local `lock_timeout`/`statement_timeout` before the first lock), `resolveForecastCells` (+`ProviderCoordinateDriftError`), `persistForecastRun` (born-superseded at INSERT, cross-run supersession by `initialized_at` / same-run by `ingestion_runs.created_at`, `supersedes_id` back-link, last-moment recheck), `extendHorizon` (`horizon_end` = last instant with a non-null value; `GREATEST` never shrinks; all-null reads the current value and advances nothing), `revalidateLease` |
| `apps/worker/src/ingest/forecast.ts` | **Implemented.** Verifies `targetSelectorHashOf(targetSelector) === targetSelectorHash`, resolves cells back through the registry, refuses a non-`validated` or non-node selector before any fetch, then runs T3: bounds → Job `FOR UPDATE` → remaining lease ≥ 30 s → IngestionRun → `lockForecastWriteScope` (run key, then sorted footprint keys) → lease revalidated → `persistForecastRun` → `settlePairAsWorker`, returning `settled` so the runner writes nothing further. Coverage counts non-null values; an all-null response is the terminal `no_values`, never a `succeeded` run with zero coverage |
| `apps/worker/src/{runner,main}.ts` | **Implemented.** `HandlerResult` gained `settled` and `commit_ambiguous`; the runner no longer writes run status before job status. `stopHeartbeat` is idempotent and is awaited **before** every settlement path (success, partial, handler-owned `settled`, terminal, retryable, exception), so no renewal can land after a terminal write or report a post-commit `lease_lost`. `main.ts` registers `ingest.forecast` with `syntheticGridRegistry`, and the startup log says so |
| `packages/contracts/src/job.ts` | **Implemented.** `ingestionJobPayloadSchema.targetSelector` (optional; the digest is not fetchable and the handler must not guess its cells). An `ingest.forecast` job without it fails `selector_missing` |
| Tests | weather-core **69** (the daily adapter file alone holds 17 cases, all fixtures synthetic: 15-value accept, shorter and longer axis rejection, lead day 14 last, and seven member-set cases); database **34** unit + **101** integration (10 new `forecast-persistence` cases: five horizon/null regressions and five real concurrent-transaction lock cases); worker **2** unit + **47** integration (`ingest.forecast`: persistence + settlement, same-run re-normalisation supersession with deferred-FK replacement ids, older run born superseded, two genuinely concurrent ingestions of one run, selector-hash refusal, `grid_not_validated`, all-null `no_values`, partial coverage; plus the 6 heartbeat/settlement ordering cases) |
| Gates that remain closed | `OPEN-18`: only `synthetic` is registered and `requireValidated` refuses it, so a real job dies `grid_not_validated`; tests use a fixture registry with an explicitly `validated` entry, which is the adapter-dev/test allowance. `OPEN-03`: no commercial production ingestion; the attribution string is provenance, not a licence decision |
| Not implemented | no scheduler, no budget bucket, no BMKG adapter, no aggregation, no `field_outlook_cells` write, no `sync_attempts`, no raw payload (OPEN-05) |
| Known risk | the cross-run race is closed by the footprint namespace, at the cost of serialising writers of one cell even when their instants do not overlap (the conflict domain is `(cell_key, variable)`). A selector in the hundreds would want a single server-side lock loop over the sorted keys; the ordering contract makes that swap safe. Key collisions (2^-32 per pair) merely serialise two unrelated footprints for one transaction. `transaction_timeout` is not configured anywhere, so the 15 s rung of the timeout chain does not exist yet |
| Test-suite edit disclosure | `apps/worker/test/integration/queue.test.mjs` was edited twice against the standing "do not edit tests" rule: the reaper case was rewritten to the adopt-don't-overwrite contract, and `refuses to release after an ingestion run was assigned` was given a suite-owned forecast run instead of `SELECT id FROM app.forecast_runs LIMIT 1` (that `LIMIT 1` made the case silently no-op on an empty database and fail on a populated one) |

### Phase 5.5 — climatology baseline — 2026-11-23

| Item | State |
|---|---|
| `packages/weather-core/src/adapters/open-meteo-archive.ts` | **Implemented.** `fetchArchiveDaily` pins `models=era5`, `daily=precipitation_sum`, `precipitation_unit=mm`, `timezone=UTC`, `cell_selection=nearest`, and the inclusive `start_date`/`end_date` window (1991-01-01…2020-12-31 = **10 958** days in one request; probed live on 2026-11-23: HTTP 200, ~200 KB, 0 nulls, unit `mm`, `utc_offset_seconds=0`). Validates status (429 → `rate_limited` with `Retry-After`, 4xx → `request_invalid`, 5xx → `transport`), JSON shape, array agreement, exact day continuity (a duplicate or skipped date fails even when the count matches), returned unit (`unsupported_unit`), finite coordinates, and the calendar range. Provider-native payload only — no aggregation, no stored row. `servedLatitude`/`servedLongitude` are recorded as the provider's answered coordinate and are **not** a grid node (OPEN-18). `buildArchiveSourceReference()` returns the same route and pinned parameters without coordinates/dates; the payload carries it so a version can store one source reference for a multi-cell build |
| `packages/climate-core/src/climatology.ts` | **Implemented (new package).** Pure and clock-free: `buildMonthlyClimatology` accepts `(dataset, cells[{cellKey, unit, days}], algorithmVersion?)` and returns 12 normals per cell. A calendar month counts a year only when **every** day of that month-year is present and non-null; a missing day is not `0` and a null is not an observation. The normal is the mean of valid **monthly totals**, never a mean of daily values. Negative, NaN and infinite amounts are refused, as are a non-`mm` unit, a duplicate day, an out-of-period day, a repeated cell key, and a month with no complete year (`incomplete_history`). `sampleYears` (1–30) is returned per month and `complete` is false unless all 12 months used all 30 years; no minimum-year threshold is invented. `baselineVersionOf` derives `ERA5:1991-2020:v1` deterministically from dataset, fixed period and algorithm version — no timestamp, no UUID. `CLIMATOLOGY_ALGORITHM_VERSION` is documented as the calculation/source-semantics token: aggregation, missing-data, sample-year, unit or provider-source changes bump it; a refactor or byte-identical adapter patch does not. `baselineHashPayloadOf` builds the subset payload the hash covers |
| `packages/contracts/src/{climate,hash,canonical,job}.ts` | **Implemented.** `baselineDatasetSchema`, `baselineMonthlyNormalSchema` (`month` must be the first of a calendar month; `sampleYears` 1–30), `baselineNormalsPayloadSchema`; `canonicalArrayRules.monthlyNormals` is a set ordered by `(cellKey, month)` where two conflicting normals for one identity are a canonicalisation error rather than a dropped duplicate; `hashBaselineNormals = sha256(canonicalJson(payload))`; `climatologyJobPayloadSchema` (`provider`/`model`/`baselineDataset` pinned, `algorithmVersion`, `targetSelectorHash`, `targetSelector`) — separate from `ingestionJobPayloadSchema` because a baseline opens no run |
| `packages/database/prisma/migrations/20261123010000_climatology_baselines` | **Added (F-02).** One new table, `app.climatology_baselines`, keyed by `baseline_version`: dataset, provider/model, `adapter_version`, coordinate-free `source_reference`, `attribution`, `retrieved_at`, period and `algorithm_version`. CHECKs: dataset enum, ordered period, `https://` source, non-blank text. `app_api` = `SELECT`; `app_system` = `SELECT, INSERT, UPDATE, DELETE`; no RLS, no tenant column, no FK from `climatology_normals` (existing rows have no metadata to back-fill). Additive only; no existing row or column touched |
| `packages/database/src/climatology.ts` | **Implemented.** `persistClimatologyBaseline(tx, input)` validates the whole output first (12 distinct months per cell, finite non-negative values, `sampleYears` 1–30, valid coordinates, ordered period, non-blank source fields, `https://` reference), writes the source row **first** with `ON CONFLICT (baseline_version) DO NOTHING`, and compares the stored identity (dataset, provider, model, `source_reference`, period, `algorithm_version`): a disagreement throws `ClimatologySourceConflictError`. `adapter_version`, `attribution`, `retrieved_at` and `computed_at` are audit fields, not identity. It then resolves cells through `resolveForecastCells` and inserts normals with `ON CONFLICT (baseline_version, outlook_cell_id, month) DO NOTHING`, reads all 12 back and compares dataset, period, value and sample count: an identical rebuild inserts nothing and reports `unchanged`, while a difference throws `ClimatologyConflictError`. **No `UPDATE` exists** — a changed baseline is a new `baseline_version`. The caller owns the transaction, so metadata, all cells and all months commit or roll back together |
| `apps/worker/src/ingest/climatology.ts`, `main.ts` | **Implemented.** `ingest.climate` with `opensIngestionRun: false` (no `ForecastRun`/`IngestionRun` is invented; settlement uses the job-only path). Before fetching: payload schema, `targetSelectorHashOf(targetSelector) === targetSelectorHash`, `registry.requireValidated`, and every selector cell re-resolved to a node of that grid. After each fetch: the served coordinate must match the resolved node within `NODE_COORDINATE_TOLERANCE_DEGREES = 1e-6°`, else `provider_coordinate_mismatch` (terminal, before any write); a later move is still `ProviderCoordinateDriftError` → `provider_changed`. Fetches each cell's full 1991–2020 window, builds, then one transaction: timeouts → job `FOR UPDATE` → lease/`running`/no-run checks → `persistClimatologyBaseline` (source row + normals) → `settlePairAsWorker`. Failure mapping is retryable for `rate_limited`/`transport` and terminal for `archive_incomplete`, `archive_unsupported_unit`, `archive_provider_changed`, `provider_coordinate_mismatch`, `baseline_conflict`, `baseline_source_conflict`, `insufficient_history`, `selector_invalid`, `grid_not_validated`. Structured logs report dataset, version, cell count, inserted/unchanged, completeness, the minimum sample years and the **actual** `baselineHash` (`hashBaselineNormals` over the consumed subset), which is logged but not stored |
| Database impact | **one additive migration** (above). `app_system` writes `app.climatology_normals` and `app.climatology_baselines`; `app_api` keeps `SELECT` on both (asserted in the suite, not assumed). No existing table, column, grant, policy or row was altered |
| Tests | weather-core **82** (13 archive cases, including the coordinate-free source reference), climate-core **14** (new), contracts **413** (5 baseline cases), database **34** unit + **120** integration (19 `climatology-persistence` cases: 12 rows, multi-cell, idempotent repeat, value/sample/dataset/period conflicts, old version intact, rollback on conflict, short/invalid/negative input, `app_api` read-only, no tenant column, durable metadata, metadata idempotence, source-identity conflict, adapter-patch tolerance, metadata read-only), worker **2** unit + **66** integration (19 `ingest.climate` cases: success without a run, duplicate enqueue, `grid_not_validated`, selector cell and hash refusals, 5xx retry, short axis, insufficient history, all-cell rollback, conflict, retry exhaustion, lease-token loss, reaper recovery, node match, outside-tolerance and interpolated coordinates, post-write drift, durable metadata, source-identity conflict, actual hash) |
| Gates that remain closed | `OPEN-18`: the shipped registry is `synthetic`, so a real `ingest.climate` job dies `grid_not_validated` before a byte is fetched; the suite's fixture registry is the adapter-dev allowance. `OPEN-03`: no commercial production ingestion; ERA5 attribution is recorded per version ("Contains modified Copernicus Climate Change Service information [year]") and is not a licence decision. No baseline row has been produced from a live provider by this process |
| Not implemented | CHIRPS and NASA POWER builders, temperature climatology, anomalies, retention/pruning, `field_outlook_cells` writes, a production grid, and any read API |
| Test-suite edit disclosure | `apps/worker/package.json` now runs `test:integration` with `--test-concurrency=1`: `queue.test.mjs` and the new `ingest-climatology.test.mjs` both claim `ingest.climate` jobs, and parallel files raced on the same rows (a concurrent cleanup deleted the other suite's job mid-handler). Serial files are the fix; no test assertion was weakened |

### Phase 5.6 — seasonal ingestion (EC46 and SEAS5) — 2026-11-23

| Item | State |
|---|---|
| `packages/weather-core/src/adapters/open-meteo-seasonal.ts` | **Extended.** The SEAS5 monthly request from 5.1 is unchanged (`models=ecmwf_seas5`, `monthly=precipitation_mean`, `forecast_days=217`, seven consecutive first-of-month keys, provider-native unit, no `valueMm`). EC46 daily is added beside it: `buildEc46DailyUrl` pins `models=ecmwf_ec46`, `daily=precipitation_sum`, `forecast_days=46` and **no** `timezone` parameter (the provider default is GMT); `fetchEc46Daily` asserts the **46-row** axis, that `time[0]` is the request day in UTC (so index is lead day, verified rather than assumed), that consecutive keys are consecutive days, that the mean column is present, and that the member set is exactly `member01..member50`. The mean column is excluded from the returned days, mirroring `fetchDailyEnsemble`; the payload carries 50 members × 46 days with `ensembleSize = 50`. `EC46_ADAPTER_VERSION = "open-meteo-seasonal-ec46@1.0.0"`. Live probe 2026-11-23 recorded in `docs/research/forecast-horizon-capabilities.md`: `200`, 46 rows `2026-11-23 … 2027-01-07`, 50 members + mean, day 45 null in every column. **SEAS5 daily members added 2026-11-23** (ADR-001 D8b): `buildSeas5MemberDailyUrl` pins `models=ecmwf_seas5`, `daily=precipitation_sum`, `start_date`/`end_date` from `seas5MemberWindow(initializedAt)` and **no** `forecast_days`/`timezone`; `fetchSeas5MemberDaily` asserts the calendar day count of the run's seven months (212 for a Nov–May window), that the axis starts on the first day of the initialization month and is consecutive, that the mean column is present, and that the member set is exactly `member01..member50`; the daily mean is never returned as a member. `SEAS5_MEMBER_ADAPTER_VERSION = "open-meteo-seasonal-seas5-member@1.0.0"`. Live probe 2026-11-23: `200`, 212 rows for `2026-11-01 … 2027-05-31`, 50 members + mean, and the mean of the 50 per-member monthly sums reproduced the provider's monthly `precipitation_mean` (ratios 0.989–1.011) |
| `packages/weather-core/src/adapters/open-meteo-daily.ts` | **Extended, no second implementation.** `getDaily` became exported `fetchDailyBlock`, and the member-set verification became exported `collectMembers(label, variable, columns, expected)`; `fetchDailyEnsemble` now calls it. The EC46 request therefore shares one HTTP failure contract (429/4xx/5xx/unexpected-status/timeout/oversize) and one member rule. `DailyProviderPayload.product` widened to include `"seasonal"`. No behaviour change for 5.4 |
| `packages/weather-core/src/normalize/monthly.ts` + `calendar-month.ts` | **Extended.** `aggregateMonthlyMemberTotals(payload, cellKey)` turns the 50 daily member series into per-member calendar-month totals. Rule: a member-month is the sum of that member's daily `precipitation_sum` over the month, stored only when the axis covers every day of that month **and** every one of those days carries a value; otherwise the row is kept with `value = null` (a missing day is not `0`). Duplicate days, impossible calendar days (e.g. `2027-02-30`), negative/non-finite amounts, a `null` member, and a non-`mm` unit are refused. Output rows: `variable = precipitation_sum`, `aggregation_level = monthly_sum`, `temporal_resolution = monthly`, `ensemble_member = 0..49`, `ensemble_size = 50`, `unit = mm`, `valid_at` = first of month `00:00Z`. `calendar-month.ts` gains `daysInMonth`/`addMonths`/`monthKeyOfDay` (integer month arithmetic, no `Date` timezone). `MONTHLY_MEMBER_AGGREGATION_VERSION = "monthly-member-aggregation@1.0.0"`, stamped on each stored aggregate row's `normalizer_version` so the derivation is traceable without re-reading the run. A null result also names **why** on the in-memory value (`MonthlyMemberMissingReason = axis_incomplete | member_incomplete | provider_null`); the reason is not persisted because `weather_records` has no reason column, and a partial sum is never published. The row-level constant is provenance only: an aggregation algorithm change must also bump the job payload's `normalizerVersion`, since it is not an input to `ingestionVersion` |
| `apps/worker/src/ingest/seasonal.ts` | **Implemented (new).** `kind: "ingest.climate"`. Product gate first: the run must have `product = 'seasonal'` and its model must map (`ecmwf_ec46` → `subseasonal_forecast` / `daily_sum`, `ecmwf_seas5` → `seasonal_forecast` / `monthly_mean`), else terminal `unsupported_product`. Then `targetSelector` presence, selector-hash equality, `registry.requireValidated`, and every selector cell re-resolved to a node of that grid. Per cell: fetch, then the served coordinate must be the node within `NODE_COORDINATE_TOLERANCE_DEGREES = 1e-6°` or `provider_coordinate_mismatch` (terminal, before any write, same rule as 5.5). EC46 records are trimmed to lead day ≥ 15 (`EC46_FIRST_SUBSEASONAL_LEAD_DAY`); SEAS5 records keep `variable = precipitation_mean`, `unit` as returned, `temporal_resolution = monthly`, `valid_at` = first of month `00:00Z`. **SEAS5 also fetches the daily members** and aggregates them at ingest (D8b); the member answer is separately coordinate-checked, and the monthly axis and the member window must name the same months or the job dies `provider_changed`. All-null answers are terminal `no_values`, never a `succeeded` run at 0 %. One transaction: timeouts → job `FOR UPDATE` → lease/`running`/run-id checks → ingestion-run lock → `lockForecastWriteScope` → `revalidateLease` → `persistForecastRun` → `settlePairAsWorker`. Retryable: `rate_limited`, `transport`. Terminal: everything else, plus `provider_coordinate_mismatch`, `ecmwf_ec46_incomplete`, `selector_missing`, `selector_hash_mismatch`, `unsupported_product`, `grid_not_validated`, `forecast_run_missing`, `no_values`, `provider_changed`, `member_series_missing` |
| Why days 0–14 are not stored | `persistForecastRun` supersedes live rows on `(cell_key, variable, valid_at, ensemble_member)` **without** filtering model, product or data class, and both EC46 and `ecmwf_ifs025` use the same variable name and member indices. Storing EC46 days 0–14 would let one model supersede the other's rows. The band boundary is therefore a correctness requirement, not cosmetic |
| Why the SEAS5 monthly totals are `precipitation_sum`, not `precipitation` | The same cross-product supersession applies at a *date*: a monthly aggregate is valid at the first of the month `00:00Z`, which is also a valid daily instant, and the member indices are the same `0..49`. Storing them as `precipitation` made a newer SEAS5 run supersede the older EC46 subseasonal rows for that day — observed in the integration suite as 50 vanished live rows. `precipitation_sum` (the provider's own daily quantity name) is a distinct key component, so the two products never collide; `aggregation_level`/`temporal_resolution` carry the monthly meaning. This was a real defect found and fixed in the corrective pass, not a hypothetical |
| Contracts | **none new.** A seasonal job is the existing `ingestionJobPayloadSchema` on the existing `ingest.climate` kind; the payload's `forecastRunId` distinguishes it from a climatology job. No new `jobKind`, no second queue, no contract variant. `background-processing.md` §2.1 already put EC46, SEAS5 and the baseline on one queue |
| `apps/worker/src/{main.ts,runner.ts}` | **Changed.** `JobHandler.opensIngestionRun` is now `boolean | ((payload: unknown) => boolean)` so one `ingest.climate` handler opens an `IngestionRun` for a seasonal job and none for a climatology job; the runner evaluates it per job before `beginIngestionExecution`. `main.ts` builds one `ingest.climate` handler that dispatches on `isSeasonalJobPayload(payload)`, registered beside `ingest.forecast` |
| Database impact | **none.** No migration, table, column or grant. `PersistForecastRunInput.product` / `dataClass` unions widened in `packages/database/src/weather.ts`; the SQL and every CHECK are untouched. `monthly_outlooks` is not written |
| Tests | weather-core **118**: seasonal adapter file **36** (the 21 SEAS5 monthly cases plus 15 EC46 — pinned URL and no `timezone`, 50×46 rows with the mean excluded and never mistaken for a member, member null preserved, axis not anchored on the request day, short/long axis, skipped day, duplicate/missing/51st/unexpected member, missing mean column, changed shape, non-JSON body, non-numeric column, 429/4xx/5xx/302/transport, no request for invalid configuration); SEAS5 member adapter file **13** (seven-month calendar window incl. leap February, range URL with no `forecast_days`, 50×212 rows, daily mean never a member, member null preserved, short/long/gapped/shifted axis, duplicate/missing/51st/unexpected member, missing mean column, 429/4xx/503/transport); monthly file **23** (15 pre-existing + 8 aggregation: 31/28-day calendar sums, member identity/provenance, one null day nulls only that member-month as `provider_null`, a member missing one day is `member_incomplete` while an axis missing a day is `axis_incomplete`, duplicate and impossible days refused, non-`mm`/negative/null-member refused). worker **2** unit + **84** integration (`ingest-seasonal` **18**: EC46 lead days 15–45 = 31×50 member rows in `subseasonal_forecast` with `daily_sum`/`mm`/size 50 and the run's own `initialized_at`; all-null → `no_values`; answered coordinate off the node; truncated axis → `ecmwf_ec46_incomplete`; 429 requeued with nothing written; SEAS5 seven months as `precipitation_mean`/`mm`/`monthly`/`monthly_mean` with provider values; **50 members × 7 months as `precipitation_sum`/`monthly_sum` with totals 31/31/28/31/30/31/30 and the 999 mean column never summed**, each member row carrying `normalizer_version = monthly-member-aggregation@1.0.0` while the means keep the payload's normalizer and the `ingestion_runs` row is unchanged; null month stored as null beside intact member rows at 99.72 % coverage and `partial`; one null member-day nulling only that member-month; SEAS5 idempotent enqueue and same-run re-normalisation supersession (357→714 rows, 357 linked); member series answered off the node; `grid_not_validated`; non-seasonal product; unsupported model; lease loss rolling back with the run left `running`; no tenant column and `app_api` cannot write). database integration **122** adds two cross-product cases: an EC46 `precipitation` member row and a SEAS5 `precipitation_sum` monthly aggregate on the same `(cell, valid_at, member)` both stay live with their `model`/`data_class`/`temporal_resolution`/`aggregation_level` intact, and re-normalising either product supersedes only its own predecessor |
| Gates that remain closed | `OPEN-18`: the shipped registry is `synthetic`, so a real seasonal job dies `grid_not_validated` before a byte is fetched; the suites use a fixture registry with explicit `validated` entries — the adapter-dev allowance, not provider evidence. `OPEN-03`: no commercial production ingestion, and the ECMWF/Open-Meteo attribution is provenance, not a licence decision. `OPEN-05`: no raw payload is retained |
| Not implemented, not claimed | Ensemble spread, probability, terciles, exceedance, any confidence figure, `model_skill`. The EC46 member rows and the SEAS5 per-member monthly totals exist so spread can be derived from real members later; **nothing derives it now**, and no mean column is stored as a deterministic member (ADR-001 D8/D8b). Also absent: monthly→daily conversion, `precipitation_mean` → `valueMm` reinterpretation, monthly-mean→accumulation conversion, climatology filling, anomaly, bias correction (`bias_corrected` is CHECK-forced false), `monthly_outlooks` (5.7), `field_outlook_cells` |
| Deferred question | `Q-P5-7` (`precipitation_mean` is a monthly mean, `valueMm` is a monthly total) was untouched **by 5.6**: the provider's name, unit and value were stored as they arrived. It was resolved by the owner on 2026-11-24 (§Phase 5.7B) |
| Test-suite edit disclosure | Two test files were edited in this corrective pass, on explicit instruction: (1) `apps/worker/test/integration/ingest-seasonal.test.mjs` — the pre-existing 14 cases were extended to 18 and the SEAS5 expectations moved from 7 rows to 357 (7 means + 350 member totals); this file was already owned by 5.6 and still cleans up its own job keys and rows in `after`, because it deliberately leaves a retry-scheduled job and a lease-lost one; (2) `packages/database/test/rls/auth-boundary.test.mjs` — the stale 21-table catalogue guard was corrected to 23 with the arithmetic in the message; every per-table RLS/privilege probe is untouched. New test files were added (`open-meteo-seasonal-members.test.ts`, 7 cases appended to `normalize/monthly.test.ts`); no production test was weakened or skipped |

### Phase 5.7D — seasonal outlook materialisation (SEAS5) — 2026-11-24

**Phase 5.7's seasonal half is delivered.** Two owner decisions closed the blockers the
contract recorded, and both were implemented in the same pass: the lead-month anchor (with
the band restated) and the run-identity/freshness representation. Nothing is committed or
pushed; the evidence below is from this working tree.

| Item | State |
|---|---|
| `Q-P5-BAND` — anchor and band | **Resolved 2026-11-24.** Lead month 1 is the calendar month **after** the run's initialisation month, so one seven-month SEAS5 window fills six leads. `MONTHLY_OUTLOOK_BANDS` is `1–6` (`seasonal_forecast`) / `7–12` (`climatology`), and `PROJECT.md` §3, `temporal-and-weather-semantics.md` §6, ADR-001 (amendment), `§8.7`/`§8.9` and the register are reconciled to it |
| `Q-P5-RUN` — identity and label | **Resolved and implemented.** Run identity is two nullable FK columns; staleness is `availability: fresh \| stale`, derived at read time from the joined `forecast_runs.initialized_at`. Zero grace stays provisional and is recorded as `SEAS5_PROVIDER_CONSISTENCY_MS` without being added to the boundary |
| `packages/contracts/src/climate.ts` | `MONTHLY_OUTLOOK_BANDS` restated; `outlookAvailabilitySchema`; `climateOutlookMonthSchema` gains `availability`, superRefined so only a seasonal month may carry one; `seasonalRecordSetPayloadSchema` |
| `packages/contracts/src/hash.ts` | `hashSeasonalRecordSet` — preimage is the run/ingestion ids, the cell key, `memberCountByMonth` and every `{ month, memberIndex, valueMm }`; both arrays are canonical sets, so order never reaches the hash and a duplicate member is a conflict, not a collapse |
| `packages/contracts/src/canonical.ts` | `canonicalArrayRules` gains `memberCountByMonth` (ordered by `month`) and `members` (ordered by `month`, `memberIndex`). Without a rule the canonicaliser refuses the array rather than guessing |
| `packages/contracts/src/job.ts` | `seasonalOutlookAggregationJobPayloadSchema`: `model` is the literal `ecmwf_seas5`, `forecastRunId` is required, `firstMonth` and `baselineVersion` are **not** accepted. The discriminator is the field's presence, so the job kind is unchanged and no migration touches `jobs_kind_check` |
| `packages/climate-core/src/seasonal.ts` | **Added.** `seasonalOutlookMonths(initializedAt)` (six months, UTC-only, integer month arithmetic) and `assembleSeasonalOutlook` — 50 members per month, indices exactly `0..49`, non-null non-negative finite totals, one run and one ingestion, the whole six-month window complete or a refusal naming the month and member index. Value is the arithmetic mean of the 50 monthly totals; `spread_unavailable_reason = 'ensemble_spread_not_derived'`; `inputRefs` is one `{ kind: "forecast", role: "seasonal" }` ref carrying the record-set hash |
| `packages/climate-core/src/freshness.ts` | **Added.** `seasonalStaleBoundary` = `(init month + 1)-05T12:00:00.000Z`, `seasonalAvailability(initializedAt, now)`, and the two named constants that make the provisional zero explicit |
| `packages/climate-core/src/{aggregate,outlook-read}.ts` | Band 7–12 for climatology; an absent month is `pending` for every lead, never `not_requested`; `availability` and `initializedAt` flow from the row |
| `packages/database/src/outlook.ts` | **Added** `persistSeasonalOutlook`, `loadSeasonalForecastRun`, `loadSeasonalMemberPopulation`; `loadActiveOutlookMonths` joins the run and returns `initializedAt`. Both writers return `skipped` and enforce class precedence (a normal never retires a forecast). Rank is `(initialized_at, ingestion_runs.created_at)` read after the footprint lock, so completion order confers nothing |
| Migration | `20261124000000_monthly_outlook_run_identity` — two nullable FKs + partial index, additive only. Applied locally; `db:status` clean afterwards |
| `apps/worker/src/aggregate/outlook.ts` | One handler, two plans: `materialiseClimatologyOutlook` and `materialiseSeasonalOutlook`. `SeasonalRunRefusedError` / `SeasonalPopulationIncompleteError` map to terminal failures (`payload_invalid`, `population_incomplete`); a refused or incomplete run writes nothing and the older active answer survives |
| `apps/api/src/climate/climate.service.ts` | Passes `now` so the read path can label availability; nothing else in the route changed |
| Not implemented, not claimed | Ensemble spread, SD/IQR/P10–P90/min–max, probability, terciles, exceedance, confidence, `model_skill`; the physical identity of the omitted 51st member; `not_requested` as a produced token; any live seasonal job — `OPEN-18` and `OPEN-03` keep the registry fixture-only and `OPEN-05` retains no payload |
| Tests | **contracts** 420 (bands, `availability` rules, record-set hash, seasonal payload); **climate-core** 81 (19 seasonal assembler/hash cases, 8 freshness cases, updated aggregate/read-path cases); **database integration** 141 (+7 seasonal persistence cases: stored shape, idempotence, older-run refusal, newer-run replacement, ingestion tie-break, seasonal-over-climatology, climatology-refused-over-seasonal); **worker integration** 102 (+3 seasonal materialisation cases: six months written, incomplete population writes nothing and preserves the older answer, a payload naming another model is refused) and the climatology cases updated to the 7–12 band; **api integration** 86 (band 7–12, `pending`, `availability`); existing suites unchanged otherwise |
| Executed | `pnpm -r typecheck` 11/11, `pnpm -r lint` 7/7, `pnpm -r build` 7/7, `prettier --check .` clean, `prisma migrate deploy` applied, `db:status` clean, schema 23, rls 92, database unit 34, worker unit 2, api unit 206, plus the four integration totals above — all green |
| Test-suite edit disclosure | Test edits were part of the task (Workstream I), which overrides the standing "do not touch tests" rule for this scope: three new files (`seasonal.test.ts`, `freshness.test.ts`, `seasonal-outlook-persistence.test.mjs`, `aggregate-seasonal.test.mjs`) plus band/`pending`/`skipped` expectations updated in the existing climate-core, database, worker and api files. No case was deleted, skipped or weakened |

### Phase 5.7B — climatology read API and the `Q-P5-7` decision — 2026-11-24

**Phase 5.7 is still not complete**, but its climatology half is now readable and its
quantity question is answered. The seasonal half — a writer of `seasonal_forecast`
months — is what remains, plus the field→cell mapping (`OPEN-18`).

| Item | State |
|---|---|
| `Q-P5-7` / `F-09` | **Resolved by the owner 2026-11-24.** `monthly_outlooks.value_mm` is an estimated precipitation **accumulation for one calendar month, in mm**. `seasonal_forecast` → `ensemble_mean` (mean of the 50 members' monthly totals for one initialisation); `climatology` → `climatological_mean` (mean of the baseline years' monthly totals). A climatology month is a historical normal, never a forecast; a seasonal month is an ensemble estimate, never a guarantee. `precipitation_mean` was not renamed and no daily aggregate mean is stored as a month |
| Estimator mapping | **Derived, not stored.** `estimatorForDataClass` in `packages/contracts/src/climate.ts` is the single table; a class absent from it has no approved estimator, so a value claiming one is unrepresentable. No migration, no column: `data_class` determines the estimator and a copy could only drift. A second estimator for one class is the change that would need the column |
| `packages/contracts/src/climate.ts` | **Added.** `monthlyOutlookEstimatorSchema`, `estimatorForDataClass`, `climateOutlookMonthSchema` (stored month + `unit: "mm"` + `estimator` + `derivationVersion`, with the estimator/derivation rules enforced), `climateOutlookQuerySchema` (strict: `fieldId`, `provider`, `model`, optional first-of-month `firstMonth`), `climateOutlookSchema` (12 months, echoed identity, horizon rule). `horizonIssues` is shared with `monthlyOutlookHorizonSchema`, so a stored and a served horizon cannot disagree about a lead index |
| `packages/database/src/outlook.ts` | **Added.** `loadActiveOutlookMonths(tx, { provider, model, cellKey, fromMonth, toMonth })` returns `{ outlookCellId, months }` from `status = 'active'` rows only, `variable = 'precipitation'`, over a month range so `monthly_outlooks_cell_month_idx` does the work. **Read-only**: it never mints a cell. `null` cell id means nothing was ever resolved for that identity |
| `packages/climate-core/src/outlook-read.ts` | **Added.** `assembleOutlookHorizon({ firstMonth, rows })` builds the twelve served months: a stored row passes through unchanged; no row becomes a no-value entry with `not_requested` (leads 1–7) or `pending` (8–12); never zero. Duplicate months, an off-horizon row, a class with no approved estimator, or a row that contradicts `climateOutlookMonthSchema` fail as `inconsistent_row` rather than being dropped |
| `apps/api/src/climate/*` | **Added.** `GET /v1/climate/outlook`, behind `AuthGuard`, in one `withTenant` transaction: `selectFieldAnchor` → registry `specFor`/`evidenceFor` → `createSpatialResolution` → `loadActiveOutlookMonths` → assemble → contract parse. `FIELD_NOT_FOUND` for a missing/foreign/deleted field; `GRID_NOT_FOUND` and `CELL_NOT_FOUND` from the resolver, unchanged. `firstMonth` defaults to the current Asia/Jakarta month and is echoed. Holds no lock and writes nothing |
| Shared error mapping | `apps/api/src/field/cell-errors.ts` → `apps/api/src/http/resolution-errors.ts`. Same code, unchanged behaviour, now used by both resolution routes |
| Database impact | **none.** No migration, table, column, index, grant or policy changed. `app_api` still holds `SELECT` only on `monthly_outlooks` and `outlook_cells` |
| Missing reasons the read path may emit | `not_requested` (leads 1–7: no product materialises them) and `pending` (a climatology-band month with no row). It never emits `ingest_failed`: no failed outlook row survives, since a failed derivation rolls back, so nothing records the cause and claiming one would be fabrication |
| Not implemented, not claimed | Seasonal materialisation, `field_outlook_cells` writes, the production field→cell mapping (`OPEN-18`), the baseline selection rule (`Q-P5-8`), seasonal read months, ensemble spread, probabilities, terciles, confidence, temperature outlooks, anomalies, bias correction, skill, UI, any scheduler fan-out |
| Tests | **contracts** +6 (estimator totality, estimator/class coherence, derivation presence, served horizon axis, strict query); **climate-core** +16 (12-month assembly, band labelling, pass-through, stored absence, missing normal ≠ zero, refusals for duplicate/off-horizon/unapproved-class/contradictory rows); **api integration** +14 (`climate-outlook.test.mjs`: 401, 400s, tenant isolation, soft-delete, `GRID_NOT_FOUND`, 12 ordered months with climatology 8–12, no zero for a gap, active-over-superseded, read writes nothing, unmaterialised cell) |
| Executed | `pnpm -r typecheck` 11/11, `pnpm -r lint` 7/7, `pnpm -r build` 7/7, `prettier --check .` clean, `db:verify` all privilege checks passed; contracts 419, climate-core 47, weather-core 118, database unit 34, api unit 206, worker unit 2, schema 23, rls 92, database integration 134, worker integration 99, api integration 86 — all passed |

### Phase 5.7A — climatology outlook materialisation — 2026-11-24

**Phase 5.7 is not complete.** 5.7 was split: the climatology half has a real source
(`climatology_normals`, built in 5.5), the read API needs both halves, and the seasonal
half has no writer — its contract is §8.7C of `climate-data-foundation.md`. 5.7A delivered
the climatology half; 5.7B later delivered the read route.

| Item | State |
|---|---|
| `packages/climate-core/src/aggregate.ts` | **Implemented (new).** `assembleClimatologyOutlook({ firstMonth, cellKey, baselineVersion, baselineDataset, normals })` returns a `monthlyOutlookHorizonSchema`-validated 12-month horizon plus the derivation that may be persisted. Lead months 1–7 are emitted as explicit no-value entries (`not_requested`), 8–12 as `climatology` + `beyond_horizon` with the same-calendar-month normal. A month-of-year with no normal is `insufficient_history` and is **not** in the derivation. `sampleYears = NULL` is refused (`insufficient_provenance`): the baseline hash preimage would have to invent the count. Duplicate month-of-year normals, non-first-of-month keys, negative/NaN values, an empty cell key and a non-first-of-month `firstMonth` are refused. Pure: no `Date`, no clock, no database |
| `packages/contracts/src/job.ts` | **Added.** `outlookAggregationJobPayloadSchema`: `provider`, `model`, `baselineVersion`, `firstMonth` (first-of-month, carried in the payload so a retry across a month boundary materialises the horizon it was enqueued for), `targetSelectorHash`, `targetSelector`. No new job kind: `aggregate` already exists in `jobs_kind_check` |
| `packages/database/src/outlook.ts` | **Implemented (new).** `loadClimatologyOutlookSource` reads the version's `baseline_dataset` and the cell's normal rows; a version with no metadata row throws `OutlookBaselineNotFoundError` instead of returning an empty set. `findOutlookCellId` resolves and never creates (`OutlookCellNotFoundError`). `persistClimatologyOutlook` validates first (non-empty `inputRefs`, 64-hex hash, first-of-month keys, finite non-negative values, no duplicate month), then per month: `FOR UPDATE` the active row, compare `(derivation_version, input_snapshot_hash, baseline_version, value, class, reason)` → `unchanged`; otherwise insert staged as `failed`, supersede the old row pointing at it, promote the staged row to `active`. Writes serialise on `lockForecastFootprint` keyed `(cellKey, variable)`. Caller owns the transaction; `app_system` only |
| `apps/worker/src/aggregate/outlook.ts` | **Implemented (new).** `kind: "aggregate"`, `opensIngestionRun: false`. Payload schema → selector-digest equality → variable must be `precipitation` → per selector cell: resolve cell, load source, assemble, persist. One transaction: timeouts → job `FOR UPDATE` → lease/`running`/no-run checks → per-cell writes → `settlePairAsWorker`. Terminal codes: `payload_invalid`, `selector_digest_mismatch`, `unsupported_variable`, `outlook_cell_not_found`, `baseline_unknown`; an assembly refusal is an `InvariantViolationError` and rolls back |
| Database impact | **none.** No migration, table, column, index, grant or policy changed. `app_system` already had full DML on `monthly_outlooks`; `app_api` remains `SELECT`-only (asserted) |
| What is stored vs synthesised | Only months with a real normal are rows (lead months 8–12 when 5.7A shipped; the band is 7–12 since 5.7D restated it). Every month without a source and every `insufficient_history` month exists only in the assembled horizon, because `MonthlyOutlook.inputRefs` requires ≥ 1 ref and those months have none — a sentinel ref would be a provenance lie. The read path synthesises them (5.7B) |
| Baseline selection | **not invented.** `baselineVersion` is an explicit payload field; an unknown one is terminal. There is no documented selection rule, so `Q-P5-8` records the gap rather than a `latest` query |
| Not implemented, not claimed | `GET /v1/climate/outlook`, field→cell mapping, `field_outlook_cells` writes, seasonal materialisation, mean→total conversion, spread, probabilities, terciles, confidence, temperature outlooks, bias correction, skill. No scheduler enqueues `aggregate`; Phase 6 owns the fan-out |
| Corrective pass — multi-cell lock ordering (2026-11-24) | The handler looped cells and each `persistClimatologyOutlook` call locked its own footprint, so lock order followed the payload array and two jobs with the same cells in opposite order deadlocked (`40P01`). Fixed: the whole footprint set is locked once, before any cell work, through `lockForecastFootprint` (which sorts and de-duplicates), and `persistClimatologyOutlook(tx, input, { footprintLockHeld: true })` skips the redundant per-cell acquisition. Job row lock still precedes footprints; settlement and supersession unchanged. Probe evidence: a throwaway run of the old per-cell order with the same rendezvous rejected one transaction with `40P01` ("deadlock detected") while the corrected order completed both |
| Corrective pass — selector ceiling | `targetSelectorSchema` has no maximum and the handler does every cell in one transaction. `MAX_OUTLOOK_CELLS_PER_JOB = 256` turns an oversized selector into a terminal `selector_too_large` instead of a transaction timeout retried to `dead`. **This is a conservative operational limit, not a measured throughput guarantee**: there is no load test behind it, only the statement count per cell and the transaction bound. Real fan-out beyond that is Phase 6 work, not a bigger number |
| Corrective pass — worker-level concurrency (2026-11-24) | `apps/worker/test/integration/aggregate-outlook-concurrency.test.mjs` runs two real runners claiming two `aggregate` jobs whose selectors name the same cells in opposite order. Synchronisation is a third-party transaction holding both advisory locks, so it is implementation-agnostic: the corrected handler has both jobs waiting on the same first key and releasing lets them run in turn, while a per-cell handler hands each job its own first key and their second requests deadlock. Verified by rebuilding `dist` with per-cell locking: both cases then fail with `40P01`. Also asserts one active row per cell-month, one derivation per cell, a valid supersession chain, and that a settled job logs no `lease_lost` |
| Corrective pass — lease analysis, corrected | The earlier claim here — "renewals run on their own connection while the transaction is open" — was **wrong**, and a real-PostgreSQL test now pins the truth (`job-lease-row-lock.test.mjs`). `renew()` is an `UPDATE app.jobs` on the same row the handler holds `FOR UPDATE`, so it blocks for the whole transaction; row locks are per row, not per session. Worse, an `UPDATE` projects its target list in the scan node, so both the new term and the guard are evaluated when the statement *starts*: a renewal that waits past expiry still reports success and writes a term that already ended (`start + leaseMs`, never `grant + leaseMs`). The design is nonetheless safe — settlement authority is checked inside the same transaction that holds the row lock, so the reaper cannot reclaim the row until the transaction ends, and a rollback leaves the row reclaimable — but the transaction is bounded by the lease it was handed, not by a renewable one. Correction: `transactionTimeoutMs` 60 s → 30 s (statement 15 s), and the handler refuses to open a transaction it cannot finish inside its lease: `OUTLOOK_LEASE_HEADROOM_MS` = 40 s (30 s bound + 10 s commit margin), and a claim with less than that remaining returns `retryable` / `lease_headroom_insufficient` so the retry gets a fresh 60 s lease. `RUNNER_DEFAULTS` unchanged. Also fixed: a renewal that resolves after `stopHeartbeat` reports "no longer running" because the handler already settled, not because the lease was lost — the runner no longer logs `lease_lost` for it (the rule `background-processing.md` §3 already states) |
| Known risk — lease | The row lock makes lease expiry unobservable *during* a transaction, so a job that exceeds its lease is discovered only after it ends. For this handler that is a retry, never a partial write: the transaction rolls back, the previous active rows survive, and the reaper recovers the abandoned lease. A large selector is therefore limited by `MAX_OUTLOOK_CELLS_PER_JOB`, not by lease arithmetic |
| Known risk | `recordCount` reports months affirmed (including `unchanged`), not rows written; the settle log now names `monthsInserted` / `monthsSuperseded` / `monthsUnchanged` / `monthsAffirmed` beside it. There is no coverage percentage to report in this phase because no forecast axis exists to be partially covered; `data_coverage_percent` stays `NULL` |
| Tests | climate-core **33** (19 new `aggregate` cases: 12-entry horizon, lead order, month mapping and Dec→Jan rollover, lead 8–12 values and baseline, lead 1–7 never filled, per-month baseline gap, empty baseline ⇒ no derivation, unknown `sampleYears` refused, ref/hash shape, canonical hashes, reorder determinism, baseline-version sensitivity, five refusals); database integration **134** (10 `outlook-persistence` cases: 5 rows with real refs, no row for a no-value month, idempotent repeat, supersede on changed snapshot, changed baseline is a new derivation, failed recompute preserves the active row, two racing writers leave one active row per month, unresolvable cell refuses, `app_api` write denied, climatology row without a baseline refused; plus 2 `outlook-lock-order` cases); worker **14** new integration cases: 10 `aggregate` (materialise + settle with no ingestion run, idempotent rerun, multi-cell selector, selector ceiling, lease headroom refusal, no normal ⇒ no rows, unknown baseline, unknown cell, digest mismatch, unsupported variable), 3 `aggregate-outlook-concurrency` (reverse-order pair, conflicting snapshots, no spurious `lease_lost`), 2 `job-lease-row-lock` (renewal blocks on the job row; a blocked renewal cannot extend past `start + leaseMs`) |

### Phase 5 roadmap reconciliation — 2026-11-24

**No new phase is introduced, and no phase is renumbered.** The official sequence remains
5.0–5.8 as `climate-data-foundation.md` §8 defines it; Phase 6 is the next product phase
(`docs/PROJECT.md` §3). Optional architecture reconciliation is supporting work inside the
current phase, not a phase of its own.

| Milestone | Official definition | Verified state (2026-11-24) | Gate |
|---|---|---|---|
| 5.0–5.6 | §8.0–§8.6 | implemented as their rows record; 5.4–5.6 not live pipelines | `OPEN-18`, `OPEN-03` |
| 5.7A | §8.7A | climatology materialisation delivered | none beyond 5.5 |
| 5.7B | §8.7B | climatology read route delivered | none beyond 5.7A |
| 5.7C | §8.7C contract | **documentation, 2026-11-24** — the source-selection and materialisation contract, reconciled to what 5.7D implemented (band 1–6 / 7–12, FK columns, `availability`) | nothing; it is the authorisation boundary for 5.7D |
| 5.7D | §8.7C.9 | **delivered 2026-11-24** — `seasonal_forecast` months 1–6 are materialised from a complete 50-member population, ranked by run identity, and served with `availability` | `OPEN-18`, `OPEN-03`, `OPEN-05` keep it fixture-only; `Q-P5-SPREAD` unchanged and still defers spread |
| 5.8 | §8.8 data quality and operations | **not started** — no `climate-core/audit.ts`, no `apps/worker/src/maintenance/`, no operations runbook | prerequisite 5.7 is incomplete, and its acceptance needs a week of scheduled runs; no scheduler exists |
| Phase 6 | PROJECT.md §3; `docs/research/agronomic-reference-matrix.md` §6 | **pure engine delivered 2026-11-27** — `packages/agronomy` carries constraint evaluation, stage alignment, the `OPEN-26` partition validator, verdict classification and suitability assembly, all fixture-only and covered by 56 committed tests; no crop rows, no window generator, no suitability route, no persistence | `OPEN-20`, `OPEN-21`, `OPEN-27`, `OPEN-18`, agronomist review; see `docs/review/phase-6-readiness.md` |

Seasonal materialisation is **5.7 work**, not 5.8 work: 5.8 audits and operates what 5.7
produces. Declaring Phase 5 complete before that half exists would make the 5.7 acceptance
row false; 5.8 cannot begin in a meaningful way before it.

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
| Not implemented at 5.0 | No adapter, no HTTP client, no queue, no worker runtime, no migration, no Prisma change, no route, no dependency, no persistence. No provider grid is asserted. Later steps added some of these — 5.2 records which |
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
| Open | `Q-P5-7` / `F-09` (`precipitation_mean` vs `valueMm`) — **resolved 2026-11-24**, see §Phase 5.7B; `Q-P5-5`, `Q-P5-6`, `Q-P5-8` unchanged |

---

### Phase 5.2 — spatial resolution foundation — **all eight steps implemented 2026-11-22**

| Item | State |
|---|---|
| Status | **Implemented as specified.** All eight steps are done: literal hash fixtures (5.2.1, `44b278c`), the `(provider, model)` registry with declared evidence (5.2.2, `965f528`), the `SpatialResolution` result contract (5.2.3, `6963709`), the weather-core registry instance (5.2.4), the tenant-scoped field anchor (5.2.5), cell identity persistence (5.2.6), the resolution route (5.2.7), and the status reconciliation (5.2.8, `1dff5fd`). Still absent by design: the `field_outlook_cells` mapping, `distance_km`, served coordinates, any migration, and any provider grid. The design is `climate-data-foundation.md` §5.2.9 and `ADR-007` |
| Implemented — 5.2.1 | four literal `gridSpecHash` fixtures in `grid.test.ts`: 1° global, the same lattice under a second `gridId`, 0.25° global, 0.05° bounded. Editing the preimage, a preimage field, or `canonicalJson`'s treatment of one fails the suite; rewriting the object literal in another order does not, because keys are sorted |
| Implemented — 5.2.2 | `GridKey`, `GridEvidence`, `GridRegistryEntry`; registry keyed by `(provider, model)` through nested maps; `specFor`, `resolve`, `evidenceFor`, `requireValidated`; duplicate pair → `duplicate_grid_spec`, unknown pair → `unknown_model` naming both components, synthetic entry on an ingest path → `grid_not_validated`. No model-only overload; `models()` removed with no replacement. `CONTRACTS_VERSION` and the package version are `0.2.0` |
| Implemented — 5.2.3 | `6963709`. `SpatialResolution` and `GRID_RESOLUTION_ALGORITHM_VERSION = "grid-resolve/1"` (typed as the constant's literal type, not `string`); `createSpatialResolution(entry, request)` re-checks `entry.spec.gridSpecHash` before resolving, so a hand-built entry or an edited lattice fails with `grid_spec_hash_mismatch`; it copies the caller's coordinate into `requested` unchanged, takes `anchor` from the resolver's own node, freezes the result and both nested objects, and never upgrades `evidence` |
| Implemented — 5.2.4 | `packages/weather-core/src/grids/{synthetic,registry}.ts`. Exactly one entry: provider `synthetic`, model `synthetic_1deg_20x20`, `gridId` `synthetic-1deg-20x20`, a bounded 20×20 one-degree lattice, `evidence: "synthetic"`. `syntheticGridRegistry` is `createGridRegistry([…])`, not a second implementation. The exact pair resolves deterministically; an unknown provider, an unknown model, and an unknown pair each fail with `unknown_model` naming both components; there is no model-only lookup and no fallback; `requireValidated` fails with `grid_not_validated`. The entry's `gridSpecHash` is pinned by a literal fixture, so editing the definition fails the suite |
| Implemented — 5.2.5 | `selectFieldAnchor(tx, fieldId)` in `packages/database/src/fields.ts`, returning `FieldAnchor { lat, lon }` as six-decimal **strings**. `ST_Centroid(geom)` inside the statement, `ST_X` → `lon`, `ST_Y` → `lat`, rounded with `round(…::numeric, 6)` so the six decimals are PostgreSQL's, not JavaScript's. Tenant, soft-delete, and existence are the same SQL predicate as `findField`, so another tenant's field, a deleted field, and a missing one all return `null`. Takes the caller's `TenantTransaction`; opens none. **Not** a cell, not a served coordinate, and no `outlook_cells` or `field_outlook_cells` write |
| Implemented — 5.2.6 | `upsertCell(tx, { provider, model, cellKey })` in `packages/database/src/climate.ts`, returning the persisted cell id as a string. `INSERT INTO app.outlook_cells (provider, model, cell_key) … ON CONFLICT (provider, model, cell_key) DO NOTHING RETURNING id::text`, then a three-column `SELECT` when the insert returns no row; if that still finds nothing it throws `OutlookCellIdentityError` rather than inventing an id. No `DO UPDATE`, because `app_api` holds `INSERT (provider, model, cell_key)` and no `UPDATE` — and because a served coordinate is a provider fact this function must not write. `served_lat`, `served_lon`, `elevation_m`, `spatial_resolution_km` and `served_updated_at` stay NULL. Persisting a triple is **not** admission: `synthetic` is rejected by `outlook_cells_provider_check`, and no `GridEvidence` is consulted |
| Implemented — 5.2.8 | status reconciliation recorded in `1dff5fd`: the per-step status in §8.2, the §8.1 capability table, `OPEN-18` and `ADR-007`. No code change. It recorded 5.2.1–5.2.2 at the time; 5.2.3 landed later at `6963709` |
| Implemented — 5.2.7 | `POST /v1/fields/:fieldId/resolve-cell`, `200`. `cellResolutionRequestSchema` accepts `{ provider, model }` and refuses everything else, including a client-supplied coordinate. Inside one `withTenant` transaction: `selectFieldAnchor` → registry lookup for the pair → `createSpatialResolution` → `upsertCell`. `requested` is the field's centroid and `anchor` is the resolver's node; the response is `{ cellId, servedCoordinate: null, resolution }`. `FIELD_NOT_FOUND` for a missing, foreign or deleted field; `GRID_NOT_FOUND` for an unregistered pair; `CELL_NOT_FOUND` for a position outside the grid — the last two mint nothing. `requireValidated` is not called: resolving is not admission. With production wiring the only reachable pair is provider `synthetic`, which `outlook_cells_provider_check` refuses, so that pair answers `500 INTERNAL_ERROR` — visibly not a success and with no cell written; no provider grid exists to resolve instead |
| Evidence is declared, not verified | `GridEvidence` is a registry-entry value. `requireValidated` refuses an entry declared `synthetic`; nothing inspects the grade A + B documents behind `validated`. Admission to `validated` is an explicit review decision, and no provider has been admitted |
| Registry identity | `(provider, model)`, not `model` alone (§5.2.9.1) — **implemented**. One model string may exist under two providers; one `gridId` may label several pairs |
| `gridId` | a label on one definition, not unique and never a lookup key. `gridSpecHash` keeps `gridId` in its preimage because the hash pins a named definition |
| Result | `SpatialResolution` — `provider`, `model`, `gridId`, `gridSpecHash`, `resolutionAlgorithmVersion`, `evidence`, `requested` ≠ `anchor`, `i`, `j`, `cellKey`. **Implemented** in `grid.ts` (§5.2.9.2). No served coordinate, no `distanceKm`, no `extractionPolicy` |
| Longitude | four separate concepts — normalization, domain validation, wrapping, indexing — with a boundary table for `-180`, `180`, `0`, `360`, `-0.5`, `359.5`, and five questions left to the owner: three longitude, the `lonRange` bound, and the `spatialResolutionKm` hash preimage (§5.2.9.3, `OPEN-18`) |
| `field_outlook_cells` | **not written in 5.2.** `distance_km` is `NOT NULL` and is a distance to a served coordinate that does not exist yet; `0` is never a placeholder (§5.2.8) |
| Provider grids | all five still pending. Evidence is graded A (documented), B (measured), C (inferred), with a protocol; grade C never configures a row. `ecmwf_ifs025` was measured on 2026-11-24 and remains unconfigurable for a structural reason, not a missing one (§Phase 5.2 evidence). The only registered entry is synthetic; no provider grid is configured and nothing is `validated` |
| Registry binding | `FieldModule.register(gridRegistry)`; production passes `syntheticGridRegistry`, and the only other instance is a test fixture bound in the API integration suite — no mutable global, no second production registry |
| Next | `climate-data-foundation.md` §8.7: the seasonal half of 5.7, and the field→cell join (`OPEN-18`). 5.7A and 5.7B are implemented and gated, not live; 5.4, 5.5 and 5.6 likewise. Ensemble spread has an investigation (`docs/review/seasonal-spread-investigation.md`) and no implementation |


---

### Phase 5.2 — `OPEN-18` provider evidence review, Open-Meteo IFS 0.25° — 2026-11-24

**Investigation only. Nothing is configured, and no code, contract, migration or golden
vector changed.** The report is `docs/review/open-18-open-meteo-ifs025-evidence.md`.

| Item | State |
|---|---|
| Question | does `ecmwf_ifs025` have enough evidence for a production `GridSpec`, and can the resolver represent it without approximation? The second half answers **no** |
| Grade A — documented | **Partial.** The ECMWF API page states the open-data IFS 0.25° product is global at `0.25°` (~25 km) and updates every 6 h; the Weather API page states the returned `latitude`/`longitude` are "WGS84 of the center of the weather grid-cell which was used", and that `cell_selection` (`land` default, `sea`, `nearest`) chooses the cell. Not documented: origin/reference convention, axis order, regular-vs-reduced construction, the native longitude convention, and the identifier `ecmwf_ifs025` itself |
| Grade B — measured | **Complete for geometry.** 164 request→served pairs, from 172 requests, at `api.open-meteo.com/v1/forecast` with `cell_selection=nearest`. The endpoint **snaps** (identical served coordinate and identical value across a whole cell), the lattice is global regular `0.25°` at multiples of `0.25` including `0` and `±90`, and selection is the **nearest node** with ties toward `+∞` |
| Decisive finding | `GridSpec` makes the node the **south-west corner** of its cell (`[node, node + step)`, `climate-data-foundation.md` §5.2.2 rule 3), so `resolveGridCell` floors; the provider returns the nearest centre. Over 41 coordinates the resolver matched **14**, the nearest rule **41**. Registering the node lattice would key roughly two requests in three to a cell the provider did not serve |
| Why no workaround | Aligning the partitions needs an anchor lattice offset by half a step, whose `latRange` starts at `-90.125`; `grid.ts:279-281` requires `latRange` inside `[-90, 90]`, and every bound must be a lattice point. **No legal `GridSpec` reproduces the provider's cells** |
| Two further measured facts | `cell_selection` changed the served cell at 7 of 8 probed locations (Jakarta bay: `land` → `-6.25,106.75` 18.0 mm, `nearest` → `-6.00,106.75` 1.3 mm), so identity depends on a request flag; and response `elevation` is a DEM value at the *requested* point (six values inside one served cell), so it is never a cell property. Precipitation is unaffected by an `elevation` override, so the value is the native cell's |
| Antimeridian | Requesting `180` serves `179.75`; requesting `-180` serves `-180` — adjacent cells, different values, contradicting §5.2.9.3's folding rule. Recorded unresolved; it is question 2 of `OPEN-18` |
| Decision | **No production `GridSpec`, no `gridSpecHash`, no registry entry, no `validated` state, no resolver change, no migration.** `OPEN-18` stays `BLOCKED_EXTERNAL_INPUT`, and part of the blocker is now internal (question 6: cell-selection semantics) |
| Methods unchanged | `requireValidated`, `GridEvidence`, the eighteen synthetic vectors, the five literal hash fixtures, and the `synthetic` registry entry are untouched |
| Next | an owner decision on cell-selection semantics (nearest-centre mode with a `GRID_RESOLUTION_ALGORITHM_VERSION` bump, or a `cellKey` that names the node centre), plus a documentation source naming `ecmwf_ifs025`. Until then the climatology read path's `provider`/`model` parameters have no production value |

---

### Phase 5.9 — 0–45 day read model — 2026-11-27

**Read path only. No migration, no table, no column, no index, no grant, no policy, and no new package dependency.** The rows were already written by 5.4 (daily) and 5.6 (EC46); this phase serves them.

| Item | State |
|---|---|
| Design decision | **Direct read of live `app.weather_records`, never a materialised daily outlook.** A day is a stored value, not an aggregation. The row already carries the run identity, the data class, the model, the resolution and the live/superseded marker, so a second table would copy provenance and add a second supersession path without adding a fact. `monthly_outlooks` stays materialised because a calendar month *is* an aggregation (`Q-P5-6` unchanged) |
| `packages/contracts/src/climate.ts` | **Added (append-only).** `DAILY_BAND` 0–14, `SUBSESONAL_BAND` 15–45, `DAILY_HORIZON_LAST_LEAD_DAY`, `dailyBandOf`, `permittedDailyDataClasses`, `addCalendarDays`, `calendarDaysBetween`; `dailyForecastDaySchema`, `dailyForecastSegmentSchema`, `climateDailyOutlookSchema`, `climateDailyOutlookQuerySchema`. The monthly schemas are untouched: `climateOutlookSchema`, `MONTHLY_OUTLOOK_BANDS`, `LEAD_MONTHS` and `outlookEvaluationBasisSchema` are unchanged, so the shipped 12-month response is byte-identical |
| Contract rules enforced | Day 0 is today in Asia/Jakarta. Two segments, in order, dense: 15 daily days and 31 subseasonal days, each `leadDay` fixed by its index and each `date` derived from `firstDate` by calendar arithmetic. Band class is a constant (`weather_forecast` / `subseasonal_forecast`), never inferred from the row. `valueMm`, `dataClass`, `model`, `initializedAt` and `availability` are present or absent together — a number without provenance and a label on an absence are both refused. A day with no value must state `missingReason`; a no-value reason may not accompany a value |
| `packages/climate-core/src/freshness.ts` | **Extended.** `weatherForecastStaleAfterHours(leadDay)` returns the horizon map's TTL — 6 h for 0–3, 12 h for 4–14, 48 h for 15–45 — and `dailyAvailability(initializedAt, now, leadDay)` compares at read time. Pure, clock passed in |
| `packages/climate-core/src/daily-read.ts` | **Implemented (new).** `assembleDailyHorizon({ firstDate, provider, model, rows, now })` returns two dense segments or an `invalid_input` / `inconsistent_row` failure. `jakartaDateOfInstant` maps a UTC instant to its Jakarta day; `dailyHorizonWindow(firstDate)` returns the `[from, to)` instant window shared with the SQL query. A row is refused, never dropped, when it is an ensemble member, a non-`mm` unit, not `daily`/`daily_sum`, or carries a class its band does not permit. Rows outside the horizon are ignored. Duplicate dates keep the newest `initializedAt`. A null stored value becomes the no-row shape (`pending`, no class), because nothing stores why the provider published null |
| `packages/database/src/weather.ts` | **Added.** `loadActiveDailyRecords(tx, { provider, model, cellKey, from, to })` joins `app.outlook_cells`, filters `variable = 'precipitation'`, `superseded_at IS NULL`, `ensemble_member IS NULL`, and a half-open `valid_at` window; ordered by `valid_at`. The cell is addressed by `(provider, model, cell_key)`, so a key shared by two grids cannot merge |
| `apps/api/src/climate` | **Added route.** `GET /v1/climate/forecast?fieldId&provider&model[&firstDate]` → `{ data: { fieldId, provider, model, firstDate, unit, segments } }`. Same `AuthGuard`, same field → cell step, same `FIELD_NOT_FOUND` / `GRID_NOT_FOUND` / `CELL_NOT_FOUND` semantics. `jakartaDateOf(now)` adds lead day 0. The monthly route and service method are unchanged |
| What is not served | Ensemble spread (`Q-P5-SPREAD`), daily anomalies (no accepted daily baseline; `Q-P5-6`), probability and terciles, temperature (still unmapped by `OPEN-14`). A served day is one deterministic value in millimetres |
| Still gated | Real provider rows. `OPEN-03`, `OPEN-05` and `OPEN-18` keep every real ingest dead before a fetch, so the coverage this phase demonstrates is fixture-based |
| Tests | contracts **431** (11 new: calendar arithmetic, band boundaries, dense/ordered segments, band-class mismatch, provenance pairing, missing reasons, strict query); climate-core **95** (14 new: Jakarta day mapping, query window, empty horizon, TTL per band, stored value and zero, null value, out-of-horizon rows, duplicate runs, five refusals); api unit **206**; api integration **92** (6 new: 401, 400 for malformed `firstDate` and a client cell key, foreign/missing field 404, dense two-segment happy path, stale past TTL, superseded and ensemble rows ignored). database unit **34**, database integration **141**, worker unit **2**, worker integration **102** all unchanged and green |
| Executed | `pnpm typecheck` 11/11, `pnpm lint` 7/7, `pnpm --filter @agroclimate/{contracts,climate-core,api} test`, `pnpm --filter @agroclimate/database test{,s}`, `pnpm --filter @agroclimate/worker test{,s}`, `pnpm --filter @agroclimate/api test:integration` |

---

### Phase 6.1 — Crop catalog reads and engine row contracts — 2026-11-27

**Read-only catalog plus contracts. No seed, no engine, no suitability or window writer.**

| Item | State |
|---|---|
| Design decision | **The catalog is global reference data and is read through the caller's tenant transaction anyway.** No catalog table carries `user_id` or an RLS policy, so the tenant scope adds no predicate — but a second connection, or a role other than `app_api`, would be a second trust rule to keep in step. The read functions take `TenantTransaction` and filter nothing; claiming a tenant predicate that does not exist would be worse than admitting there is none |
| `packages/contracts/src/crop.ts` | **Added.** `cropSchema`, `cultivarSchema`, `cropProfileVersionSummarySchema`, `cropProfileVersionSchema`, `growthStageSchema`, `constraintSchema`, `sourceRefSchema`, `cultivarWithProfilesSchema`, `cropDetailSchema`, `cropListSchema`, plus the enum vocabularies the SQL `CHECK`s already close (`constraintDimensionSchema`, `constraintComparatorSchema` **without** `window` — `OPEN-07` keeps it unsupported —, `evidenceGradeSchema`, `constraintSeveritySchema`, `profileStatusSchema`, `cycleStartSchema`, `cropSlugSchema`). Comparator/threshold pairing, `startDayOffset <= endDayOffset`, duration ordering, altitude ordering, and draft ↔ `publishedAt` are restated as refinements because a stored row that contradicts them cannot be evaluated |
| `packages/contracts/src/agronomy.ts` | **Added.** `suitabilityRunSchema`, `plantingWindowSchema`, `suitabilityRunWithWindowsSchema`, `dimensionCoverageEntrySchema`, `suitabilityVerdictSchema`, `runStatusSchema`, `engineVersionSchema`, `derivationVersionSchema`. **Row contracts, not evaluation contracts**: they restate the migration's checks (superseded exactly when a successor is named, no score with `insufficient_data`, `suitable` never on a climatology critical stage, `mixedEvidence` derived from the segment classes, unreproducible always with a reason) and leave `risks`, `explanations`, `constraintsEvaluated`, `missingInputs` as open documents because the engine that gives them meaning is Phase 6.5. `OPEN-26` remains open: the partition of `evidenceSegments ∪ missingRanges` is **not** validated here, and the header says so |
| Immutability migration | `20261127120000_crop_profile_immutability`. `crop_profile_versions_immutable` freezes a published row's content and allows only `published → retired`; a retired profile cannot be republished, because artifacts already name it. `growth_stages`, `constraints` and `source_refs` share one trigger function that refuses INSERT, UPDATE and DELETE once the parent is published or retired — appending a threshold to a frozen profile is the same violation as editing one. The published-at column, not the status, is the test, so retirement is a status change on a frozen row |
| `packages/database/src/crops.ts` | **Added.** `listCrops`, `findCropBySlug`, `listCultivars`, `listProfileVersionsForCrop` (newest first by `created_at`, then `rule_version`), `findProfileVersion` (version + stages + constraints + citations). Every instant is rendered by `to_char` in UTC so the response is a `Z`-suffixed ISO instant rather than a locale-dependent string; the format literal is inlined, because a bound parameter kept its own quotes and produced `'…Z'` |
| `apps/api/src/crop` | **Added.** `GET /v1/crops`, `GET /v1/crops/:slug`, `GET /v1/crop-profiles/:profileVersionId` behind the same `AuthGuard`. `CROP_NOT_FOUND` and `PROFILE_NOT_FOUND` are distinct nouns. No mutating route exists: `app_api` holds `SELECT` only, so a write route could not be implemented against the runtime role even if it were wanted |
| What is deliberately absent | The v1 seed (`OPEN-20`), field vocabulary mapping (`OPEN-21`), any evaluation, any score, any window, any `OPEN-26` validator, and any write to `suitability_runs`/`planting_windows` |
| Tests | contracts **431** unchanged (no new contract cases: the schemas restate SQL, and their refinements are covered by the catalog integration suite's real rows); database integration **145** (4 new: draft edits allowed, published content frozen, retired is terminal, the rulebook's own rows refuse insert/update/delete); api integration **99** (7 new: 401, list identical across tenants, cultivars with version ordering and supersession, full rulebook, distinct 404s, malformed slug and uuid, no POST route). api unit **206**, database unit **34**, worker unit/integration **2**/**102** unchanged and green |
| Executed | `pnpm typecheck` 11/11, `pnpm lint` 7/7, `pnpm build` 7/7, `pnpm db:migrate`, `pnpm --filter @agroclimate/{contracts,database,api} test`, `pnpm --filter @agroclimate/database test:integration`, `pnpm --filter @agroclimate/api test:integration` |

---

### Frontend foundation — Roadmap Priority 4 — 2026-11-27

**First product surface. No API change, no contract change, no new runtime dependency.**

| Item | State |
|---|---|
| Intent | For a field advisor checking a field's climate horizon between other work: calm, precise, earthy. One accent (leaf green), one warn (dry amber), warm neutrals, one radius scale. No gradients, no glows, no icon circles |
| `apps/web/src/api.ts` | **Added.** One base URL (`VITE_API_BASE_URL`, default `http://localhost:3000/v1`), one `ApiError` carrying status, code, validation details and request id, one CSRF cache. `credentials: "include"` everywhere; a `403` on a mutation refreshes the token and retries exactly once; `GET`s never carry a token, so a `403` there is not retried |
| `apps/web/src/router.tsx` | **Added.** Hash routing in ~40 lines. Four screens and one detail segment do not justify a router dependency, and a hash path needs no server rewrite next to a static bundle |
| `apps/web/src/useAsync.ts` | **Added.** Loader keyed by a string the page derives from its inputs, with `reload`. The key is the dependency, not the closure identity |
| `apps/web/src/pages` | **Added.** `AuthPage` (register then login, because registration issues no session), `DashboardPage`, `FarmsPage`, `CropCatalogPage`, `ClimatePage` |
| Climate view | Both horizons. Monthly shows each month's class, availability, baseline and missing reason; daily shows two segments with per-day class, model, freshness and TTL. The grid pair is typed by the caller, prefilled with the synthetic grid because that is the only entry production binds; `GRID_NOT_FOUND` is rendered in words rather than hidden. A day with no row prints an em dash and its reason, never `0` |
| Catalog view | Grades and severities travel with every threshold. The screen says in place that the catalog is a rulebook, not a recommendation, and that no engine has evaluated it |
| What is deliberately absent at that commit | Editing and deleting farms and fields (create-only), map drawing (the square helper was data entry, not a parcel), any suitability screen (no engine), any improvement over the API's honesty about `OPEN-18` |
| Verification | `pnpm typecheck` 11/11, `pnpm lint` 7/7, `pnpm build` 7/7 (web bundle 252 kB / 77 kB gzip), `pnpm format:check`. **Not verified in a browser**: no headless run was made against a live API, so the rendered states are reviewed by reading, not observed |
| Tests | None. The web package has no test runner, and adding one is a decision this slice did not take |
| Post-review corrections | An adversarial pass (QA, security, failure-path, coverage) found four defects, all fixed here. Logout cleared the session in `finally`, so a failed revocation showed a logged-out screen while the server-side row and the cookie survived — the one outcome the auth contract forbids; only success logs out now, and a failure renders its error inside the shell. A `401` mid-session left the user in a shell that still believed it was signed in; `onSessionLost` in `api.ts` moves the app to the anonymous state, with `/auth/*` excluded because a wrong password is also a `401`. The request id was dropped from the error fallback, exactly the proxy-page case an operator needs it for. `sourceRefSchema.url` was `z.url()`, which accepts `javascript:` and `data:`, and the catalog renders it as an `href`; it is now restricted to `http(s)`. A fifth finding — the client fetching only the first 100 farms and fields — is fixed by following `meta.total` instead of rendering a truncated page as a total |
| Farms and fields, second pass | `api.ts` gained `updateFarm`, `deleteFarm`, `updateField` and `deleteField`. The create form doubles as the edit form: PATCH takes a name and region, so a farm's geometry never appears there, and the field form hides the centre-and-span inputs while renaming because that call sends only a name. A farm card is a container now, not a button — a delete control nested inside a selecting button is invalid HTML and unreachable by keyboard |
| `CONFLICT` wording | One error code covers "email already registered" and "farm still has live fields". The generic message replaced a message that was wrong on the farm screen; registration now names its own case at the call site, which is the only place that knows which of the two happened |
| Test parallelism | The suites are deliberately serial now: the twelve-CPU default is what puts WSL under memory pressure, since every integration file starts its own app and pool. `turbo run test --concurrency=1`, `node --test --test-concurrency=1` in api, worker and database, and vitest `--pool=forks --no-file-parallelism --maxWorkers=1` in contracts, climate-core and weather-core. Measured peak RSS with the cap: api integration **395 MB / 11 s**, database integration **391 MB / 18 s**, contracts suite **122 MB / 4 s** |

---

### Constraint evaluation and stage alignment — readiness 6.2–6.3, roadmap §10.4–§10.5 — 2026-11-27

**New workspace package `packages/agronomy`. Pure functions only: no database, no clock, no route, no seed.**

| Item | State |
|---|---|
| `packages/agronomy/src/constraint.ts` | **Added.** `evaluateConstraint(constraint, observed)` returns `satisfied` / `violated` / `insufficient_data` plus the threshold it compared against, so an explanation can quote the rule without re-reading the row. `summariseDimensions` returns one entry per dimension in a fixed order: `not_applicable` when the rulebook does not judge it, `unknown` when it judges and nothing was observed, `known` otherwise, with `hardGateFailed`, `hardGateUnknown` and a soft-failure count kept apart — collapsing them is how an unmeasured field starts looking unconstrained |
| Evidence rules enforced | A grade C `hard` constraint and any grade D constraint raise `ConstraintRuleError`. Downgrading C to soft would turn a data defect into a recommendation; excluding D silently would hide the row. `null` observed is `insufficient_data`, never `0` and never a pass |
| `packages/agronomy/src/stages.ts` | **Added.** `daysBetween` / `addDays` are UTC calendar arithmetic with a round-trip check, so `2026-02-30` and `27-11-2026` are refused rather than normalised. `stageAtOffset` is inclusive and returns `null` in a gap between stages — the previous stage does not continue. `criticalStageWindows` clips a window to a cycle of `n` days (last offset `n - 1`) and drops one that starts after it, which is what makes the two cycle-length extremes evaluable |
| `count` comparator | A floor. Every count in the reference matrix is a minimum ("≥4 wet months") and the DDL cannot express a ceiling count, so inventing one would be a shape the database cannot store |
| What is deliberately absent | Any window, score, verdict, persistence, route, seed, `OPEN-26` validator, or `OPEN-27` fan-out. `DIMENSIONS` is the contract's five, not a new list |
| `packages/agronomy/src/partition.ts` | **Added 2026-11-27, resolving the code half of `OPEN-26`.** `validatePartition({ windowStart, windowEnd, segments, missingRanges })` returns `PartitionViolation[]` — one entry per failed check, never a boolean, because the violations are the useful part and a boolean invites `console.warn` where the write should be refused. Codes: `invalid_range`, `overlap`, `gap`, `span`, `no_evidence_segment`, `missing_reason`, `coverage_mismatch` |
| Corrections from the adversarial pass | Four defects, found by review and fixed in place. The overlap and gap checks compared each interval only with its immediate predecessor, so an interval contained by a **non-adjacent** earlier one was never flagged and a gap was measured from the wrong day, naming days that were already covered; both now read a running `maxEnd`. The coverage reconciliation was one-sided and therefore vacuous — `accounted` could never exceed the window once the intervals tiled it — while the reachable defect, a segment whose uncovered days are declared nowhere, passed; it is now `|accounted − windowDays| ≤ 0.5 % of the window`, and a short window no longer gets five times the tolerance of a long one. A span diagnostic said "no segments and no missing ranges" when the input had segments that were all refused; it now says how many were dropped. `localeCompare` was replaced by plain string comparison, because the module promises no locale and ICU collation is a runtime dependency the reproducibility claim cannot take. |
| Verification | `pnpm typecheck` 12/12, `pnpm lint` 7/7, `pnpm build` 8/8, `pnpm format:check`; existing suites unchanged and green (contracts 431, climate-core 95, api unit 206, api integration 99, database unit 34, database integration 145, worker unit 2, worker integration 102). Logic exercised by a throwaway assert script covering all four comparators and their inclusive bounds, the three evidence refusals, coverage states, leap-year and month-rollover arithmetic, stage gaps, cycle clipping and input-order determinism — **not committed**, because the repository forbids test files unless explicitly commanded. The partition validator was exercised the same way: twelve assert groups over a valid partition, adjacency versus a shared day, a one-day gap, both span ends, a zero-coverage segment, a reasonless range, impossible and reversed dates, legal partial coverage, order independence, and a case with five defects at once |

### Verdict classification — roadmap §10.4 — 2026-11-27

**`packages/agronomy/src/verdict.ts`. Pure. No clock, no I/O, no score, no persistence.**

| Item | State |
|---|---|
| `classifyVerdict` | **Added.** Returns one of the four values the `planting_windows` CHECK accepts, plus a `VerdictReason` per cap. Precedence is fixed because the order *is* the policy: failed hard gate → `unsuitable`; unmeasured hard gate → `insufficient_data`; climatology over the critical stage, a soft failure, or a judged-but-unobserved dimension → `conditional`; otherwise `suitable` |
| Why an unevaluated hard-gated dimension is `insufficient_data` | The profile says the dimension gates, so "no constraint was evaluated" is a missing gate, not an open one. Reporting `conditional` there would let a profile that forgot to author a rule read as a soft caveat |
| Why climatology caps rather than fails | `plantingWindowSchema` refuses `suitable` on `primaryBasis = climatology`, so the engine refuses it before the row can fail its own `CHECK`; the window is still usable as advice |
| `not_applicable` | Never caps. It is the rulebook stating it does not judge the dimension, which is not the same as missing evidence |
| Still absent | Any score, any persisted verdict, any window, any route. `hardGateDimensions` is an argument, not a table read: which dimensions a profile gates is catalogue data, and the catalogue has no seed (`OPEN-20`) |
| Verification | `pnpm typecheck` 12/12, `pnpm lint` 8/8, `pnpm build` 8/8, `pnpm format:check`; existing suites unchanged and green. Exercised by a throwaway assert script (ten groups: each precedence step, a hard failure outranking an unknown, climatology capping a clean window, `not_applicable` not capping, and order independence) — **not committed**, per the repository's rule against test files without an explicit command |

### Suitability assembly — roadmap §10.4 — 2026-11-27

**`packages/agronomy/src/suitability.ts`. Pure. No clock, no I/O, no score, no persistence.**

| Item | State |
|---|---|
| `assessSuitability` | **Added.** Takes one profile version's `constraints`, an observation per `constraint.id`, and the critical-stage `primaryBasis`. Evaluates every rule, summarises the five dimensions, derives the hard-gated dimensions from the rules that declare `severity = hard`, and hands the result to `classifyVerdict`. Returns the verdict, its `VerdictReason`s, `dimensionCoverage` in fixed dimension order, `maxAchievableLevel`, and every evaluation |
| Why observations are an argument, not a lookup | `constraints` carries a dimension, a comparator, a bound and a unit — but no metric name. "water means total mm over the critical stage" is an agronomic mapping that needs a citation, so it belongs to the seed `OPEN-20` gates. An engine that inferred it from `unit: "mm"` would be inventing a rule with no source |
| Missing versus unmapped | A missing key and an explicit `null` both mean "not measured", because in both cases nobody knows. An observation id that matches no constraint in the profile throws: dropping it would hide a mapping nothing checks. A duplicated constraint id throws for the same reason — a silent `Map` collapse would double or halve a soft-failure count |
| `maxAchievableLevel` | The weakest evidence grade in a **fully observed** dimension; `null` when no dimension is `known`. Dimension granularity, matching `tables-derived.md` §1: a half-measured dimension contributes nothing, because its grade would describe evidence the run does not have. It says how strong the evidence behind a decision is, not how good the decision is |
| Non-finite observations and bounds | Refused where the comparison happens, in `constraint.ts`: `NaN` compares false against every bound (a fabricated exclusion) and `±Infinity` satisfies a one-sided bound (a fabricated pass), so a non-finite observation is recorded as `observed: null` with outcome `insufficient_data`, and a non-finite threshold raises `malformed_threshold` instead of gating on nothing. Both sides found by the failure-path audit on this change and fixed in the engine rather than at the caller, so every future caller inherits them |
| Error taxonomy | The three caller defects — empty rulebook, duplicated constraint id, observation id outside the profile — raise `SuitabilityInputError extends RangeError` with `code: "empty_rulebook" \| "duplicate_constraint_id" \| "unknown_observation_id"`, mirroring `ConstraintRuleError`'s `constraintId` + `reason`. A service can branch on the code instead of parsing a message; none of these is a data condition, so none is downgraded to a return value |
| Grade drift | `rank()` throws on a grade absent from `GRADE_ORDER` instead of letting `indexOf` return `-1`, which reads as "stronger than A" and would publish a new, weakest grade as the strongest |
| Deliberately absent | Any score, any window generation, any persistence, any route, any seed. `assessSuitability` is the last pure step that exists; a window still needs `OPEN-20` profiles and `OPEN-27` field discovery |
| Refusals | An empty rulebook throws. With no constraints nothing gates and nothing judges, so every branch passes and the run would persist `suitable` — the same false pass `audit.ts` refuses for an empty expectation. A profile version cannot be published empty (`OPEN-20`), so this is a caller defect. An observation id that matches no constraint, and a duplicated constraint id, throw for the reason the table above gives |
| Verification | `packages/agronomy/src/suitability.test.ts`, eighteen cases: a clean grade-A pass, a violated hard gate outranking a soft pass, an unobserved hard gate with its reason code, a soft failure with the weakest-grade cap, climatology capping a clean window, a judged dimension with nothing observed, a `risk` rule neither gating nor capping when violated, an unobserved `risk` rule staying a caveat rather than a missing gate, coverage ordered by the contract's dimensions rather than the rulebook's, the level reading fully observed dimensions only, a partly observed dimension yielding `null`, a violated rule's grade still counting, a missing key equalling an explicit `null`, an unmapped observation id, a duplicated constraint id, an empty rulebook, an unranked grade failing loudly, and a grade C hard gate still throwing. `constraint.test.ts` gained the non-finite observation and non-finite threshold cases. Package suite **56 passed** (was 36 before this change). `pnpm typecheck` 12/12, `pnpm lint` 8/8, `pnpm build` 8/8, `pnpm format:check` clean |
| Mutation check | Eight mutations applied and reverted: coverage reversed → 3 failures; level pinned to `"A"` → 4; `insufficient_data` grades counted → 3; level counting partly observed dimensions → caught; `rank()` guard removed → caught; observation `Number.isFinite` guard removed → caught; threshold `Number.isFinite` guard removed → caught; `severity !== "soft"` for the gate set → **0, and it cannot fail.** The last is an equivalent mutant: `classifyVerdict` reads `hardGateFailed` / `hardGateUnknown` from the summary, which computes them from the rule's own severity, and a dimension enters the widened set only by having a rule, so the `not_applicable` branch stays unreachable. No test should be written to "catch" it |

### Data-quality audit package — Phase 5.8, part 1 — 2026-11-27

**`packages/climate-core/src/audit.ts`. Pure. Nothing queries, nothing rewrites.**

| Item | State |
|---|---|
| `auditRunRefs` | **Added.** One finding per claimed run id that does not exist, naming the artifact and the id. An orphan is reported, never repaired: rewriting the reference would hide which artifact carried it |
| `reconcileCoverage` | **Added.** Expected against stored, keyed `(cellKey, variable, validAt)`. Emits `missing_record`, `duplicate_record`, `unexpected_record` and reports `expected`/`present`/`unexpected` counts beside them |
| Why `expected` is an argument | A daily cell owes one record per variable per day; a seasonal cell owes one per member per month. That is the provider contract the caller asked for, so deciding it here would be inventing a specification. Finding the missing day is arithmetic; deciding that the day was owed is not |
| `auditClimate` | **Added.** Both checks, plus `reconciles`, derived from the findings beside it rather than stored, so the boolean cannot disagree with its own report |
| Deliberately absent | Abnormal-value detection (no document states per-variable physical bounds, and inventing one flags real weather), alerting thresholds, a read route, a stored report, a scheduled sweep, a runbook. The 5.8 acceptance criterion — one week of scheduled runs reconciling with `ingestion_runs` — cannot be met until the provider gates open |
| Tests | `packages/climate-core/src/audit.test.ts`, twelve cases: an existing reference finds nothing, an orphan names its artifact, the two run kinds report separately, one orphan in two artifacts reports twice, a clean reconciliation, a missing day, a duplicate counted once, an extra record, the composite key, the derived verdict in both directions, and that the input rows are unchanged afterwards. Suite: **107 passed** (was 95) |
| Verification | `pnpm typecheck` 12/12, `pnpm lint` 8/8, `pnpm build` 8/8, `pnpm format:check` |

### Adversarial pass over the pure engine and the audit package — 2026-11-27

Four specialists reviewed commits `738f001`, `62673af`, `6fd6be3`, `c954d7b` and `b7da556`. Security found nothing exploitable; the other three found defects, fixed here in place.

| Finding | Severity | State |
|---|---|---|
| `validatePartition` compared each interval only with its predecessor, so an interval contained by a non-adjacent earlier one was not reported, and a gap was measured from `previous.endDate` instead of the farthest covered day — naming days that were already covered | medium | **Fixed.** A running `maxEnd` now drives both checks. The reported "returns `[]`" repro did not reproduce: a contained interval always has a predecessor that is also contained, so at least one overlap was flagged. The write was always refused; the diagnostic was wrong and the second defect invisible |
| `coverage_mismatch` was one-sided and therefore vacuous — with the intervals tiling the window and `coveragePercent ≤ 100`, `accounted` could never exceed it. The reachable defect, a segment whose uncovered days are declared nowhere, passed | high | **Fixed.** Two-sided: `|accounted − windowDays| ≤ 0.5 % of the window`. The earlier comment claiming the contract formula contradicts its own partial-coverage rule was wrong — the weight is exactly what makes the two consistent — and is deleted |
| Coverage tolerance was a fixed 0.5 **days**, which is 5 % of a ten-day window and 1.7 % of a thirty-day one | medium | **Fixed.** Tolerance is now a percentage of the window |
| Every interval refused for bad dates left the walk, so `span` reported "no segments and no missing ranges" about input that had segments | medium | **Fixed.** The detail names the dropped count; the deferred cross-defect is stated in the module header rather than silently skipped |
| `classifyVerdict` skipped a hard-gated dimension with no summary row, which could produce `suitable` from a caller-built input that dropped a gate | medium | **Fixed.** `hard_gate_unknown` with its own detail; `not_applicable` and an absent summary are now handled the same way, because both mean the gate was never evaluated |
| `reconcileCoverage` called an empty specification a clean audit, and silently deduplicated repeated expectations | medium | **Fixed.** `empty_expectation` and `duplicate_expectation` findings. The empty case is the false pass an operator would read as "all good" |
| `localeCompare` in `stages.ts` and `partition.ts` contradicted the modules' own "no locale" promise | low | **Fixed.** Plain string comparison; ISO dates and uuids need nothing else |
| Client list reads looped until `meta.total` with no bound | low (defence in depth) | **Fixed.** `MAX_PAGES = 50` and a thrown error rather than a silently truncated list |
| **Open gap:** nothing checks that every dimension a profile hard-gates actually carries a hard constraint, so a mis-authored profile could read as satisfied | medium | **Not fixed, recorded.** It is a publish-time profile check, not an engine rule; `classifyVerdict` sees evaluations, not the rulebook |
| **Open gap:** `packages/agronomy` had no committed test file | high | **Fixed.** Four files, 36 cases, added under explicit instruction. Each was checked against the defect it exists to catch by mutating the source and confirming the test fails: `maxEnd` → previous-neighbour (contained-interval case), two-sided coverage → one-sided (shortfall case), missing-summary gate → `continue` (verdict case), `observed === null` → a sentinel (a missing observation becoming a pass). All four mutations were caught |

### Tests for the pure engine — 2026-11-27

`packages/agronomy/src/{constraint,stages,partition,verdict}.test.ts`, 36 cases. No framework was added to the package beyond `vitest`, which the other pure packages already use, and the run is capped the same way (`--pool=forks --no-file-parallelism --maxWorkers=1`).

| Area | What the cases pin |
|---|---|
| `constraint.ts` | A missing observation is `insufficient_data` and never a substituted value; a count is a floor; grade C as a hard gate and grade D are refused with distinguishable `reason` values; a malformed threshold is not an evidence violation; `not_applicable` and `unknown` stay distinct |
| `stages.ts` | Month and leap-year rollover, an impossible day refused rather than normalised, inclusive stage bounds, `null` in a gap, tie-breaking independent of input order, a critical window clipped to `durationDays - 1` on 2028, and a stage wholly past the cycle dropped |
| `partition.ts` | Adjacency legal, a shared day an overlap, a contained non-adjacent interval still an overlap, a gap measured from the farthest covered day, coverage reconciled in both directions, coverage not computed over a partition already refused, an empty window distinguished from one whose every interval was refused |
| `verdict.ts` | Unsuitable beats insufficient data, a gated dimension with no summary is a missing gate, a climatological critical stage caps at conditional, `not_applicable` never caps, soft failure and unobserved dimension both read as caveats, and the same input twice gives the same answer |
| Not covered | Anything with a caller: no route, writer or persistence reads these modules yet (`OPEN-26`). Nothing here proves a refused partition would stop a write, only that it is refused |

### Field geometry by drawing — Priority 4's last item — 2026-11-27

`apps/web/src/pages/FarmsPage.tsx`, plus a sketch section in `styles.css`.

| Item | State |
|---|---|
| What replaces the square | An SVG frame anchored on the same centre and span inputs. Click adds a vertex, drag moves one, a button removes the last. Vertices are stored normalised, so changing the centre or the span rescales the shape instead of moving it |
| Why no tiles | A basemap needs a provider key and a projection; neither is decided, and the frame is small enough that equirectangular degrees-per-kilometre is honest at the ±1 % scale this entry needs. Stated in the module comment |
| Topology | Not checked here. `ST_IsValid` owns self-intersection and emptiness; a second copy in JavaScript would disagree with PostGIS at the edges. The contract's cheap half (closure, ring length, two ordinates, bounds) is satisfied by construction and by the parser |
| Keyboard and precision | A typed `bujur, lintang` list per line, inside a collapsed `details`. Non-blank text wins over the sketch, so the two never merge into one ring; the alternative reaches arbitrary shapes, which a rectangle shortcut would not |
| Refusal | The submit button is disabled while the ring is not submittable, and the reason names the defect: no points, fewer than three, coincident points, a frame that leaves ±90/±180, or the offending text line. The handler re-checks before posting, so a stale click cannot send an empty ring |
| Fixed copy | "PATCH menerima nama saja" was false — PATCH accepts geometry. The form now says geometry is fixed at creation, and geometry editing is recorded as the remaining work |
| Not verified | Real pointer and touch behaviour in a browser: there is no web test runner, and adding one is forbidden. typecheck, lint, build and format pass |
| Review corrections | A cleared `type="number"` field is `""`, and `Number("")` is `0`, so a missing latitude silently anchored the drawing on the equator while the code claimed to refuse it. Blank inputs are now refused before conversion, and the typed parser refuses a leading or trailing separator for the same reason. `ringOf` dropped only **consecutive** duplicates, so a corner visited twice closed a zero-area ring that the message said it refused; every repeated position was dropped at this commit, and a ring that could not reach three distinct corners was refused with that reason. That last rule was itself wrong — dropping a non-consecutive repeat changes the shape the user drew — and is corrected in the entry for 2026-11-27 below. Clicking and pasting are capped (200 vertices, 4 000 characters): a pasted ring of thousands froze this tab before any request left it |
| Known limit, not fixed | A failed list reload after a **successful** write replaces the page with that error while the write did land, so the natural reaction is to submit again. This holds for create and for the later edit path. The pattern predates both and affects every page using `useAsync`; fixing it is a loader-level decision, not a field-form one |

### Climate ingestion runbook and the deferred sweep — Phase 5.8, part 2 — 2026-11-27

`docs/operations/climate-ingestion.md` (new). No code, and that is the finding.

| Item | State |
|---|---|
| Runbook | **Added.** What runs, how to start it, the queue queries an operator needs, replay rules, and the coverage queries that can actually be answered today |
| The sweep is not written | **Decided, with the constraint evidence in §3 of the runbook.** Half of it would be dead code: immediate foreign keys make a dangling run reference unstorable, and `weather_records_live_key` (`NULLS NOT DISTINCT`, partial on `superseded_at IS NULL`) makes a live deterministic duplicate unstorable, so a nightly sweep would report zero on a sound database and a dropped index on a broken one. The other half — `missing_record`, `unexpected_record` and the two expectation defects — the database cannot enforce, and `packages/climate-core/src/audit.ts` still serves it for exports, payloads and fixtures |
| The half that cannot be written | "What should have arrived" — the expected horizon per product — is a provider contract. No table holds it, and a made-up horizon table would assert coverage the system cannot prove. `Q-P5-2` is not needed yet because nothing is stored |
| Acceptance stays open | One week of scheduled runs needs a scheduler, and there is none. The runbook states that a count reconciling because nothing ran is not evidence |
| Honesty fixes to existing text | "Two limits" about `coverage_mismatch` is gone (the two-sided check ships); `5.8 not started` is gone; Priority 5 no longer claims `OPEN-26` blocks window generation |
| Signals table | Distinguishes a `last_error.code` from a log event, because `lease_lost` and `ingestion_terminal` never reach `last_error` — the reaper settles those rows |
| Review corrections | Four false sentences were removed after a factual audit. The runbook claimed the runner claims a kind it has no handler for and marks it `job_unhandled`; the claim filter is built from registered handlers, so such a job waits in `queued` forever and `job_unhandled` is unreachable. `handler_error` was grouped with the events that leave a job unsettled, but the worker settles it itself. The "no sweep" argument said *every* audit invariant is a constraint, when only the dangling-reference and duplicate half is; the entry above now says half. §9.6 and §10.7 still carried `BLOCKED by OPEN-26` and are now `PARTIAL` with each check's real state. The audit test count was wrong (fourteen, not twelve) |

### Editing a field's boundary — 2026-11-27

`apps/web/src/pages/FarmsPage.tsx`. The last item Priority 4 called open, now that
`PATCH /v1/fields/:id` was found to accept `geometry` (it always had).

| Item | State |
|---|---|
| What the form does | "Ubah" loads the stored ring into the same textarea the keyboard path already used, one `bujur, lintang` per line. The sketch stays a creation tool: it is anchored on centre and span, and re-deriving a frame from an existing ring would be a second coordinate path |
| Blank means keep | An empty box PATCHes the name alone. No "leave unchanged" checkbox, and no accidental geometry write from a field the user only renamed |
| When geometry is sent | Only when the parsed ring differs **by value** from the stored one, so a formatting-only edit (`106.8,-6.2` versus `106.8, -6.2`) does not bump `updated_at` or recompute an unchanged area |
| Round trip | `String` on a double is the shortest representation that parses back to the same value, so the prefilled text round-trips exactly; `ringText` drops the closing repeat that `ringOf` re-appends |
| Review corrections | `maxLength` was the wrong tool: a prefilled ring over the limit displayed, then truncated on the first keystroke, silently dropping corners behind a normal-looking success. The cap is now checked in `geometryFor` with the length in the message, and `MAX_POLYGON_TEXT` is 12 000 characters — 200 corners at full double precision. Deleting the field being edited cleared the edit session but left its ring in the textarea, so a create would have reused a deleted parcel; that is cleared too. Both silent `return`s in `saveField` became one guard that sets the error, because a no-op is indistinguishable from a hung form. "Ubah" is disabled while a save is in flight, so an in-flight save cannot wipe the edit the user just opened |
| Not verified | Browser interaction (no web test runner, and adding one is forbidden). typecheck, lint, build and format pass |

### Repeats refused, refresh failures told apart, and one query fixed — 2026-11-27

`apps/web/src/pages/FarmsPage.tsx`, `apps/web/src/ui.tsx`, `apps/web/src/useAsync.ts`,
`docs/operations/climate-ingestion.md`.

| Item | State |
|---|---|
| Repeated corner | The previous commit **dropped every repeated position**. That was wrong for a non-consecutive repeat: `A → B → C → B → D` became `A → B → C → D`, a shape the user did not draw. Dropping a *consecutive* repeat stays, because two corners dragged onto one spot are one corner. A corner visited later is now **refused** with the coordinate in the message, which is also what `ST_IsValid` would say about a self-touching ring. A trailing repeat of the first point is still the closure, and is removed |
| Ring result | `ringOf` returns `{geometry}` or `{reason}` instead of `PolygonGeometry | null`, so the refusal carries its own explanation. Both callers propagate it, and the old catch-all "titik berimpit" message is gone |
| Refresh failure | The hook already kept `data`; FarmsPage threw it away by testing `error` before `data`. The guard now replaces the page only when `data === null` — first load — and a failed *refresh* keeps the list and adds a notice: "daftar gagal dimuat ulang; perubahan terakhir mungkin sudah tersimpan". That distinction is what stops a committed write from reading as a failed one |
| Why only FarmsPage | `grep 'reload()'` finds four callers, all there. The other pages take `data + error` together only on a **key change**, where the held data belongs to the previous key and the full-page error is correct. `useAsync`'s comment now says exactly that instead of a blanket rule |
| Runbook query | The duplicate-candidate query grouped by `cell_key, variable, valid_at, ensemble_member` and left out `forecast_run_id`, which the unique index includes. Two runs with the same cell and instant are two valid rows, so the query reported them as duplicates. It now matches `weather_records_live_key` exactly, and still catches a dropped index |
| Not verified | Browser interaction (no web test runner). typecheck, lint, build and format pass; the tip is that no test covers `ringOf`'s new refusal — the repository forbids test files without an explicit command |

### Roadmap reconciliation — 80 stale checkboxes — 2026-11-27

`docs/IMPLEMENTATION_MASTER_ROADMAP.md`, `docs/PRD.md`. Documentation only.

| Item | State |
|---|---|
| What was wrong | 558 unchecked boxes, and a large share described work that already shipped: the crop catalog API (§7.5 said `NOT_STARTED`), 39 of the 44 frontend items (§11 said "web scaffold only" while §18 said Priority 4 was done), the canonical hash and its golden vectors, the health and readiness endpoints, dead-letter handling, the privilege verifier, and the schema-conformance audit |
| What was done | 80 items ticked, each with the file or command that satisfies it. Four status headers corrected: phase table rows 6, 7 and 9 are `PARTIAL`, §7.4 is `PARTIAL` (tenant isolation and geometry invariants verified, concurrency and vocabulary still open), §7.5 reads `DONE for catalog reads; seed still gated`, §11 is `PARTIAL` with the missing screens named |
| What was deliberately left unchecked | §20 (final product completion) is an acceptance checklist, so its ticks are an owner decision, not a repository fact. Items with no implementation stay open even where the surrounding section is now mostly green: crop catalog seed (`OPEN-20`, `OPEN-21`), profile change history, charts, calendar, planting opportunities, activity screens, provider monitoring and verification, and every licensing item |
| The PRD's own status table | `packages/agronomy` said "Not started"; it now names what exists and the fact that no writer consumes it. `packages/climate-core` now names its scope instead of "partial" alone |
| Method | A read-only pass classified every unchecked line against the repository, then each claim was spot-checked before the line changed. Nothing was ticked from naming alone |
| Review corrections | Three sentences were weakened and none unticked. API logging is not JSON — only the worker's is — and `kind` is absent from `lease_lost` and `heartbeat_error`. `db:verify` is a manual run, so least-privilege is verified but not enforced by CI. Tenant isolation rests on `TenantTransaction` typing plus RLS, not on a runtime guard against a raw query on the global client. `createField` and `updateField` are the only geometry writers, and a future importer must reuse `polygonJson` |
| Remaining count | 478 unchecked. Most are gated by `OPEN-03`/`OPEN-05`/`OPEN-11`/`OPEN-18`/`OPEN-20`/`OPEN-21`/`OPEN-27`, or are acceptance criteria that need an owner decision |

### A provider null is an answer, not a gap — 2026-11-27

`packages/contracts/src/climate.ts`, `packages/climate-core/src/daily-read.ts`,
`packages/climate-core/src/daily-read.test.ts`, `apps/web/src/ui.tsx`.

| Item | State |
|---|---|
| What was wrong | The daily read served two different absences as one. A day with no stored row and a day whose stored `value` is null both became `missingReason: "pending"`. `pending` says "may still arrive"; for a provider-published null that is false, and the row beside it already names the class, model and run that answered. The runbook told operators to treat the two separately, and the served contract gave them no way to |
| The split | No row → `pending`, carrying nothing. Stored row with a null value → `provider_null`, carrying `dataClass`, `model` and `initializedAt` from the row, because those are known and are what distinguishes it from a gap |
| Freshness | `availability` is computed from the row's run, so a null published by a stale run reads `stale`. Freshness is a property of the run, not of the value it did or did not publish |
| Served only, not stored | `provider_null` lives in `dailyMissingReasonSchema`, a union of the stored `MissingReason` enum with that one literal. No column stores it, so the stored enum and `monthly_outlooks_missing_reason_check` are untouched — which keeps §8.7C.7's rule intact: a seasonal member-month null has no recoverable cause and must not be reported as `provider_null` |
| Contract | The day's provenance rule was rewritten, not loosened: `valueMm` or `provider_null` requires `dataClass`, `model`, `initializedAt` and `availability`; a bare gap must carry none of them. A first attempt served partial provenance and the schema refused it — correctly — because the old rule was all-or-nothing across five fields. The reviewer caught that before commit; the shape is now checked directly against the built schema (provider-null accepted, provider-null beside a value rejected, labelled gap rejected) |
| Not verified | Browser rendering of the new label. No test file was added for the contract branch, because the repository forbids new test files without an explicit command; the existing daily test that asserted `pending` for a stored null was renamed and re-aimed, which is a correction to an assertion that had encoded the bug |

### Backup and restore drill — Phase 9, §13.6 — 2026-11-27

`docs/operations/backup-restore.md` (new). No source change; the finding is what a
dump does and does not prove.

| Item | State |
|---|---|
| The drill | Dumped the development database (`pg_dump -Fc`, 145 723 bytes), listed the archive, and restored it into a separate database with `--exit-on-error`, which exited 0. `pg_restore` without that flag reports failures as warnings and still exits 0, so the flag is the drill |
| What matched | 26 `app` tables, 88 indexes, 472 constraints, 3 `app` functions, 5 triggers, 11 tables with RLS enabled **and** forced, 24 policies, 263 table grants, all 26 tables owned by `migration_owner`, and every row count — including `users` 41, `weather_records` 120, `climatology_normals` 48, `monthly_outlooks` 40, `forecast_runs` 9 and `jobs` 11 |
| The count that lied | `pg_stat_user_tables.n_live_tup` is a planner estimate, not a count: it reported 12 rows in `app.fields` while the table held 0. The runbook's comparison uses `count(*)` and says why |
| Roles are cluster-wide | The drill restored inside the same cluster, where `app_api`, `app_auth`, `app_system` and `migration_owner` already existed, so ownership resolved without help. Restoring into another cluster fails on ownership unless `pnpm db:bootstrap` runs first — recorded, not tested |
| What it does not prove | No managed instance, no WAL archiving, no PITR, no retention, no off-site copy, no encryption at rest, no schedule. The restore ran as the superuser, so runtime behaviour under `app_api`'s RLS is not exercised; `pnpm db:verify` and `db:verify:probes` check that, against the configured database only. A healthy source database was dumped, which is weaker than restoring after corruption |
| Roadmap | §13.6 restore drill ticked with its limits inline. The production backup strategy, integrity verification and disaster-recovery documentation stay open — each needs the hosting decision. §13.7's backup/restore runbook stays open with the dev-scoped draft named |
| Hygiene | The dump contains every row, including password hashes and session tokens, so it was deleted after the drill and the runbook says to treat one as a secret |

### Withdrawing a queued job — Phase 9, §13.6 — 2026-11-27

`packages/database/prisma/migrations/20261127130000_jobs_cancel`,
`packages/contracts/src/job.ts`, `apps/worker/src/queue/{types,postgres}.ts`,
`apps/worker/src/cancel.ts`.

| Item | State |
|---|---|
| The state added | `cancelled`, with `jobs_status_check` widened and `jobs_finished_check` requiring `finished_at` for it. It is not `dead`: `dead` means an attempt failed and the budget is spent, so reusing it would send an operator looking for a `last_error` that never existed. `jobSchema`'s refinement was updated to match, or the contract would have refused every row the database accepts |
| What can be cancelled | Only a row that has not started: `WHERE status = 'queued' AND ingestion_run_id IS NULL`, one `UPDATE`. Both guards live in the statement, not in a caller-side read: a read followed by an update would let a claim land in between and the cancel would overwrite a running job |
| The second guard, found by audit | A retry leaves the job `queued` while keeping the `IngestionRun` its first attempt opened, and that run is still `running`. Cancelling that row would orphan the run with no error and no finish time, and `settlePair` cannot repair it afterwards because its authority requires a running job. The row is refused and the attempt budget bounds it instead |
| What else is refused | A `running` job, and every terminal state. A running handler may be mid-transaction, the queue has no channel into another process, and aborting the row would leave data whose provenance disagrees with its job status. The lease reaper recovers one whose process died. No `cancel_requested_at`, no HTTP route — a request flag would only be honoured at the next heartbeat, and the handler would still have to cooperate with an abort it already receives on shutdown |
| The consequence that is easy to miss | A cancelled row keeps `(kind, idempotency_key)`, so re-enqueueing the same logical job returns `enqueued: false` and does not run. That is the intended reading of "cancel": the decision is recorded, not erased. A new key is a new job, and a cancel made in error has no supported undo |
| Operator surface | `pnpm --filter @agroclimate/worker cancel:job <jobId>`, needing `APP_SYSTEM_DATABASE_URL` and a build. Exit 0 = this command cancelled the row. Exit 1 = it did not, and the event name says why: `job_not_found`, `job_already_cancelled`, `job_holds_ingestion_run`, `job_not_cancellable`, `cancel_error`. `not-a-uuid` reaches PostgreSQL as a cast failure and is reported as `cancel_error`, not as a database outage |
| Verification | Migration applied to the development database and both CHECKs read back. `queue.test.mjs`: 40 passed, seven of them in the cancel block — withdraw and record `finished_at` with `last_error` untouched; never claimed afterwards; identity key still occupied; running job refused with lease and finish time unchanged; queued retry holding its run refused with the run still `running`; unknown id refused; the CLI driven as a subprocess, exit 0 then `job_already_cancelled`. Removing the `ingestion_run_id` guard makes the run-holding case fail, checked by mutation. `packages/contracts` 431 passed, including `cancelled` with and without `finishedAt` |
| Not verified | The race between `claim` and `cancel` is reasoned, not exercised: both guard `status='queued'` in one statement, so PostgreSQL's re-check makes one of them lose. No tenant can reach the action — `app_api` holds no grant on `app.jobs` — so the CLI is the only caller, which is why the action was implemented at all rather than as a queue method nobody invoked |
