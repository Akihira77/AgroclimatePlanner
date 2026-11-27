# Security review

A review of what this repository enforces, what was checked rather than assumed,
and what cannot be established before there is a deployment. It covers the
fourteen entries in `docs/IMPLEMENTATION_MASTER_ROADMAP.md` §13.5 and is the
`Security documentation` entry in §13.8.

The rule this document follows: a control counts as present only if code enforces
it and a test or a measurement contradicts the claim that it does not. A control
that exists but was not exercised is marked `implemented, unexercised`. A control
that belongs to hosting is marked `not ours to verify`.

Read this as a starting point for an external review, not as a substitute for
one. No penetration test has been performed, and the reviewers so far have been
read-only: a documentation audit, a secrets and trust-boundary audit, and the
migration and failure-path reviews recorded in `docs/IMPLEMENTATION_STATUS.md`.

## 1. Authentication and session lifecycle

**Implemented.** `ADR-004` (credential boundary), `ADR-005` (storage), `ADR-006`
(transport and CSRF).

- Credentials live behind `app_auth`, a role with no access outside the
  authentication tables. `apps/api/src/auth/auth.service.ts` is the only caller.
- Passwords are Argon2id, parameters from `RuntimeConfig`, `19456 KiB` / `2`
  passes / `1` lane by default. Registration and verification read the same
  config, so a hash cannot be produced with parameters that the verifier will not
  reproduce.
- A session token is 32 random bytes, stored as a hash; the row never holds the
  bearer value.
- Two deadlines, both in the row: 30 days sliding, 90 days absolute, with the
  cookie's `expires` set to the `LEAST(...)` of them. The guard never computes a
  deadline of its own, so a cookie cannot outlive the session it names.
- The sliding deadline is extended at most once per 5 minutes, by the statement
  that owns it, not by the guard.
- Revocation sets `revoked_at`. No runtime role holds `DELETE` on `app.sessions`,
  so the row survives the revocation and remains the evidence that the session
  existed.
- `DELETE`-free session handling and a `NOLOGIN`-by-default role set mean a leaked
  connection string cannot rewrite that history.

**Caveats, stated rather than implied.**

- There is no password reset, no MFA, and no account deletion (`OPEN-04`). Each
  is an absent feature, not a bypass: none of them has a half-built path to
  attack.
- Registration discloses whether an address exists, through `409`. That was
  accepted (`IG-2`): the alternative — hashing then claiming success — would let an
  address be unusable without its owner being told. The response carries no
  `details`, so nothing is disclosed beyond the status.
- Session cookies are not signed. `ADR-006` decided an opaque token stored as a
  hash is the whole check; a signature would be a second trust decision.
- There is no session inventory or "sign out everywhere" surface. Revocation is
  per token.

## 2. CSRF and Origin

**Implemented and exercised.** Live, on 2026-11-28: a `POST` with no `Origin`
answered `403 FORBIDDEN` in the standard envelope; with a trusted `Origin` and no
CSRF token it answered `403` after authentication.

- The requirement is derived from the HTTP method inside `AuthGuard`, not from a
  per-route annotation, so a route cannot be protected and forgetful at once.
- `Origin` is compared by exact set membership before the body is parsed. Missing
  is refused; `GET`/`HEAD`/`OPTIONS` pass; `Origin: null` cannot be configured
  because `CORS_ORIGINS` rejects any entry that is not its own `URL.origin`.
- Cookie attributes are `Secure`, `Path=/`, no `Domain`, `SameSite=Lax`,
  `HttpOnly`, with the `__Host-` prefix. There is no development variant that
  drops `Secure`.

**Caveats.** The CSRF token is minted once per session and never rotated. That is
a deliberate trade — a second tab keeps working — and the token is not readable
across sites because of `SameSite=Lax` plus `Origin`. A split deployment across
different sites would need `SameSite=None` and therefore a stronger discussion
than the current single-origin arrangement requires.

