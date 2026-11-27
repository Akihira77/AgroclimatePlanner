# Agroclimate Planner

AI-assisted agricultural weather and climate planning for Indonesia. The target
product is a twelve-month rolling outlook, crop planting windows, a calendar UI,
and an AI analyst; the state table below says what of it exists.

This repository has a working development stack: monorepo foundation, shared
contracts, the PostgreSQL/PostGIS schema with row-level security, authentication,
tenant-scoped Farm and Field CRUD, the crop catalog, climate outlook and forecast
reads, a PostgreSQL-backed job queue with ingestion handlers, and the agronomy
suitability engine. The web app has screens for all of it.

What is not there is a production deployment and the decisions it depends on: no
hosting or TLS, no validated provider grid (`OPEN-18`), no commercial ingestion
licence (`OPEN-03`), no scheduler, no seeded crop catalog (`OPEN-20`, `OPEN-21`),
and no AI briefing (`OPEN-11`). `docs/OWNER_DECISIONS.md` holds those decisions;
`docs/IMPLEMENTATION_MASTER_ROADMAP.md` holds the phase state.

| Layer           | State                                                                                                                                                                                         |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo        | implemented — pnpm workspaces + Turborepo, three applications and five shared packages, pinned versions                                                                                       |
| Contracts       | implemented — Zod schemas, provenance contract, canonical serialisation, SHA-256 golden vectors                                                                                               |
| Database        | implemented — 25 tables in schema `app` (24 domain + `sessions`), RLS forced on every tenant-owned table, four explicit roles, hand-written SQL migrations, digest and privilege verification |
| API             | implemented — health and readiness, auth (register, login, logout, CSRF), tenant-scoped Farm and Field CRUD, crop catalog, climate outlook and forecast reads; role `app_api`                 |
| Worker          | implemented — PostgreSQL queue, lease/reaper/retry runner, `IngestionRun` lifecycle, forecast/climatology/seasonal handlers, job cancellation; role `app_system`; no scheduler                |
| Web             | implemented — auth, dashboard, farms, climate outlook, crop catalog                                                                                                                           |
| Agronomy engine | implemented as a package — suitability, constraints, verdicts; not yet wired into the API or worker; planting-window generation and persistence are not built                                 |
| Providers       | adapters and normalisation exist; every real ingestion is refused until the grid is validated (`OPEN-18`) and licensing is settled (`OPEN-03`)                                                |
| AI briefing     | not implemented — the contract and hash exist, the pipeline does not (`OPEN-11`)                                                                                                              |

Next: the remaining Phase 9 items split into work that can be done now
(observability metrics, security review, documentation, forecast verification
harness) and work that waits on an owner decision (hosting, backup strategy,
deployment, provider licensing).

## Layout

```
apps/web        React + Vite frontend (auth, dashboard, farms, climate, crop catalog)
apps/api        NestJS + Express HTTP API (health, auth, farms, fields, crops, climate)
apps/worker     background worker: queue runner, ingestion handlers, job CLI
packages/contracts  Zod schemas, inferred types, provenance contract, canonical ordering
packages/database   Prisma client, hand-written SQL migrations, role bootstrap, RLS and privilege verification
packages/climate-core  climate periods, aggregation, beyond-horizon rules
packages/weather-core  provider adapters, normalisation, grid registry
packages/agronomy      suitability engine, constraints, verdicts
docs/           research, architecture, ADRs, guides, reviews — normative
```

`docs/architecture/provenance-contract.md` is the authority on provenance
semantics. `docs/data-model/README.md` is the authority on physical storage.
`docs/architecture/system-architecture.md` §3 states the package boundaries and
the dependency direction between them.

## Commands

```bash
pnpm install
pnpm build       # turbo, topological
pnpm typecheck
pnpm lint
pnpm test
pnpm dev         # web + API together, watching

pnpm db:up       # postgres 18 + postgis 3.6 on 127.0.0.1:5442
pnpm db:bootstrap   # create the four roles; superuser, run once per cluster
pnpm db:migrate     # prisma migrate deploy — the only apply path
pnpm db:status
pnpm db:verify      # migration digests, then the privilege boundary, against the real roles
pnpm db:verify:probes
pnpm test:rls       # tenant isolation, as app_api through withTenant
```

Per-package work, integration suites and the worker's separate startup are covered
in `docs/guides/development.md`; a clone-to-running walkthrough with the exact
failure messages is `docs/guides/installation.md`.

`pnpm dev` builds once, then runs every `dev` script in the workspace: the
`contracts` and `weather-core` compilers, the API compiler, the API process
(`node --watch dist/main.js`), and Vite. The API listens on `PORT` and the
web app on `127.0.0.1:5173`; Vite proxies `/v1` to the API, so the browser talks to
one origin and no CORS response is involved. The web app refuses to start if 5173
is taken rather than moving to another port, which the API's origin allowlist would
reject on the first state-changing request.

Both processes read the repository-root local environment file: the API through
`loadLocalEnv`, which never overrides a variable that is already set, and Vite
through `loadEnv`, which uses it only to know the API's port. In production there
is no such file and the environment supplies every variable.

`packages/contracts` must build before any app can import it; `turbo` handles the
ordering through `dependsOn: ["^build"]`.

Migrations are **hand-written SQL** and `prisma migrate dev` is never used: it
cannot diff a schema that contains PostGIS's own objects. `schema.prisma` is kept
in sync with the migrations by hand.

## Documentation

| Question                          | Document                                |
| --------------------------------- | --------------------------------------- |
| Install, run, verify              | `docs/guides/installation.md`           |
| Daily workflow, tests, migrations | `docs/guides/development.md`            |
| Every environment variable        | `docs/guides/environment-variables.md`  |
| Phase state and open work         | `docs/IMPLEMENTATION_MASTER_ROADMAP.md` |
| Decisions and their owners        | `docs/OWNER_DECISIONS.md`               |
| Data model                        | `docs/data-model/`                      |
| Queue and ingestion operations    | `docs/operations/climate-ingestion.md`  |
| Dump and restore                  | `docs/operations/backup-restore.md`     |
| Migration integrity and reversal  | `docs/operations/migration-rollback.md` |

## Pinned versions

Node `>=24.14.0`, pnpm `12.18.0` (via `packageManager`), TypeScript `5.9.3`,
NestJS `12.5.1`, zod `4.6.7`, Vite `8.3.8`, Vitest `5.1.0`, Turborepo `2.11.12`,
Prisma `7.10.1` with `@prisma/adapter-pg`, PostgreSQL `18` + PostGIS `3.6`.
Versions live in the `catalog:` block of `pnpm-workspace.yaml`; no floating
ranges anywhere.

TypeScript is pinned to 5.9 deliberately: NestJS relies on
`experimentalDecorators` + `emitDecoratorMetadata`, which TS 7 (the native
compiler) does not yet cover.

## Contract rules that are enforced, not documented

- `packages/contracts` is the only place a hash descriptor or canonical
  serialisation may be defined.
- Array ordering and deduplication live in `src/canonical.ts` and are applied by
  the canonicaliser, never by callers.
- A duplicate identity with conflicting content throws; it is never resolved
  silently.
- `FieldSnapshotPayload` is the hash preimage and cannot contain
  `fieldSnapshotHash` — the schema is strict, so the field is rejected.
