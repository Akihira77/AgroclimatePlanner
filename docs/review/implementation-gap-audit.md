# Implementation Gap Audit — Agroclimate Planner

| Field | Value |
|---|---|
| Scope | Whole repository: `apps/api`, `apps/worker`, `apps/web`, `packages/contracts`, `packages/database`, `docs/` |
| Commit audited | `b48f22c` (`feat(s7): install argon2 and record local benchmark`), branch `master`, clean tree |
| Date | 2026-11-21 |
| Nature | Read-only audit. No source, test, manifest, lockfile, migration, or decision document was modified. |
| Evidence rule | Any status claimed below is backed by a `path:line` citation or an executed command in §G. Where evidence is absent, the report says so. |

---

## A. Executive Summary

**Actual maturity: a hardened, well-tested foundation with zero product features.** Phase 3 is genuinely
complete — monorepo, shared contracts, complete PostgreSQL/PostGIS schema, role/RLS boundary, session
storage. Phase 3.2 S1–S6 are implemented. S7 (password hashing decisions) is resolved as a decision and
as a measured local benchmark, but no hashing code exists. S8 (authentication) has not been started.

**What genuinely works, verified by execution in this audit:**

- All five packages build, typecheck, and lint clean (exit 0).
- `packages/contracts`: 187 tests pass — canonical JSON serialisation, SHA-256 golden vectors against
  independently computed digests, provenance discrimination, error-envelope grammar.
- `apps/api`: 87 tests pass — configuration/credential-role boundary, exception filter (no leakage),
  Zod validation-pipe path safety, request-id, CORS/helmet, pool lifecycle.
- `packages/database`: 34 unit tests pass **plus**, against the live development PostgreSQL, 22 schema
  conformance tests and 88 RLS/privilege integration tests pass. Tenant isolation, the auth boundary,
  session storage, and the `SECURITY DEFINER` purge function are real, enforced, and tested.
- The two API endpoints that exist (`/health`, `/health/ready`) work and are tested.

**What is scaffold, self-declared and confirmed:**

- `apps/worker` is a 14-line file that logs contract version and exits. No Redis, no BullMQ, no job,
  no database connection, no shutdown handling.
- `apps/web` is a 17-line component that renders an `<h1>` and a contract-version paragraph. No router,
  no API client, no styling, no screen.
- `apps/api` has **two route handlers total**, both health probes. No `/v1/*` business route exists.
- `Apps/api` authentication is a credential-parsing boundary and an unregistered connection pool only.
  No guard, no decorator, no session issuance, no tenant context in the request path.

**Documentation honesty: high.** `README.md:5-21` and `docs/IMPLEMENTATION_STATUS.md` state the scaffold
status explicitly and do not claim features that do not exist. This audit found **no** case of a document
claiming an implemented endpoint, job, or screen that is absent from source.

**Biggest blockers to a usable application**, in dependency order:

1. **No authentication and no tenant context in the request path.** Every tenant table is `FORCE` RLS and
   refuses reads and writes without `app.user_id`. `createTenantScope` exists and is tested, but has zero
   application consumers (`grep withTenant apps/` → empty). Nothing product-facing can be built until a
   request establishes a tenant.
2. **No weather ingestion.** No provider adapter, no HTTP client, no normalisation, no scheduler, no
   `cell_key` rounding rule (`OPEN-18` blocks even the first insert).
3. **No agronomic engine.** No `agronomy` package, no thresholds, no suitability or planting-window
   computation. The tables and the contract primitives exist; the logic does not.
4. **No artifact contracts.** There is no envelope schema for farm, field, planting, suitability run,
   planting window, or AI briefing, so no API response shape is agreed.
5. **No CI and the strongest database tests are outside the default pipeline.** `pnpm test` runs only
   `test/unit`; RLS, schema conformance, and privilege verification require manual invocation of separate
   scripts (`packages/database/package.json:22` vs `:30-31`).

---

## B. Verified Implementation Matrix

Legend for **Actual status**: `implemented+verified` (code and an executed check), `implemented-unverified`
(code exists, this audit did not execute its check), `partial`, `scaffold`, `spec-only`
(documented but not implemented), `missing`, `blocked`.

