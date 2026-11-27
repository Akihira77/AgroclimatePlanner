# Development

The working model, the commands, and the traps. Installation is
`docs/guides/installation.md`; this page assumes the stack already runs.

---

## 1. What the code is made of

```
apps/web        React + Vite. Screens: auth, dashboard, farms, climate, crop catalog.
apps/api        NestJS + Express, prefix /v1 except /health. Role: app_api.
apps/worker     Job runner and queue. Role: app_system. No HTTP server.
packages/contracts     Zod schemas and inferred types. The only place a shared shape is defined.
packages/database      Prisma client, hand-written SQL migrations, bootstrap and verification scripts.
packages/climate-core  Climate periods, aggregation, beyond-horizon rules.
packages/weather-core  Provider adapters, normalization, grid registry.
packages/agronomy      Suitability engine, constraints, verdicts.
```

Dependency direction, as the `package.json` files have it: `contracts` is the leaf;
`database`, `climate-core` and `weather-core` depend on it; `agronomy` depends on
`contracts` alone and is not yet imported by any application. The API and the worker
each depend on the packages they use. An app never imports another app.

Two consequences that shape how you work:

- **Packages are consumed from `dist`.** Changing `packages/contracts` has no
  effect on a manually started `node dist/main.js` until it is rebuilt. `pnpm build`
  through Turborepo handles the order (`dependsOn: ["^build"]`), and `pnpm dev` also
  runs the `contracts` and `weather-core` watchers, so the build is not stale — but a
  process that was never restart-aware will still be serving the old import.
- **`packages/contracts` is the authority.** A request or response shape is defined
  there once and inferred everywhere else. A local interface that mirrors a
  contract type is a second definition waiting to disagree.

---

## 2. Commands

Root scripts delegate to packages through Turborepo or pnpm filters.

| Command | Effect |
|---|---|
| `pnpm build` | topological build of every package |
| `pnpm typecheck` | `tsc --noEmit` per package, after dependencies build |
| `pnpm lint` | ESLint per package |
| `pnpm test` | every package's default suite, `--concurrency=1` |
| `pnpm format` / `pnpm format:check` | Prettier write / verify |
| `pnpm dev` | build once, then run every workspace `dev` script (contracts, weather-core, API compiler, API process, Vite) |
| `pnpm db:up` / `pnpm db:down` | Compose start (waiting for health) / stop |
| `pnpm db:reset` | destroy volume, recreate, bootstrap, migrate — deletes data |
| `pnpm db:bootstrap` | create roles and schema, once per cluster |
| `pnpm db:migrate` | `prisma migrate deploy` — the only apply path |
| `pnpm db:status` | `prisma migrate status` |
| `pnpm db:verify` | migration digests, then the privilege boundary |
| `pnpm db:verify:probes` | verification suite cannot be fooled by a probe schema |
| `pnpm test:rls` | tenant isolation through `withTenant` as `app_api` |

Per-package work is a filter away:

```bash
pnpm --filter @agroclimate/api dev             # tsc --watch
pnpm --filter @agroclimate/api dev:serve       # node --watch dist/main.js
pnpm --filter @agroclimate/database db:studio
pnpm --filter @agroclimate/worker cancel:job <jobId>
```

`pnpm dev` does not start the worker; it needs `APP_SYSTEM_DATABASE_URL` and has no
scheduler. See `docs/operations/climate-ingestion.md` §1.

---

## 3. Tests

Suites are split by what they need, so a fast loop is possible without a database.

| Where | Runner | Needs |
|---|---|---|
| `packages/{contracts,agronomy,climate-core,weather-core}/src/**/*.test.ts` | Vitest | nothing |
| `packages/database/test/unit` | `node --test` | nothing |
| `packages/database/test/{rls,schema,integration}` | `node --test` | the database |
| `apps/api/test/*.test.mjs` | `node --test` | nothing (database doubles are passed to the app factory) |
| `apps/api/test/integration` | `node --test` | the database |
| `apps/worker/test/unit` | `node --test` | nothing |
| `apps/worker/test/integration` | `node --test` | the database |
| `apps/web` | none | — |

`apps/web` has no test runner and none is planned; its logic lives in contracts and
the API. Everything else runs with `--test-concurrency=1` or a single Vitest fork
because a WSL2 box will otherwise exhaust memory before it reports a real failure.

The `node:test` suites build first (`pnpm build && node --test …`) because they
import `dist`, not sources. A stale build therefore tests stale code; when a test
result does not match the file you just edited, rebuild before believing either.

### The typecheck trap

`pnpm --filter <pkg> typecheck` reports `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` and
can bury the compiler's own output. Run the compiler directly inside the package:

```bash
cd apps/api && npx tsc -p tsconfig.json --noEmit
```

---

## 4. Changing the database

Migrations are hand-written SQL in `packages/database/prisma/migrations/<timestamp>_<name>/migration.sql`.
`schema.prisma` is kept in sync by hand and is never the source of a migration:
`prisma migrate dev` cannot diff a schema that contains PostGIS's own objects.

The rules that matter:

1. **Never edit an applied migration.** `prisma migrate deploy` will not notice —
   measured: an edited file still reports "No pending migrations" and
   "Database schema is up to date". `pnpm db:verify` is what notices.
2. **Reverse with a new migration.** There are no down migrations and none will be
   added. `docs/operations/migration-rollback.md` covers the three tiers (new
   migration, dump restore, never-edit) and the expand/contract order for changing
   a live shape.
3. **Add the RLS policy with the table.** A tenant-owned table without a forced
   policy passes every unit test and fails `pnpm test:rls`; that is the point of
   the suite.
4. **Re-run `pnpm db:verify` after a migration.** It checks the digest of what you
   wrote and the grants the app roles end up with.

---

## 5. Environment loading in development

`apps/api`, the database scripts and the Prisma CLI read the repository-root `.env`.
Turbo runs each package from its own directory, which is why the API resolves the
file from its own location rather than `cwd`, and why a bare
`node apps/api/dist/main.js` from the root still finds it.

`loadLocalEnv` only fills variables that are not already set, so an exported value
always wins and `.env` never silently overrides a deployment. The worker reads
nothing but `process.env` and requires an explicit URL.

Full list: `docs/guides/environment-variables.md`.

---

## 6. Before you call it done

The same order the repository's own verification uses, cheapest first:

```bash
pnpm format:check
pnpm typecheck
pnpm lint
pnpm build
pnpm test
pnpm db:verify
```

Reasons for the order: formatting and types reject the most mistakes per second;
build must precede test because tests import `dist`; `db:verify` needs a database
and is therefore last. A change that touches migrations or grants is not verified
until `db:verify` has run against a real database, because both checks are about
what PostgreSQL holds, not what the TypeScript says.

Docs are part of the change. A claim in `docs/` that the code no longer supports is
a defect; a limitation discovered while working belongs next to the feature, not in
a review thread.

---

## 7. Where to read next

| Question | Document |
|---|---|
| Why the schema is shaped this way | `docs/data-model/` |
| What provenance means and how hashes are derived | `docs/architecture/provenance-contract.md` |
| How the queue and ingestion work | `docs/architecture/background-processing.md`, `docs/operations/climate-ingestion.md` |
| How to roll a migration back | `docs/operations/migration-rollback.md` |
| How to dump and restore | `docs/operations/backup-restore.md` |
| What is decided and by whom | `docs/OWNER_DECISIONS.md` |
| What phase we are in and what is still open | `docs/IMPLEMENTATION_MASTER_ROADMAP.md` |
