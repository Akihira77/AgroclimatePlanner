# ADR-004 — Authentication Database Boundary

- Status: **Proposed** — formalises decision `AG-1` recorded by the repository owner
  on 2026-11-18 in `docs/review/phase-3.2-owner-decisions.md` §1.10. That approval is
  the decision; this document is its durable record. Acceptance of *this document* is
  the owner's, not the author's, and is a separate act from the approval it records.
- Date: 2026-11-18 (decision date), recorded here 2026-11-18
- Depends on: ADR-002 (D5, D7), ADR-003, `docs/data-model/ownership-and-rls.md`,
  `docs/review/phase-3.2-design-review.md` §3, §4, §5, §16
- Supersedes: none
- Implemented by: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  (steps S3, S4, S6) — **plan only, nothing applied**
- Register entry: `OPEN-01` (P1, hard) — **still unresolved**, see §17

## Context

Every tenant-scoped read in this system runs under `app_api` inside `withTenant`,
which writes `app.user_id` with `set_config(..., true)` at the start of an
interactive transaction (`packages/database/src/tenant.ts`). The ten tenant tables
carry `ENABLE` + `FORCE ROW LEVEL SECURITY` with policies keyed on that setting.

That arrangement has one structural gap. Login happens **before** a tenant context
exists — the credential lookup is what establishes it. Three facts make the gap hard
rather than inconvenient, all measured at `202f508`:

1. `app_api` holds **no** privilege on `app.users`. The grant list in
   `20261118020000_tenant_tables/migration.sql` covers `farms` and `fields` only, and
   the omission is deliberate.
2. `app.users` is `FORCE ROW LEVEL SECURITY` with a self-only policy, so even a
   mistaken `GRANT SELECT` would return zero rows: the predicate needs
   `app.user_id`, which is exactly what login does not have yet.
3. `app.user_id` is only ever written by `withTenant`, which requires the user id as
   an argument. There is no path that produces that argument before authentication.

So "who reads the credential" is not a detail of the login handler. It is a question
about which database role exists, and it cannot be answered inside the query.

## Problem statement

Which PostgreSQL credential reads `app.users` before a tenant context exists, and
how is its reach bounded so that a mistake or a compromise of that credential cannot
become a compromise of tenant data?

`OPEN-01` records this. It was resolved into a decision by `AG-1` on 2026-11-18 and
is **not** resolved in the register: resolution requires an applied migration and
green verification as well as an accepted ADR (§17).

## Decision

A **fourth database role, `app_auth`**, holds column-level privileges on `app.users`
and nothing else, and is reached through its own connection string.

`app_api`, `app_system`, and `migration_owner` are unchanged. `app_api` still holds no
privilege of any kind on `app.users`.

### Alternatives that were rejected

Recorded in full in `phase-3.2-design-review.md` §5. Summarised here so this ADR does
not read as if the choice were obvious:

| Alternative | Why rejected |
|---|---|
| **B1** — `SECURITY DEFINER` function `app.lookup_credentials(email)` owned by `migration_owner`, `EXECUTE` to **`app_api`** | moves the privilege instead of removing it: the definer owns every table, so the function body *is* the boundary, and it hands the tenant credential a credential read it can never lose. One mistake in that body is a full-database read (design review §5, §5.1) |
| **B2** — the same function, `EXECUTE` to **`app_auth`** only | the tightening path, not v1. It keeps the capability outside `app_api`, but replaces column grants with a definer body that must pin `search_path` and build no SQL. Recorded as a future option; adopting it needs a new owner decision, not an implementer's preference |
| **C** — a second identity context (GUC or signed attestation) | changes nothing about who reads the credential, and adds gameable state that ADR-003 already measured as unenforceable |
| **D** — no database change: login against an out-of-band store | contradicts ADR-002 D5 and the single-database architecture; the credential would then have two homes |

The shape that was chosen — option **A** — is the only one where the capability is a
grant list a reviewer can read, rather than a function body they must audit.

## Role architecture