| Domain | Requirement | Actual status | Evidence (file/test) | Gap | Priority |
|---|---|---|---|---|---|
| Monorepo | Workspaces, pinned versions, topological build | implemented+verified | `package.json:1-40`, `turbo.json`, all 5 builds exit 0 (§G.1) | none | — |
| Contracts | Data-class, availability, missing-reason, basis vocabulary | implemented+verified | `packages/contracts/src/enums.ts:10-83`; `weather.test.ts` 9 tests | `station_observation` in enum (`enums.ts:12`) has no `WeatherValue` variant | P2 |
| Contracts | Weather value union with provenance and freshness | implemented+verified | `packages/contracts/src/weather.ts:40-142` | No producer anywhere; `freshness` is never computed | P1 (via T7) |
| Contracts | Canonical JSON + SHA-256 artifact hashing | implemented+verified | `canonical.ts:346`, `hash.ts:12-42`, `hash.golden.test.ts` (external `sha256sum` vectors), `canonical.test.ts` 41 tests | Zero consumers in `apps/` | P1 (via T8) |
| Contracts | Provenance segment / snapshot / derivation descriptor | implemented+verified | `provenance.ts:87-190`; `provenance.test.ts` | `EvidenceSegment` partition validator missing (`OPEN-26`) | P1 |
| Contracts | Response envelope and closed error-code set | implemented+verified | `response.ts:45-327`; `response.test.ts` 37 tests; consumed by `apps/api/src/http/*` | `pageMetaSchema` referenced in a comment (`response.ts:94`) but not defined | P2 |
| Contracts | Domain artifact envelopes (farm, field, planting, harvest, suitability, window, briefing) | missing | Absent from `packages/contracts/src`; only DB columns describe these shapes | No agreed API response contract for any product domain | P1 |
| Database | 23-table physical schema matching domain model | implemented+verified | `schema.prisma` 23 models; 5 migrations create 3+19+1 tables; `schema-conformance.test.mjs:102` asserts exact inventory | 3 documented-but-absent constraints (§C.6) | — |
| Database | Tenant RLS (ENABLE+FORCE, USING+WITH CHECK) | implemented+verified | `20261118020000_tenant_tables:107-139`, `20261118030000_domain_tables:939-965,1233-1258`; `test:rls` 88 pass (§G.2) | — | — |
| Database | Role separation (`app_api`/`app_auth`/`app_system`/`migration_owner`) | implemented+verified | `bootstrap/roles.sql:12-68`; `auth-boundary.test.mjs`; `test:rls` matrix | `app_system` holds `BYPASSRLS` + `DELETE` on the weather plane, contradicting the "never deleted" comment (`domain_tables:290-292` vs `:741-744`) | P2 |
| Database | Session storage + expired-session purge | implemented+verified | `20261118050000_sessions:38-160`; `schema-conformance` sessions tests; `auth-boundary` purge tests | No application code issues or reads a session | P1 (via T2) |
| Database | Privilege verification script (claimed 499 assertions) | implemented-unverified | `scripts/lib/privilege-verification.mjs:566-2130`, wired at `package.json:25` | Not executed by this audit: it re-runs role bootstrap and plants a stray `GRANT` (§G.4). No CI runs it. | P1 |
| Database | Migration ↔ Prisma schema consistency | partial | No diffing tool exists (`schema.prisma:10-22`); hand-synchronised | Drift candidates: `geom @default(dbgenerated())` vs `NOT NULL` without default (`schema.prisma:120` vs `tenant_tables:56`); partial indexes declared as plain (`schema.prisma:110,144-145`) | P2 |
| Database | Seed data for crops / cultivars / profiles / normals | missing | `grep 'INSERT INTO' prisma/migrations` → 0 hits | Catalog tables are empty; the agronomy engine has nothing to evaluate | P1 |
| API | Bootstrap, config, credential role boundary | implemented+verified | `main.ts:6-18`, `runtime-config.ts:89-331`; `config.test.mjs` | — | — |
| API | HTTP plumbing (request-id, helmet, CORS, proxy trust, shutdown) | implemented+verified | `app.factory.ts:46-81`; `http.test.mjs` | Signed cookies deliberately off (`app.factory.ts:54-55`) | — |
| API | Error contract, no internal leakage | implemented+verified | `api-exception.filter.ts:25-281`; `errors.test.mjs`, leak assertions `routing.test.mjs:111-146` | — | — |
| API | Validation at the boundary | implemented+verified | `zod-validation.pipe.ts:73-172`; `validation.test.mjs` | No route consumes it yet (no global pipe; deliberate, `app.factory.ts:71-73`) | — |
| API | Health and readiness | implemented+verified | `health.controller.ts:45-111`; `routing.test.mjs` | — | — |
| API | Health readiness behaviour under a **real** statement timeout | implemented-unverified | `health.controller.ts:69-71` comment claims manual verification; `routing.test.mjs:64-67` asserts wiring only | No integration test against live PostgreSQL | P3 |
| API | Authentication, session lifecycle, authorization | scaffold | `tokens.ts:5-12`, `auth-database.module.ts:43-59`; module **not imported** by `AppModule` (`app.module.ts:26-30`) | No guard, no decorator, no login/logout/refresh route, no cookie issuance | P0 |
| API | Tenant context in the request path | missing | `createTenantScope` exported (`packages/database/src/index.ts:14`) with zero `apps/` consumers | Any future tenant query would return zero rows under RLS | P0 |
| API | Farm CRUD | missing | no controller; `farms` table and RLS only | — | P1 |
| API | Field CRUD + spatial validation | missing | no controller; `fields` constraints exist (`tenant_tables:48-87`) | Blocked by `OPEN-17` (point fields, `area_ha = 0`) | P1 |
| API | Crop / cultivar catalog read | missing | no controller; tables exist, unseeded | — | P1 |
| API | Weather read APIs | missing | no controller; `weather_records`, `monthly_outlooks` empty and unwritten | — | P1 |
| API | Suitability / planting-window APIs | missing | no controller; tables exist | — | P2 |
| API | Planting and harvest records | missing | no controller; tables exist | Blocked by `OPEN-09` (`plantings.status` vocabulary) | P2 |
| API | Field observations | missing | no controller; table exists | — | P3 |
| API | Monitoring / freshness endpoints | missing | no controller | — | P2 |
| API | AI briefing API | missing | no controller; `ai_briefings` table exists | `OPEN-11`: subsystem unimplementable as specified | P3 |
| API | OpenAPI document | missing | no `@nestjs/swagger`, no spec file | API shape exists only in code | P2 |
| Worker | Queue registration, job producers/consumers | missing | `apps/worker/src/main.ts:1-14`; no `bullmq`/`ioredis` in any manifest (`grep` → 0) | Entire background plane absent | P1 |
| Worker | Weather ingestion, normalisation, run identity | missing | spec only: `docs/architecture/background-processing.md` | `OPEN-18` blocks the first insert | P1 |
| Worker | Retry, failure handling, idempotency, job observability | missing | no code | — | P2 |
| Worker | Climate aggregation, recompute fan-out | missing | no code | `OPEN-27`: `app_system` has no grant on tenant tables | P2 |
| Worker | Forecast verification jobs | missing | no code, and **no table** for verification results (`grep -i verification` in `schema.prisma` → 0) | Requires a new table and a decision | P3 |
| Weather/climate | Provider adapters, response validation | missing | no adapter; `docs/research/weather-source-matrix.md` is spec-only | `ADR-001` still `Proposed` (`ADR-001:3`); `OPEN-02` licence unresolved | P1 |
| Weather/climate | Daily forecast / subseasonal / seasonal storage | spec-only | `weather_records`, `monthly_outlooks`, `forecast_runs` tables exist (`domain_tables:347-541`) | Empty; no writer | P1 |
| Weather/climate | Climatology baseline ingestion | spec-only | `climatology_normals` (`domain_tables:680`), unseeded | — | P1 |
| Weather/climate | Anomaly computation | missing | `monthly_outlooks.anomaly*` columns exist; no computation | — | P2 |
| Agronomy | Crop/cultivar profiles, growth stages, constraints | spec-only | tables only (`domain_tables:52-260`); no `agronomy` package exists | No thresholds populated | P1 |
| Agronomy | Full-growth-cycle suitability, `insufficient_data` handling | missing | no engine code anywhere | — | P1 |
| Agronomy | Planting-window generation + evidence segments | missing | `planting_windows` table; `evidenceSegmentSchema` contract | `OPEN-26` validator absent | P2 |
| Agronomy | Input snapshot + deterministic artifact hashing | partial | `fieldSnapshotPayloadSchema` + `hashFieldSnapshot` implemented and tested (`provenance.ts:131-149`, `hash.ts:24-32`) | Nothing produces a snapshot | P1 (via T8) |
| Frontend | Application shell, navigation, routing | scaffold | `App.tsx:1-17`, `main.tsx:1-12`; no router dependency | No layout, no navigation | P1 |
| Frontend | Dashboard, farm/field screens, crop catalog, weather, calendar, suitability, briefing | missing | only two files in `apps/web/src` | Every screen absent | P2 |
| Frontend | Loading / empty / error / insufficient-data states | missing | no data fetching exists | — | P2 |
| Frontend | Responsive behaviour, design system | missing | no CSS file at all in `apps/web/src` | — | P3 |
| AI | Deterministic-artifact-driven briefing | missing | `ai_briefings` table; no engine, no provider client | `OPEN-11` | P3 |
| Ops | CI pipeline | missing | no `.github`, no `.gitlab-ci.yml`, no `Jenkinsfile` | Every guarantee is manual | P1 |
| Ops | Aggregate test covers the strongest DB checks | missing | root `test` → `turbo run test`; database `test` = `test/unit` only (`packages/database/package.json:22`); `test:schema` not exposed at root | RLS/schema/privileges never run automatically | P1 |
| Security | Password hashing | scaffold | `@node-rs/argon2@2.2.2` installed (`apps/api/package.json`), imported **only** by `apps/api/scripts/benchmark-argon2.mjs` | No hashing service, no parameter constant in runtime code | P0 |
| Security | Rate limiting on auth surface | missing | no endpoint exists; no limiter dependency | `LIMITER-MECHANISM` decided, unimplemented | P1 |

