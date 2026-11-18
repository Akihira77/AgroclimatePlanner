# Ownership and Row Level Security

Tenant-owned: 10 tables. Global/reference: 12 tables. This document is the
complete matrix, the policy text, and the two problems the matrix creates that
are **not** solved here.

Nothing in this document is implemented. The three existing policies are quoted
from `prisma/migrations/20261118020000_tenant_tables/migration.sql`; the rest is
the specification Phase 3 applies.

## 1. Roles

Created by `bootstrap/roles.sql` as the cluster administrator, all `NOINHERIT`,
zero memberships, no role granted to another:

| Role | `BYPASSRLS` | Owns objects | Purpose |
|---|---|---|---|
| `migration_owner` | no | **yes** — schema `app` and every object in it | applies migrations, seeds the catalog, runs fixtures |
| `app_api` | no | no | the runtime request path; always inside `withTenant` |
| `app_system` | **yes** | no | ingestion, aggregation, baseline building; never a tenant request |

`NOINHERIT` matters: a role with memberships could inherit a privilege it was
never granted directly, and `BYPASSRLS` on `app_system` would then leak into
`app_api` through a shared login. The three roles are separate connection
strings (`scripts/lib/connections.mjs`) and none can `SET ROLE` to another.

`BYPASSRLS` on `app_system` confers **no table privilege** — it only disables
policy filtering on tables it can already read, and it holds no tenant-table
grant. Measured in Phase 2.2.2.x: every operation `app_api` is refused,
`app_system` is also refused, with the same SQLSTATE.

## 2. The matrix

`api` = `app_api` · `sys` = `app_system` · `own` = `migration_owner`.
`RW` = SELECT, INSERT, UPDATE, DELETE · `R` = SELECT only.

| # | Table | Class | RLS | `api` | `sys` | `own` |
|---|---|---|---|---|---|---|
| 1 | `users` | identity | FORCE | **none** | none | RW |
| 2 | `farms` | tenant | FORCE | RW | none | RW |
| 3 | `fields` | tenant | FORCE | RW | none | RW |
| 4 | `field_outlook_cells` | tenant | FORCE | RW | none | RW |
| 5 | `field_observations` | tenant | FORCE | RW | none | RW |
| 6 | `plantings` | tenant | FORCE | RW | none | RW |
| 7 | `harvests` | tenant | FORCE | RW | none | RW |
| 8 | `crops` | reference | none | R | none | RW |
| 9 | `cultivars` | reference | none | R | none | RW |
| 10 | `crop_profile_versions` | reference | none | R | none | RW |
| 11 | `growth_stages` | reference | none | R | none | RW |
| 12 | `constraints` | reference | none | R | none | RW |
| 13 | `source_refs` | reference | none | R | none | RW |
| 14 | `outlook_cells` | global | none | R + `INSERT (provider, model, cell_key)` | RW | RW |
| 15 | `forecast_runs` | global | none | R | RW | RW |
| 16 | `ingestion_runs` | global | none | R | RW | RW |
| 17 | `weather_records` | global | none | R | RW | RW |
| 18 | `monthly_outlooks` | global | none | R | RW | RW |
| 19 | `climatology_normals` | global | none | R | RW | RW |
| 20 | `suitability_runs` | tenant-derived | FORCE | RW | none | RW |
| 21 | `planting_windows` | tenant-derived | FORCE | RW | none | RW |
| 22 | `ai_briefings` | tenant-derived | FORCE | RW | none | RW |

Rules encoded in the matrix:

1. **No `GRANT ALL`, no `GRANT … ON ALL TABLES IN SCHEMA`, no `ALTER DEFAULT
   PRIVILEGES` for runtime roles.** Each table opts in explicitly. This is the
   default-deny baseline from Phase 2.2.2 and every new table has to restate it.
2. **`app_system` holds nothing on any tenant-owned table**, per
   `background-processing.md` §10 rule 2. A sweep that needs one gets a named
   grant in the migration that adds the sweep — not a blanket one now.
3. **The catalog is read-only to every runtime role.** Content is seeded by
   `migration_owner` (`D13`); a published profile is immutable (`D5`) and the
   absence of an `UPDATE` grant is half of that enforcement.