## 3. Tenant isolation

**Implemented and tested.** `ADR-003`, `docs/data-model/ownership-and-rls.md`.

- Every tenant-owned table has RLS **forced**, not merely enabled, so the table
  owner is not exempt.
- The tenant context is written with `set_config('app.user_id', …, true)` inside
  an interactive transaction, and the callback receives that transaction's client.
  A session-level setting on a pooled connection would become the next request's
  identity; `packages/database/src/tenant.ts` exists to make that impossible.
- Nested `withTenant` calls are refused rather than supported: an inner scope
  would open a second transaction with a different tenant, and with one pooled
  connection it would deadlock against its own caller.
- `set_config` is called through `$queryRaw`, not `$executeRaw`, so a context that
  failed to apply fails loudly instead of returning zero rows.
- The subject comes from the validated session and from nowhere else: no path,
  query or body field can name an owner.

**Verified by.** `pnpm test:rls`, 92 cases, all passing — cross-tenant reads and
writes refused per table, `app_system`'s `BYPASSRLS` exercised as a deliberate
exception. Run again on 2026-11-28.

## 4. Worker privileges

**Implemented.** `docs/architecture/background-processing.md`.

The worker is the one process that runs as `app_system`, which has `BYPASSRLS`.
That is not an oversight: a scheduled job has no requesting tenant, and a
per-tenant job must be able to reach the row that names it. The consequences are
contained by three properties:

- The worker has no HTTP surface. It is not reachable from outside the host.
- It holds one role, not the API's role, and that role cannot create roles,
  create databases or manage the cluster. It can bypass RLS, which is why the rest
  of this section exists.
- What it writes today is tenant-free. No job payload schema has a tenant field —
  `ingestionJobPayloadSchema`, `climatologyJobPayloadSchema` and the two outlook
  aggregations carry a run id, a baseline version or a cell selector — and the
  tables those handlers touch (`weather_records`, `outlook_cells`,
  `climatology_*`) have no owner column. The containment is therefore not "the
  tenant comes from the job row"; it is that `BYPASSRLS` grants nothing here
  because there is no tenant data in reach.

**What that means for a per-tenant job.** The day a job writes `farms`, `fields`
or any tenant table, this section's containment argument stops holding, and the
handler must take its tenant from the job row — which no payload currently
carries — or run inside the same `withTenant` scope the API uses. Neither exists
yet. The grant is correct for the work the worker does, and it is not a template
for work the worker has not been given.

**Unexercised.** There is no scheduler, so `reapExpired`, lease contention and
retry-exhaustion have been verified by test, not by a week of running. Their
behaviour is recorded in §13.6 and in the queue runbook.

## 5. Database grants

**Implemented and measured.** `packages/database/scripts/lib/privilege-verification.mjs`,
run by `pnpm db:verify`.

- Four roles with disjoint purposes: `migration_owner` (DDL), `app_api`
  (tenant-scoped DML through RLS), `app_auth` (credential tables only),
  `app_system` (worker).
- No runtime role holds `DELETE` on anything, nor `TRUNCATE`, nor `CREATE`. The
  right to bypass RLS is held by `app_system` alone. `app_auth` cannot `DELETE`
  from `app.sessions` or `app.users`, which is why revocation sets a column
  instead of removing a row.
- The verification is not a reading of the grant files: it connects as each role
  and asserts what that role can and cannot do, including that `app_api` is denied
  `SELECT count(*)` on the migration ledger and that the denial arrives as `42501`
  rather than as an empty result.

**Verified by.** `pnpm db:verify` on 2026-11-28, twice: twelve migrations match
their files before the revocation below, thirteen after, all privilege checks
passing both times.

**Finding, now closed: `DELETE` was granted where nothing needs it, and on eight
tables nothing scoped it.** This is recorded rather than deleted because the shape
of the mistake is the useful part. Seventeen tables carried `GRANT … DELETE` while
no runtime code issued a `DELETE` anywhere: the API soft-deletes, the worker
settles rows, and every test that removes a row does so as `migration_owner`.