| Attribute | Value | Why |
|---|---|---|
| Name | `app_auth` | one role, one purpose |
| `NOLOGIN` at bootstrap | yes | `bootstrap/roles.sql` contains no credential; provisioning turns login on with a password from the environment |
| `LOGIN` after provisioning | yes | it is the only role that connects for authentication |
| `SUPERUSER` | no | never |
| `CREATEDB`, `CREATEROLE` | no | a table-owning auth role is not needed and would be a second migration path |
| `REPLICATION` | no | never |
| `BYPASSRLS` | **no** | the policies on `users` are `USING (true)`, so bypass would buy nothing and remove the only flag proving intent |
| `INHERIT` | **no** | `NOINHERIT` makes membership inert; combined with zero memberships it means no grant can be acquired second-hand |
| Memberships | **none**, in either direction | verified in both directions; `SET ROLE` to any other role is refused |
| Owns | nothing | `app` and every object in it stay with `migration_owner` |
| Schema privilege | `USAGE` on `app` only | no `CREATE` on `app`, none on `public` |

Adding the role is an edit to an existing normalisation file, not a new mechanism:
`bootstrap/roles.sql` creates names from an array and re-asserts attributes on every
run, and `bootstrap.mjs` turns login on by iterating `ROLE_NAMES`, which is derived
from `scripts/lib/connections.mjs`.

## Credential provisioning and connection configuration

- Provisioning reads `APP_AUTH_PASSWORD` and applies it through `format(%L, …)`,
  executed and never logged. Outside development a missing password is an error, not
  a placeholder — the existing `passwordFor` behaviour, unchanged.
- `connections.mjs` gains `app_auth: { url: "APP_AUTH_DATABASE_URL", password:
  "APP_AUTH_PASSWORD" }`, so every consumer that iterates `ROLE_NAMES` picks it up.
- The API process parses a **second, separately validated** DSN at boot. Its assertion
  is the inverse of the tenant one: the decoded user must be `app_auth`, and
  `app_api`, `app_system`, `migration_owner`, and `postgres` are refused **by name**.
  A swapped DSN would silently collapse two credentials into one, which is the exact
  failure this decision exists to prevent, so the check is explicit rather than a
  relaxation of `assertRuntimeRole`.
- In production, a missing `APP_AUTH_DATABASE_URL` fails the boot. There is no
  fallback to `app_api` and no lazy "create it when first needed" path: a client
  created on first use turns a configuration error into a 500 at the worst moment.
- Error messages name the variable and the role, never a value. No DSN, password, or
  connection string is logged, returned, or written to a document.

## `app.users` access model

The table is not modified. Only privileges and policies are added.

| Operation | `app_auth` | Mechanism |
|---|---|---|
| `SELECT (id, email, password_hash, role, locale, timezone)` | allowed | column grant + `users_auth_lookup FOR SELECT USING (true)` |
| `INSERT (email, password_hash)` | allowed | column grant + `users_auth_register FOR INSERT WITH CHECK (true)` |
| `SELECT` of any other column | `42501` | not granted |
| `INSERT` of any other column | `42501` | not granted |
| `UPDATE`, any column | `42501` | no `UPDATE` grant exists |
| `DELETE` | `42501` | no `DELETE` grant exists |
| table-wide privilege of any kind | none | every grant is a column grant |
| `app_api` — any operation | `42501` | unchanged; the omission is deliberate |

`created_at` and `updated_at` are deliberately **not** granted. Nothing on the
authentication path needs them, and adding a column later must be a deliberate grant
rewrite rather than something that happened by default.

## Column-level grants

```sql
-- Applied by migration `auth_boundary` (S4). NOT APPLIED.
GRANT SELECT (id, email, password_hash, role, locale, timezone) ON app.users TO app_auth;
GRANT INSERT (email, password_hash)                                ON app.users TO app_auth;
```

Reasons, column by column:

| Column | `SELECT` | `INSERT` | Reason |
|---|---|---|---|
| `id` | yes | — (DB default) | the subject of the session; registration needs it back through `RETURNING` |
| `email` | yes | yes | the lookup key and the only identity field registration sets |
| `password_hash` | yes | yes | verify on login, write on register — this is the whole point of the role |
| `role` | yes | no | authorisation input on the request path; not settable by the caller, DB default is `'owner'` |
| `locale`, `timezone` | yes | no | `/me` and response localisation; defaults are DB-owned |
| `created_at`, `updated_at` | **no** | **no** | not needed; `updated_at` has no trigger (`OPEN-19`), so a client-written value would be the only writer |

## RLS policies

`ENABLE` and `FORCE ROW LEVEL SECURITY` stay exactly as they are. Two policies are
added, one per capability, so the grant dump and the policy dump agree:

```sql
-- Applied by migration `auth_boundary` (S4). NOT APPLIED.
CREATE POLICY users_auth_lookup   ON app.users FOR SELECT TO app_auth USING (true);
CREATE POLICY users_auth_register ON app.users FOR INSERT TO app_auth WITH CHECK (true);
```

`FOR SELECT`/`FOR INSERT` rather than `FOR ALL`: a single `FOR ALL` policy would
document a capability the grants do not have and would silently cover a future
`UPDATE` grant.

`users_self_only` (to `app_api`) and `users_owner_full_access` (to `migration_owner`)
are unchanged. `app_api` is named in neither new policy.

The honest statements about what these policies do and do not do:

- `USING (true)` means the filter adds **nothing**. The boundary is the grant, not the
  policy. Writing the policies is what makes the intent explicit and keeps `FORCE`
  meaningful for the owner.
- `FORCE` is retained, so `migration_owner` — the table owner — is still policed by
  its own policy. Removing `users_owner_full_access` would break fixtures and data
  migrations, not harden anything.
- Because the auth policies are `USING (true)`, `app_auth` queries work **without**
  `app.user_id`. That is why the auth path never enters `withTenant`, and it is the
  single most important property of this design.
- The corollary, stated plainly: `SELECT (email)` with `USING (true)` supports
  `WHERE email = $1` and is equally a full-table email dump. The lookup *is* the
  enumeration; no grant removes that. It is disclosed in §13.

## NestJS dependency boundary

The API process holds two database clients. Their separation is enforced in the
application's dependency graph, and it is worth being precise about what that buys.

```text
AppModule
├── DatabaseModule (@Global)              → DATABASE_CLIENT        (app_api)
├── AuthDatabaseModule (NOT global)       → AUTH_DATABASE_CLIENT   (app_auth)
│   └── imported only by AuthenticationModule
└── HealthModule                          → DATABASE_CLIENT
```

- `DatabaseModule` keeps its current shape: `@Global`, one provider, one
  `DatabaseLifecycle`. It must **not** gain a second provider or export the auth
  token, because every module in the process would then be able to inject the auth
  credential by asking for it — which would make "the tenant client cannot be
  confused with the auth client" a naming convention instead of a structure.
- `AuthDatabaseModule` is a separate, **non-global** module. It owns
  `AUTH_DATABASE_CLIENT` and its own lifecycle provider. Only the module that
  implements authentication imports it, so a business module that wants a database
  client cannot reach the auth credential without an import that shows up in a diff
  and in review.
- Lifecycle ownership is one provider per client, each holding its own `closed` flag
  and calling `$disconnect()` once. Nest calls `onModuleDestroy` per provider
  instance, and because each lifecycle injects exactly one token, there is no path
  that disconnects a client twice or disconnects the other module's client.
- `/health/ready` keeps probing the tenant client only. An auth probe would change
  the meaning of a 503 that is already documented in `api-conventions.md` §12; auth
  readiness belongs to the authentication track.

**What this is not.** A NestJS module boundary is a compile-time and review-time
structure. It stops a colleague from injecting the wrong client by accident; it does
**not** stop code that owns the process from reaching both tokens, and it is not
process isolation. `AG-1` accepted that both credentials live in one process; see
§13 and R-7 of the owner record.

## Security properties

What this decision actually establishes, per enforcement layer:

| Property | Enforced by | Evidence required |
|---|---|---|
| `app_auth` is not `app_api`, and neither can become the other | PostgreSQL | separate roles, `NOINHERIT`, zero memberships, `SET ROLE` refused at `42501` |
| `app_auth` reaches no tenant, catalog, or weather table | PostgreSQL | `42501` on each of the 21 other tables, enumerated not sampled |
| `app_auth` cannot read or write `created_at`/`updated_at` | PostgreSQL | `has_column_privilege` false, and a behavioural `42501` |
| `app_auth` cannot modify or delete a user | PostgreSQL | no `UPDATE`/`DELETE` grant exists |
| `app_api` still reaches no credential | PostgreSQL | existing measured denial re-asserted |
| The auth credential never opens a tenant transaction | application | the auth path uses its own client; `withTenant` is not imported there |
| A swapped DSN fails at boot | application + deployment | role assertion refuses the other three names |

`NOINHERIT` with zero memberships is what makes the fourth role a boundary rather
than a name: no grant can be acquired through a role edge, and no `SET ROLE` can
borrow one.

## Explicit limitations

These are accepted, disclosed, and not mitigated by this ADR:

1. **This is a credential boundary, not a process boundary.** Both DSNs live in one
   process. An attacker who owns the process holds both, and the boundary tells them
   nothing they cannot ignore (`AG-1`, R-7). No sentence in code, comments, or
   documentation may describe this as isolation between authentication and business
   operations.
2. **`app_auth` can read every email and every password hash, and can insert a user.**
   A leaked `APP_AUTH_DATABASE_URL` is a bulk credential dump plus account creation
   outside the registration flow (R-1, R-2). No grant narrows this without breaking
   login.
3. **Email enumeration is the design, not a bug.** `USING (true)` plus `SELECT
   (email)` supports a lookup and a full dump with the same privilege.
4. **RLS does not protect against arbitrary SQL under `app_auth`.** The policies are
   `USING (true)`; a role that can run SQL can read every credential row. RLS is
   containment for the *tenant* credential, which holds no grant here at all.
5. **Nothing here constrains intent, only shape.** SQL injection under `app_auth` is
   bounded by the column grants — no tenant data, no DDL, no `SET ROLE`, no deletion —
   but it can still read and forge credentials.
6. **Authorisation is not decided here.** What a user may do after login — `role`,
   route guards, ownership checks — is application logic and belongs to the
   authentication track.
7. **Prisma is not authoritative.** The SQL migration is. Prisma's generated
   `INSERT` for `User` would name `locale`, `timezone`, and `role`, which are
   schema-level literal defaults the client sends rather than letting PostgreSQL
   apply. Registration must therefore use an explicit column `INSERT … RETURNING id`
   rather than widening the grant. This is a consequence to verify at S4/S7, not a
   privilege to hand out (`phase-3.2.3` plan §6.5).
8. **`app_auth` cannot update a user at all.** Password change, email verification,
   and any future profile write need a new column grant and a new policy — an owner
   decision, not an implementer's convenience.

## Consequences

- Registration and login become writable against a credential that structurally
  cannot touch tenant data. `OPEN-01`'s blocker is removed at the design level.
- The API grows a second validated DSN, a second client, and a second lifecycle — a
  real cost, paid once, in a place where a mistake is visible.
- Bootstrap gains a fourth role and a fourth password variable. Every existing
  verification loop that iterates `ROLE_NAMES` extends automatically, which is why
  the membership and login assertions are worth extending rather than duplicating.
- Documentation must state the same-process limitation wherever the boundary is
  described, or the boundary will be over-claimed. This is the failure mode review
  item 15 of the Definition of Done exists to catch.
- Verification must use `has_column_privilege` **and** a behavioural probe: the
  table-level helper reports false for column grants and would happily "pass" a
  boundary that does not exist. Every denial is accepted only at `42501`; a
  `42P01` means the object is missing, not that the privilege was denied.

## Implementation references

- `packages/database/bootstrap/roles.sql` — role array, attributes, schema
  normalisation, default privileges.
- `packages/database/scripts/bootstrap.mjs`, `scripts/lib/connections.mjs`,
  `database.defaults.json` — provisioning and connection resolution.
- `packages/database/prisma/migrations/20261118040000_auth_boundary/` — the grants and
  policies above (to be created).
- `apps/api/src/config/runtime-config.ts`, `src/tokens.ts`,
  `src/database/auth-database.module.ts` — the second DSN, token, and module.
- `packages/database/scripts/lib/privilege-verification.mjs`,
  `test/rls/auth-boundary.test.mjs` — the evidence.
- Full step-by-step: `docs/implementation/phase-3.2.3-authentication-database-boundary.md`
  §5, §6, §8.

## Related decisions and open decisions

- **`AG-1`** — approved 2026-11-18; this ADR is its formal record.
- **ADR-002 D5, D7** — server-side sessions and the role split this extends.
- **ADR-003** — why a GUC cannot be the enforcement point, which is why a role is.
- **ADR-005** — the session table `app_auth` also reaches, and its own boundary.
- **`OPEN-01`** — still **unresolved**. Do not flip the register entry on the strength
  of this ADR: the Definition of Done requires an accepted ADR **and** an applied
  migration **and** green verification.
- **`OPEN-28`** — signed tenant context, untouched and unaffected.
- **`IG-1`–`IG-4`, `IG-6`, `IG-7`, `IG-10`** — email normalisation, duplicate
  registration, auto-login, password policy, hashing parameters, brute-force control,
  and email verification. None is answered here, and none changes this boundary.