---

## C. Architecture and Data Flow Findings

### C.1 The flow that actually exists (HTTP)

```
client
  → express: helmet → cookieParser(no secret) → requestIdMiddleware → CORS allowlist
  → Nest router (@Controller("health"), excluded from the /v1 prefix)
  → HealthController
      /health        : reads CONTRACTS_VERSION + enum length          → 200, no I/O
      /health/ready  : DATABASE_CLIENT.$transaction(SET LOCAL
                       statement_timeout; SELECT 1)                   → 200 | 503
  → ApiExceptionFilter (all exceptions, fixed message table, closed code set)
  → response envelope from @agroclimate/contracts
```

Evidence: `app.factory.ts:46-81`, `health.controller.ts:45-111`, `api-exception.filter.ts:25-281`.

**What is absent from this flow:** authentication, authorization, tenant context, any domain query,
any mutation, pagination, OpenAPI generation. There is no `/v1` route at all, so the `v1` global prefix
(`app.factory.ts:78`) currently prefixes nothing.

### C.2 The flow that is designed but does not exist (product pipeline)

Documented target (`docs/architecture/data-flow.md`, `background-processing.md`):

```
provider API → adapter+validation → ingestion_run → normalisation → weather_records
            → aggregation → monthly_outlooks → agronomy engine → suitability_runs
            → planting_window + evidence segments → API → UI
                                                        ↘ AI briefing (explains artifacts only)
```

Every box after the first is missing or empty. What exists is the **destination schema** and the
**provenance/hashing primitives** that the pipeline is required to use.