The seventeen are not one case.

- **Nine are tenant tables**, granted to `app_api`: `app.farms`, `app.fields`,
  `app.field_outlook_cells`, `app.field_observations`, `app.plantings`,
  `app.harvests`, `app.suitability_runs`, `app.planting_windows`,
  `app.ai_briefings`. RLS is forced on each with a `FOR ALL` policy keyed on
  `app.user_id`, and `USING` applies to `DELETE`. That bounds an application bug,
  not a leaked credential: the tenant id the policy reads is set by whoever holds
  `app_api`, so a holder can name any tenant and delete its history. The policy is
  the reason a missing `WHERE` cannot cross tenants; it is not the reason a stolen
  connection string cannot.
- **Eight are global tables**, granted to `app_system`: `app.outlook_cells`,
  `app.forecast_runs`, `app.ingestion_runs`, `app.weather_records`,
  `app.monthly_outlooks`, `app.climatology_normals`, `app.climatology_baselines`,
  `app.jobs`. These have **no RLS at all** — deliberately, because they have no
  owner column and a policy would document a tenancy the data does not have —
  and `app_system` holds `BYPASSRLS` in any case. A leaked worker credential could
  therefore delete the weather plane and the entire job queue, which serve every
  tenant. That is the more damaging half of this finding, and it is not scoped by
  anything.

**Closed by** `20261128120000_revoke_runtime_delete`, which revokes `DELETE` from
both roles on all seventeen tables, plus three changes that had to land with it:
the expected matrix in `privilege-verification.mjs` no longer lists `DELETE`
anywhere, so the absence is asserted per table per role rather than assumed;
behavioural probes refuse a `DELETE` from `app_api` on a tenant table and from
`app_system` on all eight of its tables, because a catalogue check and a client's
experience are different guarantees; and the two RLS tests that observed `DELETE`
as "0 rows affected" now assert `42501`, which is a stronger claim — the privilege
does not exist, so no policy is consulted.

A fourth assertion guards the reason this finding was possible at all: every table
in schema `app` must appear in one of the matrix's class lists, so a table added
without a decision fails `db:verify` instead of silently escaping every assertion
below. It was checked by creating a stray table and watching the run fail.

Nothing depended on the grant: `purge_expired_sessions()` is `SECURITY DEFINER`
and needs only `EXECUTE`, tests delete as `migration_owner`, and there is no
`ON DELETE CASCADE` in the schema whose semantics a revocation would change. It
was held back from the review pass only because the revocation and the matrix had
to change together; they did.

**What this does not fix.** `app_system` still holds `BYPASSRLS`, so a leaked
worker credential can still read and overwrite the weather plane. Revocation
removed the irreversible half of the damage — history cannot be deleted — and left
the reversible half, which is what a backup and an audit trail are for.

**Caveat.** Exit 0 means the files, the ledger and the grants agree. It is not a
drift check and not a statement that the deployed schema is the one these files
describe; `prisma migrate status` is that tool, and `docs/operations/migration-rollback.md`
records why Prisma's stored checksum is not one.

## 6. Secrets management

**Implemented.** `docs/guides/environment-variables.md` inventories every
variable, its reader, its development default and its production requirement.

- No secret is in the repository. Development placeholders exist in
  `database.defaults.json` and are used only when `NODE_ENV` is not production;
  outside development, a missing role password raises rather than falling back to
  a placeholder.
- The API loads the root env file; the worker does not, and requires an explicit
  `APP_SYSTEM_DATABASE_URL`. That asymmetry is documented because an operator
  meets it on the first worker start, not because it is desirable.
- Errors never echo a credential or a number: a rejected connection string that
  printed itself would print its password. The two exceptions are configuration
  entries that are not secrets — a refused `CORS_ORIGINS` entry and a refused
  `TRUST_PROXY` token — quoted so the operator can see which entry was wrong.