4. **`app_api` may not write provider values.** It reads them. Ingestion runs as
   `app_system`, so a compromised request path cannot fabricate a forecast that
   a tenant then plants against.
5. **`app_api` may insert a cell identity row and nothing else.** The column
   grant stops it from writing `served_lat`/`served_lon`/`elevation_m` — those are
   provider facts and only `app_system` observes them (`D14`).

### Why the column grant on `outlook_cells`

Field creation resolves a field to a cell *before any ingest exists*: the
rounding rule is deterministic, so the identity is computable, but the served
coordinate is not yet observed. Two options were available:

- defer cell creation to ingestion, and have field creation fail when a cell is
  not yet known — a new user cannot add a field until the first forecast lands;
- allow `app_api` to create the identity triple in `outlook_cells`, which is
  `UNIQUE (provider, model, cell_key)` and carries no provider value.

The second is chosen. The grant is column-level, so the write path can insert
`(provider, model, cell_key)` and cannot set a served coordinate even if a
future bug tries. `INSERT … ON CONFLICT (provider, model, cell_key) DO NOTHING`
then makes it idempotent, and the read that follows uses the `SELECT` grant.

## 3. Policy shape

Every one of the ten tenant tables carries exactly these three statements:

```sql
ALTER TABLE app.<t> ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.<t> FORCE  ROW LEVEL SECURITY;

CREATE POLICY <t>_tenant_isolation ON app.<t>
  FOR ALL TO app_api
  USING      (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid)
  WITH CHECK (user_id = NULLIF(current_setting('app.user_id', true), '')::uuid);

CREATE POLICY <t>_owner_full_access ON app.<t>
  FOR ALL TO migration_owner USING (true) WITH CHECK (true);
```

with one deliberate variation: `users` uses `id = …` as the predicate, because
the row *is* the tenant (`users_self_only`, already implemented).

Point by point, because each clause is load-bearing:

| Clause | Effect if removed |
|---|---|
| `ENABLE` | every tenant reads every row |
| `FORCE` | the table owner (`migration_owner`) bypasses its own policy — and it is the owner of every table |
| `FOR ALL` (not four policies) | `UPDATE` would need a separate policy; splitting invites a `USING`-only policy, and `USING`-only on `UPDATE` lets a tenant move a row to another owner |
| `WITH CHECK` | an `INSERT`/`UPDATE` could produce a row the tenant may not see — which is how ownership gets forged |
| `TO app_api` | the policy would apply to `app_system` too; harmless but it would document a false intent |
| `NULLIF(…, '')` | `''::uuid` raises `22P02` instead of matching nothing; a missing context must deny, not error |
| `current_setting(…, true)` | an unset GUC raises `42704` instead of returning `NULL` |
| `migration_owner … USING (true)` | `FORCE` denies the owner too; a fixture insert or data migration fails with "new row violates row-level security policy" |

**Fail-closed is verified, not assumed.** Missing context, empty context, and a
context that is not a UUID all produce zero rows on `SELECT` and `42501` on
`INSERT`. `test/rls/tenant-isolation.test.mjs` asserts the row counts; the
SQLSTATE is asserted separately so a `23503` from a composite FK is never
mistaken for a policy denial.

### Why `users` keeps a policy while `app_api` has no grant

`users_self_only` is defence in depth: if a future grant is added by mistake,
the policy is what stands between "read your own account" and "read every
account's password hash". Removing it because the grant is absent would make the
next grant a one-line privilege escalation.

## 4. Grants to write in Phase 3

```sql
-- tenant-owned
GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.field_outlook_cells, app.field_observations, app.plantings,
  app.harvests, app.suitability_runs, app.planting_windows, app.ai_briefings
  TO app_api;

-- reference catalog: read only, no write path exists
GRANT SELECT ON
  app.crops, app.cultivars, app.crop_profile_versions,
  app.growth_stages, app.constraints, app.source_refs
  TO app_api;

-- weather plane: read to the API, write to the ingest/aggregate path
GRANT SELECT ON
  app.outlook_cells, app.forecast_runs, app.ingestion_runs,
  app.weather_records, app.monthly_outlooks, app.climatology_normals
  TO app_api;
GRANT INSERT (provider, model, cell_key) ON app.outlook_cells TO app_api;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  app.outlook_cells, app.forecast_runs, app.ingestion_runs,
  app.weather_records, app.monthly_outlooks, app.climatology_normals
  TO app_system;
```

