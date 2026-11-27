# Environment variables

Every variable below is read by code in this repository. The columns say who reads
it, what development falls back to, and whether production may omit it — because a
default that is convenient locally is often a credential nobody should be able to
guess.

Two rules hold for all of them:

- **A value that fails validation stops the process.** `parseRuntimeConfig` and the
  database scripts throw at startup rather than serving a wrong database or role.
  Free-text variables (attribution strings) have no domain to violate.
- **A credential or a numeric value is never echoed.** Errors name the variable, not
  its content; a rejected connection string would print its password. Configuration
  entries that are not secrets — a rejected `CORS_ORIGINS` entry, a refused
  `TRUST_PROXY` token — are quoted, because the operator needs to see which one.

Where a process reads its environment:

| Process | Loads the repository-root `.env`? | How |
|---|---|---|
| API | yes | `loadLocalEnv` in `apps/api/src/main.ts`; it fills only variables that are not already set, so an exported value always wins |
| Worker | **no** | `apps/worker/src/main.ts` reads `process.env` directly and exits with `config_error` if `APP_SYSTEM_DATABASE_URL` is absent |
| Web dev server | partially | `loadEnv(mode, root, "PORT")` in `apps/web/vite.config.ts` reads only `PORT`, to point the `/v1` proxy at the API |
| Database scripts | yes | `process.loadEnvFile` in `packages/database/scripts/lib/connections.mjs` |
| Prisma CLI | yes | `packages/database/prisma.config.ts`, same file and same precedence |
| Docker Compose | yes, implicitly | `docker-compose.yml` |

`.env.example` is the development minimum, not the full list. Everything with a
development fallback is derived and can be omitted locally; everything marked
"required in production" has no safe default and must be set.

---

## 1. Database location

| Variable | Read by | Development default | Production |
|---|---|---|---|
| `POSTGRES_HOST` | API, database scripts, Prisma config | `127.0.0.1` | optional |
| `POSTGRES_PORT` | same | `5442` | optional |
| `POSTGRES_DB` | same | `agroclimate` | optional |
| `POSTGRES_USER` | Compose init, bootstrap admin | `agroclimate` | Compose only |
| `POSTGRES_PASSWORD` | Compose init, bootstrap admin | template placeholder | Compose only |
| `DB_CONTAINER_NAME` | Compose only | `agroclimate-db` | not used |
| `BOOTSTRAP_DATABASE_URL` | `db:bootstrap` | derived from the admin values above | **required** |
| `MIGRATION_DATABASE_URL` | `prisma migrate deploy` | derived as `migration_owner` | **required** |

`BOOTSTRAP_DATABASE_URL` is a cluster-admin connection: it creates roles, so there
is no localhost guess outside development. `MIGRATION_DATABASE_URL` is the schema
owner; it is the credential `migrate deploy` and the migration-integrity check use,
and it is deliberately never offered to the API or the worker.

Port `5442` is not a typo: the development host may already run PostgreSQL on
`5432`, and a silently wrong database is worse than an unusual port.

---

## 2. Role credentials

Four roles exist, each with one job (`docs/data-model/README.md`). A connection URL
wins outright; otherwise development derives one from the password variable. Only
development derives anything.

| Role | URL variable | Password variable | Derivation in development |
|---|---|---|---|
| `app_api` | `APP_API_DATABASE_URL` | `APP_API_PASSWORD` | yes — the tenant-facing runtime identity |
| `app_auth` | `APP_AUTH_DATABASE_URL` | `APP_AUTH_PASSWORD` | yes — falls back to the placeholder `app_auth_dev` |
| `app_system` | `APP_SYSTEM_DATABASE_URL` | `APP_SYSTEM_PASSWORD` | **no** — the worker must be handed the URL |
| `migration_owner` | `MIGRATION_DATABASE_URL` | `MIGRATION_OWNER_PASSWORD` | yes — for the Prisma CLI only |

The API validates the **role name** in its URLs and refuses to boot otherwise:

- `APP_API_DATABASE_URL` must connect as `app_api`; `migration_owner`, `app_system`,
  `app_auth` and `postgres` are rejected by name, and any other unrecognised role is
  rejected too. The username is percent-decoded first, so `app%5Fapi` is the same
  role and is accepted as such.
- `APP_AUTH_DATABASE_URL` must connect as `app_auth`, with the symmetric refusal.

The separation is the point. `app_api` is the role the RLS policies and column
grants are written against; a tenant-facing process connected as `app_system`
(`BYPASSRLS`) would look like a working system while serving every tenant's rows.

The worker is the exception that proves the rule: it needs `app_system`, and
`apps/worker/src/main.ts` requires an explicit URL rather than deriving one from a
password. To start the worker locally, supply the URL from a place that is not your
shell history — a command line containing a password is written to history and
visible in the process list:

```bash
read -rs APP_SYSTEM_PASSWORD          # type it; it is not echoed
export APP_SYSTEM_DATABASE_URL="postgresql://app_system:${APP_SYSTEM_PASSWORD}@127.0.0.1:5442/agroclimate?schema=app"
unset APP_SYSTEM_PASSWORD
pnpm --filter @agroclimate/worker start
```

`unset` matters: without it the password stays in that shell. The exported URL
still contains it, and it is readable from the process environment while the worker
runs — inherent to a process that must hold a connection string, and the reason the
worker runs as its own role rather than beside the API.

The password is the one `db:bootstrap` created for `app_system`; it is never
printed by the bootstrap script, so it comes from wherever the operator recorded
it. See `docs/operations/climate-ingestion.md` §1.

---

## 3. API runtime

| Variable | Default | Validation |
|---|---|---|
| `NODE_ENV` | `development` | `development`, `test`, `production`; anything else stops the boot |
| `PORT` | `3000` | integer 1–65535 |
| `CORS_ORIGINS` | `http://localhost:5173` | comma-separated bare origins, `http(s)` only; `*`, paths and trailing slashes are refused; **required in production** |
| `TRUST_PROXY` | `false` | `false`, or a comma-separated list of `loopback`, `linklocal`, `uniquelocal` and CIDRs; `true` is refused |
| `TRUST_REQUEST_ID_HEADER` | `false` | `true` or `false` |

`TRUST_PROXY=true` is refused because Express would then trust an
`X-Forwarded-For` header written by any caller, letting a client choose the address
the login rate limiter counts against. Name the proxy instead.

`TRUST_REQUEST_ID_HEADER` defaults off: request IDs are generated server-side, and
accepting a caller-supplied UUID is a deliberate opt-in for a deployment that already
has a trusted edge.

In development, CORS is not actually exercised by the browser: Vite proxies `/v1`
to the API so both sides share one origin. The allowlist matters when the two are
served apart.

### Argon2id cost

`ARGON2_MEMORY_KIB` (8–1 048 576), `ARGON2_TIME_COST` (1–10) and
`ARGON2_PARALLELISM` (1–255) override the provisional baseline of 19 456 KiB,
2 passes, 1 thread. They exist so a benchmark can move the numbers without a code
change; the baseline is recorded in `IG-6` and is not a final decision. Invalid
values name the variable and the accepted range, never the value.

Values are validated only when the API boots. A password-hash verification that
used different parameters than the endpoint would fail to verify, which is why both
read the same `RuntimeConfig`.

The accepted ranges are the library's bounds, not a recommendation: the lower end
(8 KiB, one pass) is far below any defensible production cost. Moving the baseline
is a decision backed by a measurement, not a way to make a slow machine boot.

---

## 4. Worker

| Variable | Default | Effect |
|---|---|---|
| `APP_SYSTEM_DATABASE_URL` | none | required; the worker exits with a `config_error` JSON line if it is absent |
| `ERA5_ATTRIBUTION` | `Contains modified Copernicus Climate Change Service information (2026)` | provenance string stored with climatology |
| `ECMWF_ATTRIBUTION` | `Open-Meteo.com (CC BY 4.0); ECMWF (CC BY 4.0)` | provenance for seasonal data |
| `OPEN_METEO_ATTRIBUTION` | `Open-Meteo.com (CC BY 4.0)` | provenance for forecast data |

Attribution is provenance, not a licence decision. `OPEN-03` still governs whether
commercial ingestion may run at all; changing a string does not change that.

---

## 5. Web build

| Variable | Default | Effect |
|---|---|---|
| `VITE_API_BASE_URL` | `/v1` in dev, `http://localhost:3000/v1` in a production build | absolute API base when the app and API are served from different origins |

Vite inlines `VITE_*` values into the bundle at build time: they are public. Never
put a secret in one.

Pointing this at another origin has two consequences that the browser enforces, not
this repository. The origin must also appear in `CORS_ORIGINS`, and the session
cookie is `__Host-agroclimate_session` with `Secure`, `Path=/`, no `Domain` and
`SameSite=Lax` — so a different **site** receives it only on a top-level navigation
to its own host, never on a cross-site `fetch`. Serving the two from one origin (the
Vite proxy does this in development) is the arrangement that exists; a split
deployment needs a decision about a same-site hostname, TLS, and the proxy that
presents it.

---

## 6. What a value is never used for

- The API never reads `MIGRATION_DATABASE_URL`, and never falls back to it. A
  fallback would hand the tenant-facing process a schema-owner credential.
- The API never derives `app_system` or accepts it as a runtime role.
- Error messages name the variable, not its value. A rejected URL prints that the
  URL is invalid, never the URL.
- No secret belongs in a log line, a job payload or a document in this repository.