### C.3 Critical structural mismatch: tenant context has no consumer

`createTenantScope(prisma).withTenant(userId, fn)` opens a transaction and sets
`app.user_id` transaction-locally (`packages/database/src/tenant.ts:61-78`). It is unit-tested
(`test/unit/tenant.test.mjs`) and integration-tested (`test/rls/tenant-isolation.test.mjs`).

It is **not used by any application code**. `apps/api` injects the raw `PrismaClient` as
`DATABASE_CLIENT` (`database.module.ts:48`) and performs one `SELECT 1`.

Consequence, stated precisely: if a tenant-scoped query were added tomorrow using the current injection,
RLS would evaluate `NULLIF(current_setting('app.user_id', true),'')::uuid` to `NULL`, so every SELECT
would return zero rows and every INSERT would be refused (`tenant_tables:111-112`). The plumbing that
prevents this bug exists; nothing connects it. This is the single most important architectural gap.

### C.4 Worker flow

There is none. `apps/worker/src/main.ts:8-12` prints one line and the process exits because nothing holds
the event loop. It has no dependencies beyond `@agroclimate/contracts`. Any background capability starts
from zero: runtime selection, queue client, job schema, idempotency keys, shutdown semantics.

### C.5 Frontend flow

`apps/web/src/main.tsx:5-12` mounts `App.tsx`, which renders static JSX with no fetch, no router, no state,
and no stylesheet. There is no API client module in the package. No screen can display data and no action
can reach the backend.

### C.6 Schema/contract integrity findings

1. **Contract ↔ schema naming drift.** `fieldSnapshotPayloadSchema` has `irrigationAvailable: boolean`
   and `irrigationSource` (`provenance.ts:139-141`), while the storage columns are
   `irrigationAvailability String` and `waterSource String` (`schema.prisma:126-127`). The hashed snapshot
   cannot be reconstructed from the row without a mapping that does not exist. This will bite at the first
   snapshot producer.
2. **`station_observation` is storable but unrepresentable.** The data class is in the enum
   (`enums.ts:12`) and in the DB CHECK (`domain_tables:589-592`), but the `WeatherValue` union has exactly
   four variants and none is a station observation (`weather.ts:125-142`). Either the class is unreachable
   or a value cannot be typed.
3. **Documented-but-absent constraints**: the immutable-published-profile trigger
   (`domain_tables:144-152`, marked `UNRESOLVED`) and the `plantings.status` CHECK (`domain_tables:882-887`,
   `OPEN-09`). The migration comments are accurate — these are not oversights, they are recorded debts.
4. **`app_system` retention contradiction**: the weather-plane comment says nothing is ever deleted
   (`domain_tables:290-292`) but the same migration grants `app_system` `DELETE` on all six plane tables
   (`:741-744`), and `app_system` holds `BYPASSRLS` (`roles.sql:24`). The retention invariant is a comment,
   not a control.
5. **Empty catalog.** No migration inserts any crop, cultivar, profile, growth stage, constraint, source
   reference, or climatology normal. The agronomic domain is a set of empty containers.

---

## D. Critical Gaps