`app_system` gets `UPDATE` on `weather_records` because supersession is an
update (`superseded_by_id`/`superseded_at`), not a delete. It gets `DELETE`
nowhere except through the same grant — no delete path exists, and revoking it
individually would be undone by the next `GRANT` restatement.

## 5. `app.users` and the login lookup — `OPEN-01`

The login path is the one read that happens **before** a tenant context exists,
and it is the only place the model has no answer.

What the current state actually means:

| Fact | Consequence |
|---|---|
| `app_api` has no privilege on `app.users` | it cannot look up an email at all |
| `users` has `FORCE ROW LEVEL SECURITY` | even with `SELECT`, a query without `app.user_id` returns zero rows |
| `app.user_id` is set inside the transaction by `withTenant` | the transaction exists only after the user is known |

So "authenticate, then open a tenant scope" cannot be built from what exists.
`app_system` cannot do it either: it has `BYPASSRLS` but no grant on `users`, and
giving it one would put every password hash within reach of the ingestion
credential.

Three options, none implemented, none approved:

| Option | Shape | Cost |
|---|---|---|
| **A. Dedicated `auth` role** | `GRANT SELECT (id, email, password_hash, role, locale, timezone) ON app.users TO app_auth`; a policy `TO app_auth USING (true)` with a narrow column grant | a fourth role and a fourth connection; the narrow grant is what limits the blast radius, not the policy |
| **B. `SECURITY DEFINER` function** | `app.lookup_credentials(email text)` owned by `migration_owner`, `REVOKE EXECUTE FROM PUBLIC`, `GRANT EXECUTE TO app_api` | one function is a small attack surface and easy to review; but it is a privileged entry point on the credential table and must not be able to return anything but the one row asked for |
| **C. Column-level grant + scoped policy** | `GRANT SELECT (id, email, password_hash, role) TO app_api` plus a policy that permits lookup when a *separate* authority GUC is set | two context variables with different trust levels; the most error-prone |

Option A is the least clever and the one this document recommends. It is not
decided here: it is a security decision with a new role in it, and the roles are
established by a bootstrap script that a review has already approved once.

Meanwhile the honest statement is: **authentication is not buildable against this
schema as specified.** That is `OPEN-01`, P0 for Phase 3's auth slice, and it is
not worked around by loosening the `users` policy.

## 6. The trust boundary on `app.user_id` — see ADR-003

The policies assume `app.user_id` is set by `withTenant` from an authenticated
subject. The database cannot verify that assumption: `app.user_id` is an
application-defined GUC that any role may set, and Phase 2.3 measured that
`app_api` can set it to another tenant's id.

Inside a single transaction the policy still holds — a statement cannot read a
row whose `user_id` differs from the current setting. The exposure is *which*
setting the transaction commits to, which is a code-path property, not a schema
property. `ADR-003-trusted-tenant-context` records the measurement, the threat
classes that are and are not protected, and the options. No RLS code changes as
a result of it.

## 7. What must be verified in Phase 3

Per table, the Phase 2.2.2.x probe pattern extends mechanically:

1. `SELECT` with no context → 0 rows, no error.
2. `SELECT` with another tenant's id → 0 rows.
3. `INSERT` with no context → `42501`.
4. `INSERT` with `user_id` = another tenant → `42501` (policy) or `23503`
   (composite FK), asserted **specifically**, never as "denied".
5. `UPDATE` moving `user_id` → `42501` (the `WITH CHECK` half).
6. `DELETE` on another tenant's row → 0 rows affected.
7. `app_system` on each tenant table → `42501` on every operation.
8. `app_api` `INSERT` on the catalog → `42501`.
9. `app_api` `UPDATE weather_records` → `42501`.
10. `app_api` `INSERT INTO outlook_cells (served_lat) …` → `42501` (column
    grant), while `INSERT (provider, model, cell_key)` succeeds.
11. `migration_owner` `INSERT`/`SELECT` on every tenant table → succeeds,
    because `FORCE` plus `*_owner_full_access` must not lock the owner out.

Checks 10 and 11 are the ones a generic "can this role do this" harness misses,
because both are about a *partial* grant and a *policy exemption* rather than a
binary allow/deny.
