# Agroclimate Planner

AI-assisted agricultural weather and climate planning for Indonesia. Twelve-month
rolling outlook, crop planting windows, calendar UI, and an AI analyst.

This repository is at **Phase 3 complete** — monorepo foundation, shared
contracts, and the full PostgreSQL/PostGIS schema. Nothing agricultural is
implemented yet: no weather ingestion, no agronomy evaluation, and no user-facing
workflow.

| Layer                                           | State                                                                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Monorepo                                        | implemented — pnpm workspaces + Turborepo, three applications and two shared packages, pinned versions                                    |
| Contracts                                       | implemented — Zod schemas, provenance contract, canonical serialisation, SHA-256 golden vectors                                           |
| Database                                        | implemented — 22 domain tables in schema `app`, RLS forced on every tenant-owned table, three explicit roles, hand-written SQL migrations |
| API                                             | scaffold only — one health endpoint, no authentication, no domain routes                                                                  |
| Worker                                          | scaffold only — process starts, no queue, no job                                                                                          |
| Web                                             | scaffold only — Vite React shell, no screens                                                                                              |
| Weather ingestion, agronomy engine, AI briefing | not implemented — their tables exist and are documented, the code does not                                                                |

Next milestone: the authentication slice (`OPEN-01` — nothing can read a
credential before a tenant context exists), then the first ingest (`OPEN-18` —
the per-model `cell_key` rounding rule).

## Layout

```
apps/web        React + Vite frontend (scaffold)
apps/api        NestJS + Express HTTP API (health endpoint only)
apps/worker     background worker process (no queues yet)
packages/contracts  Zod schemas, inferred types, provenance contract, canonical ordering
packages/database   Prisma client, hand-written SQL migrations, role bootstrap, RLS and privilege verification
docs/           research, architecture, ADRs, reviews — normative
```

`docs/architecture/provenance-contract.md` is the authority on provenance
semantics. `docs/data-model/README.md` is the authority on physical storage.
`docs/architecture/system-architecture.md` §3 lists the packages that future
phases add and the dependency direction between them.

## Commands

```bash
pnpm install
pnpm build       # turbo, topological
pnpm typecheck
pnpm lint
pnpm test
pnpm dev

pnpm db:up       # postgres 18 + postgis 3.6 on 127.0.0.1:5442
pnpm db:bootstrap   # create the three roles; superuser, run once per cluster
pnpm db:migrate     # prisma migrate deploy — the only apply path
pnpm db:status
pnpm db:verify      # privilege boundary, against the real roles
pnpm test:rls       # tenant isolation, as app_api through withTenant
```

`packages/contracts` must build before any app can import it; `turbo` handles the
ordering through `dependsOn: ["^build"]`.

Migrations are **hand-written SQL** and `prisma migrate dev` is never used: it
cannot diff a schema that contains PostGIS's own objects. `schema.prisma` is kept
in sync with the migrations by hand.

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
