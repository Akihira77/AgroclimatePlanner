/**
 * The climate data plane's one write from the request path (`tables-climate.md`
 * §1, `climate-data-foundation.md` §8.2 step 5.2.6).
 *
 * `app.outlook_cells` is global — no `user_id`, no RLS — but it is still reached
 * through the caller's `TenantTransaction`, because a second way into a Prisma
 * transaction is how a pool acquires two connections and a scope leaks. The
 * tenant is not read here and never reaches the statement.
 *
 * Identity is exactly `(provider, model, cell_key)`, the triple
 * `outlook_cells_grid_key` already enforces. Nothing else identifies a cell:
 * not the model alone, not a `gridId`, not a hash, and not a concatenation.
 *
 * **The three identity columns and nothing more.** `app_api` holds `INSERT
 * (provider, model, cell_key)` (`migration.sql:737`) and no `UPDATE`, so
 * `ON CONFLICT … DO UPDATE` is not an option — it would need both a grant the
 * request path must not have and a served coordinate this function is not
 * allowed to invent. `served_lat`, `served_lon`, `elevation_m`,
 * `spatial_resolution_km` and `served_updated_at` stay NULL until `app_system`
 * observes a real payload. An identity row is not proof that a provider served
 * anything.
 *
 * Persisting a triple is not admission: `synthetic` is rejected by
 * `outlook_cells_provider_check`, and a row that the CHECK accepts says nothing
 * about `GridEvidence`. Provider-grid validation stays in the registry.
 */
import type { TenantTransaction } from "./tenant.js";

export interface OutlookCellIdentity {
  readonly provider: string;
  readonly model: string;
  readonly cellKey: string;
}

/**
 * The insert reported a conflict and the lookup could not see the row. That is a
 * contradiction, not a retryable condition: it means the two statements disagree
 * about the triple, so the caller must hear about it instead of receiving a
 * fabricated id.
 */
export class OutlookCellIdentityError extends Error {
  override readonly name = "OutlookCellIdentityError";
}

/**
 * The persisted id of one grid node, created on first reference.
 *
 * `DO NOTHING` inserts nothing when the triple exists, and `RETURNING` therefore
 * yields no row — so the follow-up `SELECT` is the only way to learn the id, and
 * it must name all three columns. Under READ COMMITTED (Prisma's default, and
 * what `withTenant` opens) a concurrent inserter blocks this statement until it
 * commits, and the `SELECT` then takes a fresh snapshot that sees the row. If it
 * still returns nothing the pair of statements is broken, so this throws rather
 * than inventing an id or handing back `undefined`.
 */
export async function upsertCell(
  tx: TenantTransaction,
  cell: OutlookCellIdentity,
): Promise<string> {
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.outlook_cells (provider, model, cell_key)
    VALUES (${cell.provider}, ${cell.model}, ${cell.cellKey})
    ON CONFLICT (provider, model, cell_key) DO NOTHING
    RETURNING id::text AS id
  `;

  if (inserted[0] !== undefined) return inserted[0].id;

  const existing = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.outlook_cells
     WHERE provider = ${cell.provider}
       AND model = ${cell.model}
       AND cell_key = ${cell.cellKey}
  `;

  const row = existing[0];
  if (row === undefined) {
    throw new OutlookCellIdentityError(
      `outlook cell ${cell.provider}/${cell.model}/${cell.cellKey} conflicted but could not be read back`,
    );
  }
  return row.id;
}
