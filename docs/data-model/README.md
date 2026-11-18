# Physical Data Model

Status: **Phase 2.3 — specification only.** No table, migration, Prisma model, or
runtime behaviour is created by this phase. `docs/data-model/` is the normative
physical contract that Phase 3 implements.

Three tables already exist in the running database (`app.users`, `app.farms`,
`app.fields`, Phase 2.2.3). This model describes them exactly as implemented and
extends around them. Where a document here disagrees with the implemented schema,
the disagreement is listed in `consistency-checklist.md` — it is a defect, not a
preference.

## 1. Which documents are normative

Read in this order. Every later document assumes the earlier ones.

| # | Document | Normative for |
|---|---|---|
| 1 | `entity-catalog.md` | the complete table inventory, ownership class, and stable table names |
| 2 | `physical-model.md` | conventions shared by every table: ids, time, hashes, JSONB policy, naming |
| 3 | `tables-identity.md` | `users`, `farms`, `fields`, `field_outlook_cells`, `field_observations`, `plantings`, `harvests` |
| 4 | `tables-catalog.md` | `crops`, `cultivars`, `crop_profile_versions`, `growth_stages`, `constraints`, `source_refs` |
| 5 | `tables-climate.md` | `outlook_cells`, `forecast_runs`, `ingestion_runs`, `weather_records`, `monthly_outlooks`, `climatology_normals` |
| 6 | `tables-derived.md` | `suitability_runs`, `planting_windows`, `ai_briefings` |
| 7 | `relationships.md` | every foreign key, cardinality, and composite ownership key |
| 8 | `ownership-and-rls.md` | the ownership/RLS/grant matrix for all 22 tables, and the `app.users` lookup problem |
| 9 | `spatial-model.md` | geometry types, SRID, area, validity, indexing, snapshot invalidation |
| 10 | `provenance-storage.md` | how the contract types are stored, hashed, and kept reproducible |
| 11 | `temporal-and-weather-semantics.md` | what every date and timestamp column means, and how missing data is represented |
| 12 | `indexes-and-query-patterns.md` | every index, justified by a named query |
| 13 | `lifecycle-and-retention.md` | creation, supersession, soft delete, and deletion policy per entity group |

Supporting:

- `open-decisions.md` — everything **not** settled. `OPEN-nn` blocking items are
  the only reason Phase 3 cannot be fully started.
- `consistency-checklist.md` — the cross-document review, including the two
  discrepancies between this specification and the implemented database.
- `../adr/ADR-003-trusted-tenant-context.md` — the security decision that governs
  how `app.user_id` may be trusted.

## 2. Precedence

When two documents disagree:

1. `docs/architecture/provenance-contract.md` wins on hashing, ordering, run
   identity, freshness, and missing-data semantics. It is executable — the golden
   vectors in `packages/contracts/src/hash.golden.test.ts` are the authority, not
   the prose.
2. `packages/contracts/src/*.ts` wins on the shape of any contract type stored in
   this model. A JSONB column documented here carries the schema of the type it
   is named after.
3. `docs/architecture/domain-model.md` wins on entity existence and columns.
4. `docs/architecture/system-architecture.md` and `background-processing.md` win
   on role boundaries and job ownership.
5. This directory wins on PostgreSQL types, constraints, indexes, and column
   names — the things the higher documents deliberately do not specify.

If a higher document is silent and this directory had to choose, the choice is
recorded as a `D-nn` decision in the document that makes it, and listed in
`open-decisions.md` §3 for review. Nothing in this directory is allowed to
silently fill a gap in the domain model.

## 3. Decision and gap identifiers

- `D-nn` — a physical decision made here. Binding for Phase 3, revisable through
  review, never silently.
- `OPEN-nn` — an unresolved question. Each one names what it blocks and what
  information would settle it. An `OPEN` item is never implemented by guessing.

Severity: **P0** blocks Phase 3 start · **P1** blocks a specific subsystem ·
**P2** can be settled during implementation.

## 4. Scope

In scope: identity and tenancy, the crop catalog, the weather/climate data plane,
agronomic derived artifacts, AI briefings, the ownership and privilege matrix, and
the physical representation of every provenance contract.

Out of scope, deliberately: authentication mechanics (evaluated in
`ownership-and-rls.md` §5, decided nowhere), verification/scoring tables
(`OPEN-12`), queues, API surface, ingestion adapters, and every agronomic
algorithm. This model says where a value is stored and what shape it has; it does
not say how to compute it.

## 5. Non-negotiables inherited from earlier phases

These are not re-opened here:

1. One id space: `uuid` primary keys defaulting to PostgreSQL's native
   `uuidv7()`. No ULID, no integer keys, no natural keys as primary keys.
2. Schema `app`, owned by `migration_owner`. Runtime roles never own a table.
3. Tenant-owned tables carry `user_id uuid NOT NULL`, `ENABLE` **and** `FORCE`
   row level security, and one `FOR ALL TO app_api` policy with both `USING` and
   `WITH CHECK`.
4. `app_system` holds `BYPASSRLS` and no tenant-table privilege by default.
5. Migrations are hand-written SQL applied with `prisma migrate deploy`;
   `schema.prisma` is kept in sync by hand.
6. Every derived artifact stores `input_refs`, `input_snapshot_hash`,
   `derivation_version`, and `computed_at`, and is replayable or explicitly
   marked unreproducible with a reason.
