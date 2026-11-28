import type { PlantingCycleStart, PlantingStatus } from "@agroclimate/contracts";

import { Prisma } from "./generated/prisma/client.js";
import type { TenantTransaction } from "./tenant.js";

/**
 * Planting and harvest persistence (Phase 3.6, `OPEN-09` settled 2026-11-28).
 *
 * Tenant ownership is always read from `current_setting('app.user_id', true)`
 * inside `withTenant`, matching the RLS predicate. Soft-deleted fields are
 * excluded via `f.deleted_at IS NULL`.
 */

export class PlantingReferenceError extends Error {
  readonly code: "field_not_found" | "cultivar_not_found";

  constructor(code: PlantingReferenceError["code"], message: string) {
    super(message);
    this.name = "PlantingReferenceError";
    this.code = code;
  }
}

export class InvalidPlantingTransitionError extends Error {
  readonly from: PlantingStatus;
  readonly to: PlantingStatus;

  constructor(from: PlantingStatus, to: PlantingStatus) {
    super(`cannot transition planting status from ${from} to ${to}`);
    this.name = "InvalidPlantingTransitionError";
    this.from = from;
    this.to = to;
  }
}

export class HarvestDateError extends Error {
  readonly plantedAt: string;
  readonly harvestedAt: string;

  constructor(plantedAt: string, harvestedAt: string) {
    super(`harvestedAt (${harvestedAt}) precedes plantedAt (${plantedAt})`);
    this.name = "HarvestDateError";
    this.plantedAt = plantedAt;
    this.harvestedAt = harvestedAt;
  }
}

