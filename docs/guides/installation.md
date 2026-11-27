# Installation

Getting a working development instance from a clone. Every command below is one
this repository defines; where a step has a prerequisite, it says so instead of
assuming it.

**Scope:** a local machine with Docker. There is no production installation
procedure yet — no hosting decision, no production Dockerfiles, no TLS. See
`docs/IMPLEMENTATION_MASTER_ROADMAP.md` §13.7 for what that still needs.

---

## 1. Prerequisites

| Requirement | Version | Why |
|---|---|---|
| Node.js | `>= 24.14.0` | `engines` in the root `package.json`; the API and worker run ESM TypeScript output |
| pnpm | `12.18.0` | pinned by `packageManager`; Corepack installs it |
| Docker with Compose v2 | any current release | the development database runs as a container |
| Free ports | `5442`, `3000`, `5173` | database, API, web dev server; `PORT` and `WEB_PORT` move the last two, and a moved web port must also be added to `CORS_ORIGINS` |

```bash
corepack enable      # makes `pnpm` resolve the pinned version
node --version       # must be 24.14.0 or newer
docker info >/dev/null && echo "docker ok"
```

`5442` is deliberate: an existing PostgreSQL on `5432` must not be mistaken for
this project's database.

---

## 2. Install dependencies

```bash
pnpm install
```

Prisma and `@prisma/engines` are the only dependencies allowed to run build
scripts (`allowBuilds` in `pnpm-workspace.yaml`); pnpm 12 blocks the rest by
default. A warning about ignored scripts for any other package is expected.

Nothing resolves `@agroclimate/*` from source: the packages are consumed from
`dist`, which is why the next step is a build and not `pnpm dev`.

---

## 3. Configure the environment

```bash
cp .env.example .env
```

`.env.example` holds the development minimum: `NODE_ENV`, the database location and
admin credentials, the four role passwords, and an explicit `APP_AUTH_DATABASE_URL`
that wins over the derived one. Everything else has a development fallback and can
be left out. `docs/guides/environment-variables.md` lists every variable with its
reader, default and production requirement.

Never commit `.env`; it is ignored, and it holds credentials.

---

## 4. Create the database

```bash
pnpm db:up
```

Starts `postgis/postgis:18-3.6` as container `agroclimate-db` on
`127.0.0.1:5442`, loopback only, with a health check that `db:up` waits for. The
data lives in the `db-data` volume.

```bash
pnpm db:bootstrap
```

Creates the four roles (`migration_owner`, `app_api`, `app_system`, `app_auth`) and
the `app` schema. It is a cluster-level action and runs once per cluster; running it
again re-applies the same passwords — it is idempotent — and creates nothing new. It
does not apply migrations. It prints the role names and never a password.

Outside development, `BOOTSTRAP_DATABASE_URL` is required; there is no localhost
fallback for a credential that can create roles.

```bash
pnpm db:migrate
```

Runs `prisma migrate deploy` — the only apply path. Migrations are hand-written SQL
and `prisma migrate dev` is never used: it cannot diff a schema containing
PostGIS's own objects. Twelve migrations exist as of 2026-11-28.

```bash
pnpm db:verify
```

Two checks, in order:

1. **Migration integrity** — each `migration.sql` is hashed and compared with the
   digest Prisma recorded. A mismatch means an applied migration was edited.
2. **Privilege boundary** — run against the real roles: RLS is forced on every
   tenant-owned table, `app_api` cannot write reference data or read the migration
   ledger, and the role separation is what the design says it is.

Exit 0 means the files and the ledger agree and the grants hold. It does **not**
mean the schema is current (`db:migrate` is its own step) and it does not detect
drift. `pnpm db:verify:probes` additionally checks that the verification scripts
cannot be fooled by a probe created in a schema the role controls.

---

## 5. Build and test

```bash
pnpm build
pnpm test
```

Turborepo builds in dependency order: `contracts` first, then the packages that
depend on it, then the applications. `pnpm test` runs every package's default suite
with `--concurrency=1`, which keeps a WSL2 box from exhausting RAM.

Integration suites need the database and are separate:

```bash
pnpm --filter @agroclimate/database test:rls
pnpm --filter @agroclimate/database test:schema
pnpm --filter @agroclimate/database test:integration
pnpm --filter @agroclimate/api test:integration
pnpm --filter @agroclimate/worker test:integration
```

They are not part of `pnpm test` because every case opens a real connection and a
full run is slow by nature, not by accident.

---

## 6. Run the applications

```bash
pnpm dev
```

Builds once, then runs every `dev` script in the workspace: the `contracts` and
`weather-core` compilers, the API compiler, the API process
(`node --watch dist/main.js`), and Vite. The API listens on `PORT` (default `3000`)
and the web app on `127.0.0.1:5173` (`WEB_PORT`). Vite proxies `/v1` to the API, so
the browser talks to one origin and the session cookie is same-site.

