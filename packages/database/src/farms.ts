/**
 * Farm rows (`docs/architecture/farm-field-domain-contracts.md` §3.1, §6).
 *
 * Every function takes the transaction that `createTenantScope().withTenant()`
 * opened; none of them opens its own, because a second scope would be a second
 * tenant context and `withTenant` rejects nesting by design.
 *
 * Three properties are structural rather than stylistic:
 *
 * 1. **The tenant is never a parameter.** Ownership is read from
 *    `current_setting('app.user_id')`, the same expression the RLS policy reads, so
 *    the statement and the policy cannot disagree and no caller can supply a
 *    `user_id`. An unscoped call fails closed: the setting is NULL and the INSERT
 *    violates `NOT NULL` rather than writing an ownerless row.
 * 2. **`deleted_at IS NULL` is explicit on every statement.** RLS does not filter
 *    soft-deleted rows — the policy has no such predicate — so deleting a row is
 *    only a delete because each query says so.
 * 3. **`updated_at` is written by hand.** No trigger maintains it (`OPEN-19`), so a
 *    statement that omits it leaves a timestamp that describes an older row.
 */
import { Prisma } from "./generated/prisma/client.js";

import type { TenantTransaction } from "./tenant.js";

export interface Farm {
  readonly id: string;
  readonly name: string;
  readonly region: string | null;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** `region` and `notes` are optional on create; absent and `null` both store `NULL`. */
export interface FarmCreate {
  readonly name: string;
  readonly region?: string | null;
  readonly notes?: string | null;
}

/**
 * Absent means "leave unchanged"; `null` on `region`/`notes` means "clear it" and
 * is rejected for `name`, which cannot be blank (`api-conventions.md` does not
 * define PATCH semantics; the decision is recorded in the design document, `D3`).
 */
export interface FarmUpdate {
  readonly name?: string;
  readonly region?: string | null;
  readonly notes?: string | null;
}

export type FarmSort = "name" | "-name" | "createdAt" | "-createdAt" | "updatedAt" | "-updatedAt";

export interface FarmListOptions {
  readonly limit: number;
  readonly offset: number;
  readonly sort: FarmSort;
}

export interface FarmPage {
  readonly items: readonly Farm[];
  readonly total: number;
}

/** `id` is the tie-break so a page boundary cannot repeat or skip a row. */
const FARM_ORDER: Record<FarmSort, string> = {
  name: "name ASC, id ASC",
  "-name": "name DESC, id DESC",
  createdAt: "created_at ASC, id ASC",
  "-createdAt": "created_at DESC, id DESC",
  updatedAt: "updated_at ASC, id ASC",
  "-updatedAt": "updated_at DESC, id DESC",
};

export async function createFarm(tx: TenantTransaction, input: FarmCreate): Promise<Farm> {
  const rows = await tx.$queryRaw<RawFarm[]>`
    INSERT INTO app.farms (user_id, name, region, notes)
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${input.name},
      ${input.region ?? null},
      ${input.notes ?? null}
    )
    RETURNING id::text AS id, name, region, notes, created_at, updated_at
  `;

  const row = rows[0];
  if (row === undefined) throw new Error("farm insert returned no row");
  return toFarm(row);
}

/**
 * `total` is counted in its own statement, so it describes the snapshot at that
 * statement rather than the page's. A concurrent insert can therefore move `total`
 * by one without changing the rows already returned. The alternative — `count(*)
 * OVER ()` on the page query — cannot report a total for a page past the end,
 * which is a worse failure for an empty list.
 */
export async function listFarms(
  tx: TenantTransaction,
  options: FarmListOptions,
): Promise<FarmPage> {
  const rows = await tx.$queryRaw<RawFarm[]>`
    SELECT id::text AS id, name, region, notes, created_at, updated_at
      FROM app.farms
     WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     ORDER BY ${Prisma.raw(FARM_ORDER[options.sort])}
     LIMIT ${options.limit} OFFSET ${options.offset}
  `;

  const counted = await tx.$queryRaw<{ total: number }[]>`
    SELECT count(*)::int AS total
      FROM app.farms
     WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  return {
    items: rows.map(toFarm),
    total: counted[0]?.total ?? 0,
  };
}

/** Another tenant's farm and a farm that does not exist both return `null`. */
export async function findFarm(tx: TenantTransaction, farmId: string): Promise<Farm | null> {
  const rows = await tx.$queryRaw<RawFarm[]>`
    SELECT id::text AS id, name, region, notes, created_at, updated_at
      FROM app.farms
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  const row = rows[0];
  return row === undefined ? null : toFarm(row);
}

/**
 * One statement, so "absent keeps the old value" and "`null` clears it" cannot be
 * expressed by two different code paths that drift. `name` uses `COALESCE` because
 * it cannot be cleared; the other two use a presence flag, because `NULL` is a
 * value they are allowed to take.
 */
export async function updateFarm(
  tx: TenantTransaction,
  farmId: string,
  input: FarmUpdate,
): Promise<Farm | null> {
  const rows = await tx.$queryRaw<RawFarm[]>`
    UPDATE app.farms
       SET name       = COALESCE(${input.name ?? null}, name),
           region     = CASE WHEN ${input.region !== undefined}::boolean
                             THEN ${input.region ?? null}::text
                             ELSE region END,
           notes      = CASE WHEN ${input.notes !== undefined}::boolean
                             THEN ${input.notes ?? null}::text
                             ELSE notes END,
           updated_at = now()
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
    RETURNING id::text AS id, name, region, notes, created_at, updated_at
  `;

  const row = rows[0];
  return row === undefined ? null : toFarm(row);
}

/**
 * `deleted` | `not_found` | `has_live_fields`. The third is the reason this is not
 * a `boolean`: the future service must answer `409 CONFLICT`, and it cannot do
 * that from "nothing was deleted".
 *
 * **Concurrency.** The statements run in this order on purpose:
 *
 * 1. `SELECT … FOR UPDATE` locks the farm row. A concurrent `createField` holds
 *    `FOR SHARE` on the same row for the length of its transaction, so the two
 *    primitives serialise: whichever arrives second waits.
 * 2. The field check is a *separate statement*, therefore a separate snapshot
 *    under READ COMMITTED. A field insert that ran while step 1 waited has
 *    committed by the time step 1 returns, and this statement sees it. Folding the
 *    check into step 1 would read the snapshot taken before the wait and miss that
 *    insert.
 * 3. Only then the update.
 *
 * The inverse race — a `createField` that starts while this transaction holds the
 * lock — is refused by `createField` itself: its `FOR SHARE` waits, then re-checks
 * `deleted_at IS NULL` against the committed row and finds no parent.
 */
export async function softDeleteFarm(
  tx: TenantTransaction,
  farmId: string,
): Promise<FarmDeleteOutcome> {
  const locked = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.farms
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     FOR UPDATE
  `;

  if (locked.length === 0) return "not_found";

  const live = await tx.$queryRaw<{ present: number }[]>`
    SELECT 1 AS present
      FROM app.fields
     WHERE farm_id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     LIMIT 1
  `;

  if (live.length > 0) return "has_live_fields";

  await tx.$executeRaw`
    UPDATE app.farms
       SET deleted_at = now(), updated_at = now()
     WHERE id = ${farmId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;

  return "deleted";
}

export type FarmDeleteOutcome = "deleted" | "not_found" | "has_live_fields";

interface RawFarm {
  readonly id: string;
  readonly name: string;
  readonly region: string | null;
  readonly notes: string | null;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

function toFarm(row: RawFarm): Farm {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    notes: row.notes,
    createdAt: asDate(row.created_at),
    updatedAt: asDate(row.updated_at),
  };
}

/** `timestamptz` arrives as a `Date` through `pg`; a string is tolerated, not expected. */
function asDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