- `db:bootstrap` prints role names and never a password.

**Caveats.** Secrets are environment variables, so they are visible in
`/proc/<pid>/environ` to anyone who can read that process, and a URL on a command
line is written to shell history. The guides give the `read -rs` pattern instead.
A secret manager is a deployment decision this repository has not made.

## 7. Dependency vulnerabilities

**Current state: `pnpm audit --audit-level=moderate` reports no known
vulnerabilities.**

One advisory was found and closed on 2026-11-28:
`GHSA-7589-6fvf-x4pw`, a ReDoS in `effect`, reached through
`prisma>@prisma/config`. `@prisma/config` pins `effect` exactly, so the fix is an
override to the advisory's fixed release in `pnpm-workspace.yaml`, with a comment
naming the removal condition. Nothing in this workspace imports `effect`; the only
consumer is the Prisma CLI parsing a file this repository controls, which is why
the advisory was never a reachable attack path here — the failing audit was the
problem.

**Not covered.** No SCA beyond `pnpm audit`, no lockfile review of transitive
provenance, no build-reproducibility check. `pnpm audit` knows only what its own
advisory source knows.

## 8. Rate limiting

**Implemented, with two stated properties.** `apps/api/src/auth/rate-limit.guard.ts`.

- 30 requests per minute per client IP, one quota shared by `register` and
  `login`, checked before the handler so a refusal costs neither an Argon2id run
  nor a query.
- Exercised live: the thirty-first counted request answered `429 RATE_LIMITED`
  with `Retry-After: 56`.
- The limiter is in-process and per instance. Behind more than one instance, each
  holds its own counter.
- "Client IP" is `req.ip`, which is the socket address unless `TRUST_PROXY` is
  configured. A proxy that appends to `X-Forwarded-For` rather than overwriting it
  lets a caller choose the value the server reads, and rotating that header buys a
  fresh bucket per request. Trusting a hop therefore requires a proxy that
  overwrites the header. `TRUST_PROXY=true` is refused at boot, and the default is
  off.
- Read routes are not limited.

## 9. Request validation

**Implemented.** `packages/contracts` holds every schema; `ZodValidationPipe`
binds one schema per parameter, because a global pipe could not know which schema
belongs to which argument and would silently validate nothing.

- Bodies, query objects and path parameters are `strictObject`s or UUID parses, so
  an unknown key or a malformed id is `400`, not a filter the server ignores.
- Bodies are bounded at 16 KiB by the parser, before Zod runs.
- The GeoJSON contract refuses what PostgreSQL would accept: a `MULTIPOLYGON`, a
  third ordinate, a declared `crs`. Topology is left to `ST_IsValid`, deliberately
  — a JavaScript copy of GEOS would be a second source of truth.
- Responses are parsed against their contract before they are sent, so a shape
  mismatch cannot reach a client.

**Caveats.** Validation is not authorisation: a valid body naming another tenant's
farm is `404`, not `403`, and that is the point.

## 10. Log redaction

**Implemented.** `apps/api/src/http/api-exception.filter.ts`.

- A failure logs exactly five fields: `requestId`, `status`, `code`,
  `exception`, `env`, and nothing else. `exception` is a coarse category
  (`HttpException`, `Error`, `Unknown`), not the class name — the code says why:
  a class name narrows the guesswork for a reader it should not help. No message,
  no body, no headers, no stack — in development as well as production, because a
  redaction that only runs in production is a redaction nobody has tested.
- Only `5xx` writes a line. A `4xx` is the client's answer. This also means the
  log cannot be used to reconstruct which of the five `401` causes occurred,
  because nothing records it.
