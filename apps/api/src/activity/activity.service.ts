import type {
  FieldObservation,
  FieldObservationCreateRequest,
  Harvest,
  HarvestCreateRequest,
  Planting,
  PlantingCreateRequest,
  PlantingListQuery,
  PlantingStatus,
} from "@agroclimate/contracts";
import {
  createFieldObservation,
  createHarvest,
  createPlanting,
  createTenantScope,
  findPlanting,
  listFieldObservations,
  listHarvests,
  listPlantings,
  updatePlantingStatus,
} from "@agroclimate/database";
import type {
  FieldObservationRecord,
  HarvestRecord,
  PlantingRecord,
  PrismaClient,
  TenantScope,
} from "@agroclimate/database";
import { Inject, Injectable } from "@nestjs/common";

import { DATABASE_CLIENT } from "../tokens.js";

/**
 * Planting, harvest, and field observation workflows (Phase 3.6 & 3.7).
 */
@Injectable()
export class ActivityService {
  private readonly tenants: TenantScope;

  constructor(@Inject(DATABASE_CLIENT) prisma: PrismaClient) {
    this.tenants = createTenantScope(prisma);
  }

  async createPlanting(userId: string, input: PlantingCreateRequest): Promise<Planting> {
    const row = await this.tenants.withTenant(userId, (tx) => createPlanting(tx, input));
    return toPlanting(row);
  }

  async listPlantings(userId: string, query: PlantingListQuery): Promise<readonly Planting[]> {
    const rows = await this.tenants.withTenant(userId, (tx) =>
      listPlantings(tx, {
        ...(query.fieldId === undefined ? {} : { fieldId: query.fieldId }),
        ...(query.status === undefined ? {} : { status: query.status }),
      }),
    );
    return rows.map(toPlanting);
  }

  async findPlanting(userId: string, plantingId: string): Promise<Planting | null> {
    const row = await this.tenants.withTenant(userId, (tx) => findPlanting(tx, plantingId));
    return row === null ? null : toPlanting(row);
  }

  async updatePlantingStatus(
    userId: string,
    plantingId: string,
    status: PlantingStatus,
  ): Promise<Planting | null> {
    const row = await this.tenants.withTenant(userId, (tx) =>
      updatePlantingStatus(tx, plantingId, status),
    );
    return row === null ? null : toPlanting(row);
  }

  async createHarvest(
    userId: string,
    plantingId: string,
    input: HarvestCreateRequest,
  ): Promise<Harvest | null> {
    const row = await this.tenants.withTenant(userId, (tx) =>
      createHarvest(tx, plantingId, {
        harvestedAt: input.harvestedAt,
        yieldKg: input.yieldKg,
        ...(input.notes === undefined ? {} : { notes: input.notes }),
      }),
    );
    return row === null ? null : toHarvest(row);
  }

  async listHarvests(
    userId: string,
    plantingId: string,
  ): Promise<{ readonly items: readonly Harvest[]; readonly totalYieldKg: number } | null> {
    const result = await this.tenants.withTenant(userId, (tx) => listHarvests(tx, plantingId));
    if (result === null) return null;
    return {
      items: result.items.map(toHarvest),
      totalYieldKg: result.totalYieldKg,
    };
  }

  async createFieldObservation(
    userId: string,
    fieldId: string,
    input: FieldObservationCreateRequest,
  ): Promise<FieldObservation | null> {
    const row = await this.tenants.withTenant(userId, (tx) =>
      createFieldObservation(tx, fieldId, {
        kind: input.kind,
        observedAt: input.observedAt,
        ...(input.value === undefined ? {} : { value: input.value }),
        ...(input.unit === undefined ? {} : { unit: input.unit }),
        ...(input.method === undefined ? {} : { method: input.method }),
      }),
    );
    return row === null ? null : toObservation(row);
  }

  async listFieldObservations(
    userId: string,
    fieldId: string,
  ): Promise<readonly FieldObservation[] | null> {
    const rows = await this.tenants.withTenant(userId, (tx) => listFieldObservations(tx, fieldId));
    return rows === null ? null : rows.map(toObservation);
  }
}

function toPlanting(row: PlantingRecord): Planting {
  return {
    id: row.id,
    fieldId: row.fieldId,
    cultivarId: row.cultivarId,
    cultivarName: row.cultivarName,
    cropSlug: row.cropSlug,
    cropNameId: row.cropNameId,
    plantedAt: row.plantedAt,
    cycleStartUsed: row.cycleStartUsed,
    areaPlantedHa: row.areaPlantedHa,
    status: row.status,
    expectedHarvestEarliest: row.expectedHarvestEarliest,
    expectedHarvestTypical: row.expectedHarvestTypical,
    expectedHarvestLatest: row.expectedHarvestLatest,
    totalYieldKg: row.totalYieldKg,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toHarvest(row: HarvestRecord): Harvest {
  return {
    id: row.id,
    plantingId: row.plantingId,
    harvestedAt: row.harvestedAt,
    yieldKg: row.yieldKg,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function toObservation(row: FieldObservationRecord): FieldObservation {
  return {
    id: row.id,
    fieldId: row.fieldId,
    kind: row.kind,
    value: row.value,
    unit: row.unit,
    observedAt: row.observedAt.toISOString(),
    method: row.method,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