Ordered by what actually prevents the primary workflow ("what should I plant, where, and what is the
risk"). Each is a blocker at the layer named, not a stylistic objection.

1. **No tenant context in the request path** (§C.3). Blocks every tenant-scoped feature. P0.
2. **No authentication.** No login route, no session issuance, no cookie verification, no guard. `OPEN-01`
   ("nothing can read a credential") is still `BLOCKED_EXTERNAL_INPUT`. P0.
3. **No password hashing in runtime code.** The dependency and the measured parameters exist; no service
   consumes them. P0 (part of the same slice as #2).
4. **No API contract for any product artifact.** Without farm/field/suitability/window envelopes, the API
   and the web app cannot be developed in parallel against an agreed shape. P1.
5. **No seeded catalog and no agronomic engine.** Even with weather data, there is nothing to evaluate
   against and nothing to compute. P1.
6. **No weather ingestion.** No adapter, no normaliser, no run identity writer, no scheduler, no
   `cell_key` rule (`OPEN-18` blocks the first insert). P1.
7. **No `climatology_normals` population.** The 12-month horizon is mostly climatology by design
   (`PROJECT.md`), so an empty baseline means most of the planning year has no defensible value. P1.
8. **No CI, and `pnpm test` omits RLS, schema, and privilege verification.** Proven guarantees are one
   `git push` away from silent regression. P1.
9. **No frontend capability at all.** Two files, no router, no client, no state. P2.
10. **No forecast verification storage or logic**, despite being a stated domain
    (`PROJECT.md` domain 11) — it needs a table that does not exist. P3.

---

## E. Dependency-Aware Implementation Backlog

Ordered so each task's prerequisites are complete before it starts. Sizes are scope statements, not
estimates. "Files" are the modules expected to change; exact paths may shift once design starts.

### T1 — Contract envelopes for the first product artifacts
| | |
|---|---|
| Priority | P1 |
| Objective | Agree the API shape for farm, field, planting, harvest before any controller is written. |
| Scope | Add `farm.ts`, `field.ts`, `planting.ts` to `packages/contracts/src` using `envelopeSchema`; extend `enums.ts` with the status/type vocabularies that already exist as DB CHECKs; add the missing `WeatherValue` variant for `station_observation` or remove the class; add `pageMetaSchema` or delete the comment referencing it. |
| Files | `packages/contracts/src/*.ts`, `index.ts` |
| Depends on | `OPEN-17` (field `area_ha` for point geometries) |
| Acceptance | Schemas parse every DB constraint they mirror; a round-trip test proves a valid row shape parses and an invalid one is refused; `station_observation` has a decision recorded. |
| Verification | `pnpm --filter @agroclimate/contracts test`, `typecheck`, `lint` |

### T2 — Authentication and tenant-context slice (S7 + S8)
| | |
|---|---|
| Priority | P0 |
| Objective | Make a request carry a verified user identity into an RLS transaction. |
| Scope | **S7 first:** `POST /v1/auth/register` plus credential verification (uniform failure, dummy hash on unknown accounts) — it issues no session, per `IMPLEMENTATION_STATUS.md:460`. **Then S8:** `POST /v1/auth/login`, `POST /v1/auth/logout`, `GET /v1/auth/me`; Argon2id service using `@node-rs/argon2` with the parameters from `phase-3.2-s7-local-argon2-benchmark-results.md`; session token generation, SHA-256 storage against `app.sessions` through the `app_auth` pool, httpOnly cookie, CSRF, login-side rate limiting; a Nest guard that resolves the cookie to a `userId`; a request-scoped tenant provider that wraps `withTenant`; register `AuthDatabaseModule` in `AppModule`. |
| Files | `apps/api/src/auth/**` (new), `apps/api/src/database/auth-database.module.ts`, `app.module.ts`, `packages/contracts/src/auth.ts` (new) |
| Depends on | `OPEN-01` (credential lookup key), `IG-8`, `IG-9`, T1, verified password parameters |
| Acceptance | Registration stores an argon2id hash and never returns it; an unknown account and a wrong password return one identical error after comparable work; login sets an httpOnly cookie; an unauthenticated request to a tenant route returns 401; an authenticated request resolves `app.user_id` and reads only its own rows; logout revokes and the cookie stops working. |
| Verification | New API tests with the stubbed pool double **plus** one integration test against live PostgreSQL proving `app.user_id` is set; `test:rls` still green |

### T3 — Farm and field CRUD
| | |
|---|---|
| Priority | P1 |
| Objective | The first real product mutations, proving the tenant slice end to end. |
| Scope | Controllers, services, repositories for `farms` and `fields`; PostGIS geometry validation at the boundary (type, SRID 4326, non-empty, valid); derived `area_ha` exposed read-only; soft-delete honouring the partial indexes. |
| Files | `apps/api/src/farm/**`, `apps/api/src/field/**` (new), contracts from T1 |
| Depends on | T1, T2 |
| Acceptance | Cross-tenant access returns 404 (not 403, no existence leak); invalid geometry refused with a validation error, not a 500; deleting a farm with fields is refused or cascades per the chosen rule. |
| Verification | API tests + live-PostgreSQL integration tests |

### T4 — Crop catalog seeding and read API
| | |
|---|---|
| Priority | P1 |
| Objective | Make the four v1 crops (`padi`, `jagung`, `kedelai`, `cabai`) real data. |
| Scope | A seed path for `crops`, `cultivars`, `crop_profile_versions`, `growth_stages`, `constraints`, `source_refs`; `GET /v1/crops`, `GET /v1/crops/:slug`; encode `kedelai` and `cabai` water requirement as `insufficient_data` per `PROJECT.md`. |
| Files | `packages/database/prisma/seed*` (new), `apps/api/src/crop/**` (new), `packages/contracts/src/crop.ts` |
| Depends on | T1 |
| Acceptance | Catalog is idempotently seeded; a crop without a water threshold returns `insufficient_data`, never a default; every threshold row has a `source_ref`. |
| Verification | Seed re-run produces no duplicates; contract validation of each response |

### T5 — Weather provider adapter and ingestion write path
| | |
|---|---|
| Priority | P1 |
| Objective | Land real forecast rows with full run identity and provenance. |
| Scope | One adapter (Open-Meteo per `ADR-001`), response validation, `forecast_runs`/`ingestion_runs` identity, normalisation into `weather_records`, idempotent re-ingest via `weather_records_live_key`, a manual trigger command; no scheduler yet. |
| Files | `packages/weather-core/**` (new per `system-architecture.md`), `apps/worker/src/**` |
| Depends on | `OPEN-18` (cell-key rounding), `ADR-001` acceptance, `OPEN-02` for non-local use |
| Acceptance | Re-running an ingest for the same run inserts no duplicates and supersedes correctly; a provider error is recorded and does not overwrite live rows; every row carries `data_source`, `initialized_at`, `ingestion_run_id`. |
| Verification | Adapter unit tests with recorded fixtures; live-PostgreSQL integration test proving supersession |

### T6 — Climatology baseline load
| | |
|---|---|
| Priority | P1 |
| Objective | Populate `climatology_normals` so months 8–12 have a defensible value. |
| Scope | One baseline source (CHIRPS v3.0 or the documented ERA5 fallback per `ADR-001` D2), monthly normals 1991–2020, the dataset name stored per record. |
| Depends on | T5 (shared normalisation and run identity) |
| Acceptance | Every cell used for planning has 12 monthly normals with a named baseline; missing months are stored as missing, never interpolated silently. |
| Verification | Row-count and completeness assertion per cell; provenance field present on every row |

### T7 — Weather and climate read API
| | |
|---|---|
| Priority | P1 |
| Objective | Expose forecast, subseasonal, seasonal, and climatology values with honest class separation. |
| Scope | `GET /v1/fields/:id/weather?from&to`; response segments by `dataClass`; freshness computed from `ttl_seconds`/`initialized_at`; climatology never labelled as forecast; `mixed` basis only where a range genuinely mixes classes. |
| Files | `apps/api/src/weather/**` (new), contracts from T1 |
| Depends on | T3, T5, T6 |
| Acceptance | A field with no ingested data returns an explicit empty/insufficient response, not climatology; a stale value is marked stale with its age; the response validates against the contract. |
| Verification | API tests over seeded fixtures + live-PostgreSQL integration |

### T8 — Agronomic suitability engine
| | |
|---|---|
| Priority | P1 |
| Objective | Deterministic evaluation of a full growth cycle against stored thresholds. |
| Scope | `packages/agronomy` (new): growth-stage traversal, temperature/rainfall/water/soil constraints, `insufficient_data` propagation, per-constraint explanations, `SuitabilityRun` persistence with a hashed field snapshot (`hashFieldSnapshot`). |
| Files | `packages/agronomy/**` (new), `apps/api/src/suitability/**` (new), `packages/contracts/src/suitability.ts` |
| Depends on | T3, T4, T7 |
| Acceptance | Identical inputs produce an identical `fieldSnapshotHash`; missing agronomic input yields `insufficient_data` and never a fabricated default; every constraint verdict traces to a `source_ref`; the engine is pure and unit-testable without a database. |
| Verification | Unit tests per constraint and per stage boundary; golden hash test; integration test persisting a run |

### T9 — Planting-window generation and persistence
| | |
|---|---|
| Priority | P2 |
| Objective | Turn suitability runs into dated windows with evidence segments. |
| Scope | Window scan over the horizon, `evidence_segments` with contiguous-date partition validation (`OPEN-26`), `missing_ranges`, `PlantingWindow` persistence with `derivation_descriptor` hashing. |
| Depends on | T8, `OPEN-26` |
| Acceptance | Segments partition the window exactly, with no gaps or overlaps; a malformed segment is refused at write time; the descriptor hash is stable and unique per input. |
| Verification | Property-style test over generated date ranges; `hashDerivationDescriptor` golden vector |

### T10 — Frontend shell, farm/field workflow
| | |
|---|---|
| Priority | P2 |
| Objective | First user-facing vertical slice against real API data. |
| Scope | Router, layout, API client with the contract schemas as validators, farm list/detail, field create/edit with map or coordinate entry, loading/empty/error states. |
| Depends on | T3, T1 |
| Acceptance | No mocked data path in production code; every shown value came from the API; errors surface the envelope's user message. |
| Verification | `pnpm --filter @agroclimate/web build` + manual browser flow; a Playwright check if one is introduced |

### T11 — Twelve-month planning calendar and dashboard
| | |
|---|---|
| Priority | P2 |
| Objective | The primary surface: what to plant, when, where, and with what risk. |
| Scope | Twelve-month timeline rendering distinct data classes, planting-window overlay, suitability summary, freshness badges, insufficiency states. |
| Depends on | T7, T9, T10 |
| Acceptance | Climatology and forecast are visually and textually distinct; stale data is marked; insufficient data is not rendered as a recommendation. |
| Verification | UI review against the accepted design reference in `docs/design/` |

### T12 — AI briefing
| | |
|---|---|
| Priority | P3 |
| Objective | Narration over verified deterministic artifacts only. |
| Scope | Briefing generator that receives serialised artifacts and provenance, never raw weather; caching by `ai_briefings_cache_key`; explicit "insufficient data" refusal path. |
| Depends on | T8, T9, `OPEN-11` |
| Acceptance | The model receives no data that was not already an artifact; a degraded or refused generation is surfaced, not silently replaced. |
| Verification | Fixture-based tests; a refusal case |

### T13 — CI and aggregate verification (can run in parallel from day one)
| | |
|---|---|
| Priority | P1 |
| Objective | Stop regressions in the guarantees that already exist. |
| Scope | CI job running build/typecheck/lint/test for all packages plus `db:migrate` + `db:bootstrap` + `db:verify` + `test:schema` + `test:rls` against a PostGIS service container; expose `test:schema` at the root. |
| Files | `.github/workflows/*.yml` (new), `package.json`, `turbo.json` |
| Depends on | none |
| Acceptance | A PR that drops a tenant policy, removes a grant, or breaks a hash vector fails CI. |
| Verification | One deliberately broken branch demonstrating a red build, then reverted |

---

## F. Recommended First Implementation Milestone

**Milestone 1 — "Tenant-scoped vertical slice": T2 + T1 + T3.**

Rationale:

- Every product entity is tenant-owned under `FORCE` RLS. Until a request produces a verified `app.user_id`,
  no other feature can be built or tested, and the existing tenant plumbing (`withTenant`, tested) stays
  dead code. This is the only gap that blocks *all* vertical progress rather than one feature.
- It is also the smallest slice that ends with something demonstrable: a user logs in, creates a farm,
  creates a field, and can prove that another user cannot see either.
- It consumes the decisions already made (`OPEN-01` excepted), the installed dependency, and the measured
  parameters, so no new design work is required beyond T1's contract shapes.
- Excluded deliberately: any weather, agronomic, or AI work. Those depend on data that does not exist and
  would be built against unvalidated contracts.

**Scoped deliverables:** argon2 service + parameter constant; login/logout/me; session guard; request-scoped
tenant provider wired to `withTenant`; `AuthDatabaseModule` registered; farm and field controllers with
geometry validation; contract envelopes for auth, farm, field; the `area_ha`/point-geometry rule resolved.

**Completion criteria:**

1. `POST /v1/auth/login` with valid credentials sets an httpOnly cookie; invalid credentials return one
   uniform error.
2. A tenant route without a session returns 401; with a session, the PostgreSQL transaction carries
   `app.user_id`.
3. User A cannot read, update, or delete user B's farm or field — proven by an integration test against
   live PostgreSQL, not by a stub.
4. A second user creating a field that references the first user's farm is refused at the database level.
5. Every new route's response validates against a contract schema in `packages/contracts`.
6. The pre-existing suites stay green, and the new integration tests are in a pipeline stage that actually
   runs.

**Prerequisite decisions — resolved after this audit.** At audit time the three were open. On 2026-11-21
the owner approved all three: `OPEN-01`'s boundary (dedicated `app_auth`, least privilege, no `BYPASSRLS`,
no new `SECURITY DEFINER`, no tenant context on the auth path), `IG-8` (`__Host-agroclimate_session`,
`HttpOnly`/`Secure`/`SameSite=Lax`/`Path=/`, no `Domain`), and `IG-9` (session-bound synchronizer token in
`X-CSRF-Token` plus exact `Origin` validation against `CORS_ORIGINS`). They are recorded in *Amendment 3* of
`docs/review/phase-3.2-owner-decisions.md` and formalised in `docs/adr/ADR-006-session-transport-and-csrf.md`.

Correction to the paragraph this replaces: it called `OPEN-01` "the credential lookup key (username vs
email)". That was wrong — the lookup key is already fixed as email with shared normalisation
(`api-conventions.md` §8.1, `IG-1` answered). `OPEN-01` is the database *boundary*, which `ADR-004` built and
the 2026-11-21 amendment confirms.

