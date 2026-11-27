import { Inject, Injectable } from "@nestjs/common";
import type {
  ClimateOutlook,
  ClimateOutlookQuery,
  GridRegistry,
  GridRegistryEntry,
} from "@agroclimate/contracts";
import {
  calendarMonthOf,
  climateOutlookSchema,
  createSpatialResolution,
} from "@agroclimate/contracts";
import { assembleOutlookHorizon } from "@agroclimate/climate-core";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import {
  createTenantScope,
  loadActiveOutlookMonths,
  selectFieldAnchor,
} from "@agroclimate/database";

import { rethrowCellResolutionError } from "../http/resolution-errors.js";
import { DATABASE_CLIENT, GRID_REGISTRY } from "../tokens.js";
import { jakartaMonthOf } from "./calendar.js";

/**
 * `GET /v1/climate/outlook` — Phase 5.7B.
 *
 * Reads the months the aggregator materialised and **presents** them. It derives
 * nothing: no value is computed, converted, interpolated, or filled from a
 * neighbouring month, and a month with no stored row is answered as absent with
 * `pending` — every lead month 1–12 has an approved source, so no month has a
 * structural "nothing was asked for" answer any more.
 *
 * A seasonal month also carries read-time `availability` (`fresh`/`stale`). That
 * is computed from the row's forecast run and the current instant, never stored.
 *
 * The field → cell step is the same one `POST /v1/fields/:fieldId/resolve-cell`
 * performs, and deliberately so: `field_outlook_cells` has no writer (5.2 defers
 * it), so there is no persisted mapping to read. The anchor comes from the field's
 * stored geometry, the grid from the registry, and the cell key from the resolver —
 * nothing is guessed from a coordinate or a model name.
 *
 * **Read-only.** It calls no `upsertCell`, opens no `ingestion_runs`, and holds no
 * row lock: a `GET` that mints a cell would turn a read into a migration, and a
 * cell created here would be a cell the aggregator never visited.
 */
@Injectable()
export class ClimateService {
  private readonly scope: TenantScope;

  constructor(
    @Inject(DATABASE_CLIENT) client: PrismaClient,
    @Inject(GRID_REGISTRY) private readonly grids: GridRegistry,
  ) {
    this.scope = createTenantScope(client);
  }

  /**
   * `null` means the field is missing, foreign, or deleted. That answer precedes
   * every grid lookup, so a foreign `fieldId` cannot even become a registry query.
   *
   * `GRID_NOT_FOUND` and `CELL_NOT_FOUND` reach the client from the resolver, with
   * the same codes and the same reasoning as the resolution route: no grid is
   * configured for that pair, and a position outside the grid has no node — neither
   * fallback exists, and neither is faked.
   */
  async outlook(userId: string, query: ClimateOutlookQuery): Promise<ClimateOutlook | null> {
    const firstMonth = query.firstMonth ?? jakartaMonthOf(new Date());

    try {
      const stored = await this.scope.withTenant(userId, async (tx) => {
        const anchor = await selectFieldAnchor(tx, query.fieldId);
        if (anchor === null) return null;

        const entry = this.registryEntry(query);
        const resolution = createSpatialResolution(entry, { lat: anchor.lat, lon: anchor.lon });

        return loadActiveOutlookMonths(tx, {
          provider: query.provider,
          model: query.model,
          cellKey: resolution.cellKey,
          // Twelve consecutive months, so the range is the horizon and the index
          // on `(outlook_cell_id, month)` covers it without a per-month query.
          fromMonth: firstMonth,
          toMonth: calendarMonthOf(firstMonth, 12),
        });
      });

      if (stored === null) return null;

      const assembled = assembleOutlookHorizon({
        firstMonth,
        rows: stored.months,
        // Freshness is evaluated here, at read time, against the same clock the
        // default `firstMonth` uses. Nothing stored is rewritten.
        now: new Date().toISOString(),
      });
      if (!assembled.ok) {
        // A row that contradicts the contract is a stored-state defect, not a
        // client error: no input can make it serveable, and reporting it as
        // `pending` would hide a month the cell actually has.
        throw new Error(
          `climate outlook for field ${query.fieldId} cannot be served: ${assembled.message}`,
        );
      }

      const parsed = climateOutlookSchema.safeParse({
        fieldId: query.fieldId,
        provider: query.provider,
        model: query.model,
        firstMonth,
        unit: "mm",
        months: assembled.value.months,
      });
      if (!parsed.success) {
        throw new Error(
          `climate outlook for field ${query.fieldId} does not satisfy its response contract: ${parsed.error.issues[0]?.path.join(".") ?? "root"}`,
        );
      }
      return parsed.data;
    } catch (error) {
      rethrowCellResolutionError(error);
    }
  }

  /**
   * The entry the registry already holds, rebuilt from its own accessors so this
   * layer cannot construct a spec, change an evidence value, or invent a grid.
   * `specFor` throws `unknown_model` first, so `evidenceFor` is only reached for a
   * pair that exists.
   */
  private registryEntry(key: { provider: string; model: string }): GridRegistryEntry {
    const spec = this.grids.specFor({ provider: key.provider, model: key.model });
    const evidence = this.grids.evidenceFor({ provider: key.provider, model: key.model });
    return { provider: key.provider, model: key.model, spec, evidence };
  }
}