- The worker writes one JSON line per lifecycle event, and the fields differ by
  event. The terminal one, `job_dead`, carries the job id, its kind and a code;
  `job_succeeded` carries id and kind; `job_retry_scheduled` carries id and
  attempt without the kind; `lease_lost` and `heartbeat_error` carry the id only;
  and the loop, reaper and shutdown lines carry no job at all. Per-cell progress
  inside a handler logs the job id and the cell key — `cellKey` is how a stalled
  cell is located, and it is the one payload field that is logged. The transport
  reduces a network failure to its error name
  (`network request failed (AbortError)`) because a URL can carry a query secret.

**Gap.** There is no audit trail of authorisation decisions. If a tenant isolation
fault is suspected, there is nothing to read; the tests are the evidence. A
structured access log is real work and belongs with the monitoring item, not with
this review.

## 11. Object storage permissions

**Not applicable.** There is no object storage, no file upload, no generated
document and no provider that returns a file handle. A review of its permissions
would be a review of nothing. `docs/guides/api-reference.md` §8 lists this as an
absence rather than leaving it implied.

## 12. External request handling

**Implemented.** `packages/weather-core/src/http.ts` and the adapters.

- The transport turns bytes into a status and a body, caps the body at 8 MiB and
  applies a 20 s timeout. It does not retry, classify a `4xx`, or parse JSON;
  those belong to the adapter and the queue, where they can be tested apart.
- Every adapter refuses a `baseUrl` that is not `https://`.
- No URL is built from caller input. The base URL is a constant or an
  operator-supplied configuration value; the variable parts are coordinates,
  dates and model names that the resolver validated first.
- Provider payloads are not trusted: normalisation refuses a missing value rather
  than substituting zero, and provenance travels with every stored row.

**Not established.** No egress allowlist, no proxy, no certificate pinning. Those
are deployment decisions. There is also no request signing, because the shipped
providers do not ask for it.

## 13. Production configuration

**Implemented as refusals.** `apps/api/src/config/runtime-config.ts` fails the
boot rather than serving a wrong configuration:

- `TRUST_PROXY=true` is refused; only a list of hops is accepted.
- A `CORS_ORIGINS` entry that is `*`, not a URL, or not its own `URL.origin` is
  refused.
- `APP_API_DATABASE_URL` must name `app_api` and `APP_AUTH_DATABASE_URL` must name
  `app_auth`; `migration_owner`, `app_system`, `postgres` and unknown roles are
  refused, including percent-encoded spellings.
- A missing role password outside development raises instead of falling back to a
  placeholder.

**Caveats that a production review must settle.**

- The Argon2 bounds are the library's (`8 KiB` to `1 GiB`, 1–10 passes, 1–255
  lanes), not a production floor. An operator can configure a hash cost far below
  any defensible one, and the ceiling is high enough to be a denial-of-service
  setting rather than a sanity bound. A production minimum is a decision, backed
  by a measurement on the target host.
- TLS, HSTS, network policy, firewall, WAF and secret distribution are hosting
  concerns and no hosting decision exists (`OPEN-18` and §13.7 are still open).
- Nothing is watched. There is no alerting, so a control that fails silently at
  03:00 fails silently.

## 14. Threats this review does not model

Naming them is part of the review:

- **Insider with database access.** The roles limit what a compromised runtime
  credential can do; they do not defend against the operator holding the
  superuser password.
- **Provider compromise.** A provider that returns plausible wrong data is
  detected only where normalisation refuses an impossible value; there is no
  cross-provider corroboration.
- **Supply chain.** Covered by `pnpm audit` and the lockfile, no further.
- **Resource exhaustion.** Body size, readiness budget and the limiter's capacity
  bound are the controls; there is no request timeout for handlers, no queue-depth
  alarm, and no CPU or memory quota in the repository.
- **Physical and host access.** Out of scope. No deployment exists.

## What would change this document

A deployment target (§13.7) turns the hosting items from "not ours to verify" into
work, and an external review or penetration test would replace the "read-only
review" caveat with real evidence. Both are worth doing before the product is
described as secure; neither is a substitute for the other.