What remains before T2 is therefore implementation, not decision: `S7` (register + credential verification)
then `S8` (login, session, guard). No gate is outstanding.

If the cookie, CSRF-token-retrieval, or session-detail shapes are later found underspecified, the honest
sequencing is to run **T13 (CI)** and **T4+T8** in parallel — they need no tenant context — rather than to
start T2 against invented shapes.

---

## G. Verification Results

Environment: Node `v24.14.0`, pnpm `12.18.0`, turbo `2.11.12`, Linux (WSL2), commit `b48f22c`, clean tree.
Live database: container `agroclimate-db`, healthy, `127.0.0.1:5442`, PostgreSQL 18 + PostGIS 3.6.

### G.1 Build, typecheck, lint (all five packages)

```
pnpm --filter <pkg> build      → exit 0 for contracts, database, api, web, worker
pnpm --filter <pkg> typecheck  → exit 0 for all five
pnpm --filter <pkg> lint       → exit 0 for all five
```

Notable: `@agroclimate/database` build runs `prisma generate` (client emitted to
`src/generated/prisma`, untracked per `.gitignore`).

### G.2 Tests

| Command | Result |
|---|---|
| `pnpm --filter @agroclimate/contracts test` (vitest) | exit 0 — 6 files, **187 tests** passed |
| `pnpm --filter @agroclimate/database test` | exit 0 — **34 tests**, 6 suites (unit only, no database) |
| `pnpm --filter @agroclimate/api test` | exit 0 — **87 tests**, 12 suites |
| `NODE_ENV=development pnpm --filter @agroclimate/database test:schema` | exit 0 — **22 tests**, 7 suites, against live PostgreSQL |
| `NODE_ENV=development pnpm --filter @agroclimate/database test:rls` | exit 0 — **88 tests**, 7 suites, against live PostgreSQL |
| `pnpm --filter @agroclimate/web test` | prints `[web] no tests in Phase 2.0`, exit 0 |
| `pnpm --filter @agroclimate/worker test` | prints `[worker] no tests in Phase 2.0`, exit 0 |