export interface PlantingRecord {
  readonly id: string;
  readonly fieldId: string;
  readonly cultivarId: string;
  readonly cultivarName: string;
  readonly cropSlug: string;
  readonly cropNameId: string;
  readonly plantedAt: string;
  readonly cycleStartUsed: PlantingCycleStart;
  readonly areaPlantedHa: number;
  readonly status: PlantingStatus;
  readonly expectedHarvestEarliest: string;
  readonly expectedHarvestTypical: string;
  readonly expectedHarvestLatest: string;
  readonly totalYieldKg: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface PlantingCreateInput {
  readonly fieldId: string;
  readonly cultivarId: string;
  readonly plantedAt: string;
  readonly cycleStartUsed: PlantingCycleStart;
  readonly areaPlantedHa: number;
}

export interface PlantingListFilters {
  readonly fieldId?: string;
  readonly status?: PlantingStatus;
}

export interface HarvestRecord {
  readonly id: string;
  readonly plantingId: string;
  readonly harvestedAt: string;
  readonly yieldKg: number;
  readonly notes: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface HarvestCreateInput {
  readonly harvestedAt: string;
  readonly yieldKg: number;
  readonly notes?: string | null;
}

export interface HarvestListResult {
  readonly items: readonly HarvestRecord[];
  readonly totalYieldKg: number;
}

interface RawPlanting {
  readonly id: string;
  readonly field_id: string;
  readonly cultivar_id: string;
  readonly cultivar_name: string;
  readonly crop_slug: string;
  readonly crop_name_id: string;
  readonly planted_at: string;
  readonly cycle_start_used: PlantingCycleStart;
  readonly area_planted_ha: number;
  readonly status: PlantingStatus;
  readonly expected_harvest_earliest: string;
  readonly expected_harvest_typical: string;
  readonly expected_harvest_latest: string;
  readonly total_yield_kg: number;
  readonly created_at: Date;
  readonly updated_at: Date;
}

interface RawHarvest {
  readonly id: string;
  readonly planting_id: string;
  readonly harvested_at: string;
  readonly yield_kg: string | number;
  readonly notes: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toPlanting(row: RawPlanting): PlantingRecord {
  return {
    id: row.id,
    fieldId: row.field_id,
    cultivarId: row.cultivar_id,
    cultivarName: row.cultivar_name,
    cropSlug: row.crop_slug,
    cropNameId: row.crop_name_id,
    plantedAt: row.planted_at,
    cycleStartUsed: row.cycle_start_used,
    areaPlantedHa: row.area_planted_ha,
    status: row.status,
    expectedHarvestEarliest: row.expected_harvest_earliest,
    expectedHarvestTypical: row.expected_harvest_typical,
    expectedHarvestLatest: row.expected_harvest_latest,
    totalYieldKg: Number(row.total_yield_kg),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toHarvest(row: RawHarvest): HarvestRecord {
  return {
    id: row.id,
    plantingId: row.planting_id,
    harvestedAt: row.harvested_at,
    yieldKg: Number(row.yield_kg),
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createPlanting(
  tx: TenantTransaction,
  input: PlantingCreateInput,
): Promise<PlantingRecord> {
  const fieldRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.fields
     WHERE id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;
  if (fieldRows.length === 0) {
    throw new PlantingReferenceError("field_not_found", `field not found: ${input.fieldId}`);
  }

  const cultivarRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.cultivars
     WHERE id = ${input.cultivarId}::uuid
  `;
  if (cultivarRows.length === 0) {
    throw new PlantingReferenceError(
      "cultivar_not_found",
      `cultivar not found: ${input.cultivarId}`,
    );
  }

  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.plantings (
      user_id,
      field_id,
      cultivar_id,
      planted_at,
      cycle_start_used,
      area_planted_ha,
      status
    )
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${input.fieldId}::uuid,
      ${input.cultivarId}::uuid,
      ${input.plantedAt}::date,
      ${input.cycleStartUsed},
      ${input.areaPlantedHa},
      'active'
    )
    RETURNING id::text AS id
  `;

  const row = inserted[0];
  if (row === undefined) throw new Error("planting insert returned no row");

  const planting = await findPlanting(tx, row.id);
  if (planting === null) throw new Error("inserted planting could not be reloaded");
  return planting;
}

export async function listPlantings(
  tx: TenantTransaction,
  filters: PlantingListFilters = {},
): Promise<readonly PlantingRecord[]> {
  const conditions: Prisma.Sql[] = [
    Prisma.sql`p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid`,
    Prisma.sql`f.deleted_at IS NULL`,
  ];

  if (filters.fieldId !== undefined) {
    conditions.push(Prisma.sql`p.field_id = ${filters.fieldId}::uuid`);
  }
  if (filters.status !== undefined) {
    conditions.push(Prisma.sql`p.status = ${filters.status}`);
  }

  const rows = await tx.$queryRaw<RawPlanting[]>`
    SELECT p.id::text AS id,
           p.field_id::text AS field_id,
           p.cultivar_id::text AS cultivar_id,
           c.name AS cultivar_name,
           cr.slug AS crop_slug,
           cr.name_id AS crop_name_id,
           p.planted_at::text AS planted_at,
           p.cycle_start_used,
           p.area_planted_ha,
           p.status,
           (p.planted_at + (c.duration_days_min - 1))::text AS expected_harvest_earliest,
           (p.planted_at + (c.duration_days_typical - 1))::text AS expected_harvest_typical,
           (p.planted_at + (c.duration_days_max - 1))::text AS expected_harvest_latest,
           COALESCE(h.total_yield_kg, 0)::double precision AS total_yield_kg,
           p.created_at,
           p.updated_at
      FROM app.plantings p
      JOIN app.fields f ON f.id = p.field_id AND f.user_id = p.user_id
      JOIN app.cultivars c ON c.id = p.cultivar_id
      JOIN app.crops cr ON cr.id = c.crop_id
      LEFT JOIN (
        SELECT planting_id, SUM(yield_kg) AS total_yield_kg
          FROM app.harvests
         WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
         GROUP BY planting_id
      ) h ON h.planting_id = p.id
     WHERE ${Prisma.join(conditions, " AND ")}
     ORDER BY p.planted_at DESC, p.id DESC
  `;

  return rows.map(toPlanting);
}

export async function findPlanting(
  tx: TenantTransaction,
  plantingId: string,
): Promise<PlantingRecord | null> {
  const rows = await tx.$queryRaw<RawPlanting[]>`
    SELECT p.id::text AS id,
           p.field_id::text AS field_id,
           p.cultivar_id::text AS cultivar_id,
           c.name AS cultivar_name,
           cr.slug AS crop_slug,
           cr.name_id AS crop_name_id,
           p.planted_at::text AS planted_at,
           p.cycle_start_used,
           p.area_planted_ha,
           p.status,
           (p.planted_at + (c.duration_days_min - 1))::text AS expected_harvest_earliest,
           (p.planted_at + (c.duration_days_typical - 1))::text AS expected_harvest_typical,
           (p.planted_at + (c.duration_days_max - 1))::text AS expected_harvest_latest,
           COALESCE(h.total_yield_kg, 0)::double precision AS total_yield_kg,
           p.created_at,
           p.updated_at
      FROM app.plantings p
      JOIN app.fields f ON f.id = p.field_id AND f.user_id = p.user_id
      JOIN app.cultivars c ON c.id = p.cultivar_id
      JOIN app.crops cr ON cr.id = c.crop_id
      LEFT JOIN (
        SELECT planting_id, SUM(yield_kg) AS total_yield_kg
          FROM app.harvests
         WHERE user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
         GROUP BY planting_id
      ) h ON h.planting_id = p.id
     WHERE p.id = ${plantingId}::uuid
       AND p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND f.deleted_at IS NULL
  `;

  const row = rows[0];
  return row === undefined ? null : toPlanting(row);
}

export async function updatePlantingStatus(
  tx: TenantTransaction,
  plantingId: string,
  nextStatus: PlantingStatus,
): Promise<PlantingRecord | null> {
  const existing = await tx.$queryRaw<{ status: PlantingStatus }[]>`
    SELECT p.status
      FROM app.plantings p
      JOIN app.fields f ON f.id = p.field_id AND f.user_id = p.user_id
     WHERE p.id = ${plantingId}::uuid
       AND p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND f.deleted_at IS NULL
     FOR UPDATE OF p
  `;

  const current = existing[0];
  if (current === undefined) return null;

  if (current.status !== "active" && current.status !== nextStatus) {
    throw new InvalidPlantingTransitionError(current.status, nextStatus);
  }

  if (current.status !== nextStatus) {
    await tx.$queryRaw`
      UPDATE app.plantings
         SET status = ${nextStatus},
             updated_at = now()
       WHERE id = ${plantingId}::uuid
         AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
    `;
  }

  return findPlanting(tx, plantingId);
}

export async function createHarvest(
  tx: TenantTransaction,
  plantingId: string,
  input: HarvestCreateInput,
): Promise<HarvestRecord | null> {
  const plantingRows = await tx.$queryRaw<{ planted_at: string }[]>`
    SELECT p.planted_at::text AS planted_at
      FROM app.plantings p
      JOIN app.fields f ON f.id = p.field_id AND f.user_id = p.user_id
     WHERE p.id = ${plantingId}::uuid
       AND p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND f.deleted_at IS NULL
  `;

  const planting = plantingRows[0];
  if (planting === undefined) return null;

  if (input.harvestedAt < planting.planted_at) {
    throw new HarvestDateError(planting.planted_at, input.harvestedAt);
  }

  const rows = await tx.$queryRaw<RawHarvest[]>`
    INSERT INTO app.harvests (
      user_id,
      planting_id,
      harvested_at,
      yield_kg,
      notes
    )
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${plantingId}::uuid,
      ${input.harvestedAt}::date,
      ${input.yieldKg},
      ${input.notes ?? null}
    )
    RETURNING id::text AS id,
              planting_id::text AS planting_id,
              harvested_at::text AS harvested_at,
              yield_kg,
              notes,
              created_at,
              updated_at
  `;

  const row = rows[0];
  if (row === undefined) throw new Error("harvest insert returned no row");
  return toHarvest(row);
}

export async function listHarvests(
  tx: TenantTransaction,
  plantingId: string,
): Promise<HarvestListResult | null> {
  const exists = await tx.$queryRaw<{ id: string }[]>`
    SELECT p.id::text AS id
      FROM app.plantings p
      JOIN app.fields f ON f.id = p.field_id AND f.user_id = p.user_id
     WHERE p.id = ${plantingId}::uuid
       AND p.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND f.deleted_at IS NULL
  `;
  if (exists.length === 0) return null;

  const rows = await tx.$queryRaw<RawHarvest[]>`
    SELECT id::text AS id,
           planting_id::text AS planting_id,
           harvested_at::text AS harvested_at,
           yield_kg,
           notes,
           created_at,
           updated_at
      FROM app.harvests
     WHERE planting_id = ${plantingId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
     ORDER BY harvested_at DESC, id DESC
  `;

  const totals = await tx.$queryRaw<{ total_yield_kg: number }[]>`
    SELECT COALESCE(SUM(yield_kg), 0)::double precision AS total_yield_kg
      FROM app.harvests
     WHERE planting_id = ${plantingId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  `;

  return {
    items: rows.map(toHarvest),
    totalYieldKg: Number(totals[0]?.total_yield_kg ?? 0),
  };
}