The web dev server uses `strictPort`: an occupied port is a startup failure rather
than a move to the next one, because the API's origin allowlist would refuse the new
port on the first state-changing request. Moving the dev server is therefore two
variables that must agree:

```bash
PORT=3010 WEB_PORT=5174 \
CORS_ORIGINS='http://localhost:5174,http://127.0.0.1:5174' \
  node apps/api/dist/main.js            # terminal 1
PORT=3010 WEB_PORT=5174 \
  pnpm --filter @agroclimate/web dev    # terminal 2
```

Both hostnames are listed because the browser sends whichever one was typed, and an
allowlist entry is an exact match: opening `127.0.0.1:5174` while the list names
`localhost:5174` loads the page and refuses every write with `403 FORBIDDEN`. The
API log line names the origin it refused, so the mismatch is visible there rather
than only in the browser's network tab.

Verify the API:

```bash
curl -s http://127.0.0.1:3000/health          # liveness; touches nothing
curl -s http://127.0.0.1:3000/health/ready    # readiness; SELECT 1 within a 2 s budget
```

`/health` answers even when the database is down; `/health/ready` is the probe that
should gate traffic. Neither is under `/v1`.

### The worker is separate

`pnpm dev` does not start it. It is a process with a different credential and no
scheduler. It requires `APP_SYSTEM_DATABASE_URL`, and it must be supplied without
putting the password on a command line:

```bash
read -rs APP_SYSTEM_PASSWORD
export APP_SYSTEM_DATABASE_URL="postgresql://app_system:${APP_SYSTEM_PASSWORD}@127.0.0.1:5442/agroclimate?schema=app"
unset APP_SYSTEM_PASSWORD
pnpm --filter @agroclimate/worker start
```

`docs/guides/environment-variables.md` §2 explains the credential and why the worker
is the one process that does not derive it.

Startup writes one JSON line naming the registered handlers. No handler is a wiring
bug, not a configuration choice: a job whose kind is unregistered is never claimed.
Nothing enqueues work on a schedule — see `docs/operations/climate-ingestion.md`.

---

## 7. A fresh database, deliberately

```bash
pnpm db:reset
```

Destroys the volume, recreates the container, bootstraps roles and applies every
migration. It is the only supported way to replay from zero, and it deletes data
without asking. Use it when you mean it.

---

## 8. If something fails

| Symptom | Cause | Remedy |
|---|---|---|
| `APP_API_DATABASE_URL must connect as app_api; migration_owner is not a runtime identity` | a credential for the wrong role was supplied | point the variable at `app_api`; do not relax the check |
| `APP_API_PASSWORD is required to derive the development database URL` | `.env` is missing or `NODE_ENV` is not `development` | copy `.env.example`, or supply `APP_API_DATABASE_URL` |
| `CORS_ORIGINS is required in production` | `NODE_ENV=production` without an allowlist | name the origins; `*` is refused |
| `TRUST_PROXY=true is refused` | Express would let any caller choose its own client IP | name the proxy hosts or CIDRs |
| `role "app_api" does not exist` | the database volume exists but was never bootstrapped, or was recreated | `pnpm db:bootstrap` |
| Prisma `P3009` — failed migrations in the target database | a migration failed and `deploy` will not proceed | read `docs/operations/migration-rollback.md`; resolve the row deliberately, never edit the file |
| `ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL` with no compiler error shown | pnpm's wrapper hides the inner exit | run the package script directly, e.g. `cd apps/api && npx tsc -p tsconfig.json --noEmit` |
| Port 5173 in use | `strictPort` by design | set `WEB_PORT` to a free port **and** add that origin to `CORS_ORIGINS`; a moved port alone fails on the first `POST` |
| `403 FORBIDDEN` on every write, reads fine | the browser's `Origin` is not in `CORS_ORIGINS` — usually `127.0.0.1` vs `localhost`, or a moved `WEB_PORT` | add the exact origin you typed; the API logs which one it refused |
| Worker exits with `config_error` | `APP_SYSTEM_DATABASE_URL` is unset | export it (see §6) |

---

## 9. What an installation does not include

Installed is not finished. These are absent by decision, not by omission:

- **No catalog rows yet.** The tables exist and the seed ships with the repository:
  run `pnpm db:seed:catalog` to insert the four v1 crops. An installation that skips
  it has working screens with empty states, not broken ones. Field-to-snapshot
  mapping (`OPEN-21`) is still open, so a seeded catalogue still cannot judge a
  field.
- **No validated provider grid.** `ingest.forecast` is registered, and every real
  job dies with `grid_not_validated` before a provider is called (`OPEN-18`).
- **No scheduler.** A job runs only because something inserted it.
- **No AI briefing.** The contract and hash exist; the pipeline does not (`OPEN-11`).
- **No production configuration.** No production Dockerfiles, reverse proxy, TLS,
  or deployment procedure.