`test:schema` is read-only (catalogue queries as `migration_owner`). `test:rls` writes and cleans up its own
test rows inside the development database; it was executed because it is the project's own documented
verification path (`README.md:56`) and it destroys nothing outside its fixtures.

### G.3 Checks **not** run, and why

| Check | Reason |
|---|---|
| `pnpm db:verify` (~499 assertions) | The script plants a stray `GRANT CREATE` and re-runs role bootstrap as cluster admin (`privilege-verification.mjs:1548-1583`). That is a privileged mutation of cluster roles, outside an audit's mandate. Its claims therefore remain **unverified by this audit**. |
| `pnpm db:verify:probes` | Spawns concurrent verification runs against the same cluster; same privileged-mutation concern. |
| `pnpm db:migrate` / `db:bootstrap` | Writes to the database. Not needed: the schema conformance suite proves the applied migrations match. |
| Any provider HTTP call | No adapter exists; external calls were out of scope. |
| Frontend runtime behaviour | There is no behaviour to exercise beyond static rendering. |

### G.4 Structural checks

| Check | Result |
|---|---|
| Route inventory (`grep -rn "@Controller\|@Get\|@Post\|@Put\|@Patch\|@Delete" apps/api/src`) | `health` controller only: `@Controller("health")`, `@Get()`, `@Get("ready")`. The `@Get()` in `zod-validation.pipe.ts` is inside a doc comment. |
| `grep -rn "bullmq\|ioredis\|redis" --include=package.json apps packages` | 0 hits |
| `grep -rn "withTenant\|createTenantScope" apps packages/database/src --include=*.ts` | only the export in `packages/database/src/index.ts:14` — no application consumer |
| `grep -rn "AuthDatabaseModule" apps/api/src` | only its own definition — never registered |
| `grep -rn "@node-rs/argon2" apps packages --include=*.ts --include=*.mjs` | only `apps/api/scripts/benchmark-argon2.mjs` |
| `grep -rn "INSERT INTO" prisma/migrations` | 0 hits — no seed data exists |
| `.github` / `.gitlab-ci.yml` / `Jenkinsfile` | none exist |
| Root `test` script | `turbo run test`; database `test` is `node --test test/unit/*.test.mjs` only |

