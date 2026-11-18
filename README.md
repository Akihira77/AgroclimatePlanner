# Agroclimate Planner

AI-assisted agricultural weather and climate planning for Indonesia. Twelve-month
rolling outlook, crop planting windows, calendar UI, and an AI analyst.

This repository is at **Phase 2.0** — monorepo foundation and shared contracts
only. No weather provider, database, queue, or agronomy engine is implemented yet.

## Layout

```
apps/web        React + Vite frontend (scaffold)
apps/api        NestJS + Express HTTP API (health endpoint only)
apps/worker     background worker process (no queues yet)
packages/contracts  Zod schemas, inferred types, provenance contract, canonical ordering
docs/           research, architecture, ADRs, reviews — normative
```

`docs/architecture/provenance-contract.md` is the authority on provenance
semantics. `docs/architecture/system-architecture.md` §3 lists the packages that
future phases add and the dependency direction between them.

## Commands

```bash
pnpm install
pnpm build       # turbo, topological
pnpm typecheck
pnpm lint
pnpm test
pnpm dev
```

`packages/contracts` must build before any app can import it; `turbo` handles the
ordering through `dependsOn: ["^build"]`.

## Pinned versions

Node `>=24.14.0`, pnpm `12.18.0` (via `packageManager`), TypeScript `5.9.3`,
NestJS `12.5.1`, zod `4.6.7`, Vite `8.3.8`, Vitest `5.1.0`, Turborepo `2.11.12`.
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