### G.5 Documentation cross-check

Every artefact referenced by `docs/IMPLEMENTATION_STATUS.md` was located on disk: `canonical.ts`, `hash.ts`,
`bootstrap/roles.sql`, migrations `20261118000000_init_extensions` … `20261118050000_sessions`,
`apps/api/src/{http,health,config,database}/*`, `apps/api/scripts/benchmark-argon2.mjs`,
`packages/database/src/tenant.ts`, the 16 files under `docs/data-model/`.

No document was found claiming a product endpoint, worker job, or web screen that does not exist. The
status document states the opposite explicitly (`IMPLEMENTATION_STATUS.md:460` "No endpoint, no hashing";
`:585-586` "No authentication workflow exists").

Stale statuses found:

- **S7 row is behind the code.** `IMPLEMENTATION_STATUS.md:460` still says `ARGON2ID-LIB` "neither is
  installed or implemented" and that the benchmark is "blocked on a container memory limit the repository
  does not define". Commit `b48f22c` installed `@node-rs/argon2@2.2.2` and executed the benchmark; the
  document needs the same one-line correction the plan document already received. The rest of the row
  ("No endpoint, no hashing, no auth schema exists") is still accurate.
- `ADR-001`, `ADR-002`, `ADR-003` still read `Status: Proposed` (`ADR-001:3`) while later work depends on
  them, and `IMPLEMENTATION_STATUS.md:50` records ADR-002 as "done (Proposed)".
- Assertion counts for the privilege script (`387`, `419`, `493`, `499`) could not be confirmed because the
  script was not executed (§G.3). The RLS (88) and schema (22) figures **do** reproduce, as does the
  `pnpm test` figure in `IMPLEMENTATION_STATUS.md:458` (87 API + 34 database).

---

## H. Unresolved Decisions

Only decisions that block or materially change the next milestone.

| ID | Decision | Status | Effect on this plan |
|---|---|---|---|
| `OPEN-01` | Credential lookup key and its uniqueness index (interacts with `OPEN-04`) | `BLOCKED_EXTERNAL_INPUT` | Blocks T2 and therefore the recommended Milestone 1. Nothing in the app can read a credential until it is answered. |
| `IG-8` | Cookie name and `__Host-` prefix | **approved 2026-11-21** (after this audit's evidence snapshot; `ADR-006`) — was unanswered at audit time | No longer blocks the cookie half of S8; implementation outstanding. |
| `IG-9` | CSRF mechanics: header name, token length, comparison, rotation | **approved 2026-11-21** for the pattern, header, methods, and origin source (`ADR-006`); token length, encoding, retrieval, and rotation remain S8 design | No longer blocks the first non-GET authenticated endpoint at the decision level. |
| `OPEN-17` | `area_ha` for `POINT` fields vs a positive `areaHa` contract | `BLOCKED_EXTERNAL_INPUT` | Blocks the field half of T1/T3: the storage value is `0` for point geometry, which a `positive()` schema would refuse. |
| `OPEN-18` | Per-model `cell_key` rounding rule | open | Blocks the first weather insert (T5). Without it, two providers produce incomparable cells. |
| `OPEN-26` | `EvidenceSegment` partition validator | open — validator "does not exist" | Blocks writing planting windows (T9); a malformed window is currently storable. |
| `OPEN-27` | `app_system` has no grant on tenant tables — recompute fan-out design | open | Blocks any background recompute of per-farm artifacts. |
| `OPEN-09` | `plantings.status` vocabulary and default | deferred, not closed | Blocks the first write to `plantings` (T3 extension). |
| `OPEN-02` | Open-Meteo free-tier non-commercial licence | P1, mitigated for local use by a labelled fallback | Blocks commercial deployment, not local development. Must be settled before any paid or public deployment. |
| `OPEN-11` | AI subsystem boundary | open | Blocks T12 only. |
| — | `ADR-001` status is `Proposed` | Proposed despite being the basis of all weather work | Should be accepted or amended before T5, so the adapter is built against a settled provider strategy. |

Not reopened here, because the evidence does not contradict them: the database/RLS/auth-boundary/session
decisions (ADR-003, ADR-004, ADR-005) are implemented, tested against live PostgreSQL, and consistent with
their documents.
