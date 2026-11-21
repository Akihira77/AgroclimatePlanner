import { Inject, Injectable } from "@nestjs/common";
import type {
  Field as FieldResource,
  FieldCreateRequest,
  FieldListQuery,
  FieldUpdateRequest,
} from "@agroclimate/contracts";
import type {
  Field as FieldRow,
  FieldCreate,
  FieldListOptions,
  FieldUpdate,
  PrismaClient,
  TenantScope,
} from "@agroclimate/database";
import {
  createField,
  createTenantScope,
  findField,
  listAllFields,
  listFields,
  softDeleteField,
  updateField,
} from "@agroclimate/database";

import { DATABASE_CLIENT } from "../tokens.js";
import { rethrowFieldWriteError } from "./field-errors.js";

/**
 * Field CRUD over the Phase 4.2 primitives (`docs/architecture/farm-field-domain-contracts.md`
 * §6).
 *
 * Same structure as `FarmService`: the tenant id arrives from `request.auth.user.id`,
 * exactly one `withTenant` scope is opened per request, the transaction is handed to
 * the primitive, and this layer contains no SQL.
 *
 * The write paths are the only place a database refusal is translated: a
 * `FieldGeometryError` or a geometry CHECK violation becomes `400 VALIDATION_FAILED`,
 * everything else propagates unchanged (`field-errors.ts`). A `POST` whose parent is
 * missing, foreign, or deleted returns `null` — the caller names that a missing Farm,
 * never a missing Field.
 */
@Injectable()
export class FieldService {
  private readonly scope: TenantScope;

  constructor(@Inject(DATABASE_CLIENT) client: PrismaClient) {
    this.scope = createTenantScope(client);
  }

  async create(userId: string, input: FieldCreateRequest): Promise<FieldResource | null> {
    try {
      const row = await this.scope.withTenant(userId, (tx) =>
        createField(tx, input.farmId, createInput(input)),
      );
      return row === null ? null : toResource(row);
    } catch (error) {
      rethrowFieldWriteError(error);
    }
  }

  /**
   * `null` means the `farmId` filter named a Farm this tenant cannot see. Absent
   * filter lists the tenant's whole collection; the parent's state no longer
   * matters there, because a live field under a deleted farm cannot exist through
   * the API (farm deletion refuses while fields are live).
   */
  async list(
    userId: string,
    query: FieldListQuery,
  ): Promise<{ readonly items: readonly FieldResource[]; readonly total: number } | null> {
    const options: FieldListOptions = {
      limit: query.pageSize,
      offset: Math.min((query.page - 1) * query.pageSize, MAX_OFFSET),
      sort: query.sort,
    };

    const page = await this.scope.withTenant(userId, (tx) =>
      query.farmId === undefined
        ? listAllFields(tx, options)
        : listFields(tx, query.farmId, options),
    );

    if (page === null) return null;
    return { items: page.items.map(toResource), total: page.total };
  }

  /** Another tenant's field and a deleted one are both `null`. */
  async find(userId: string, fieldId: string): Promise<FieldResource | null> {
    const row = await this.scope.withTenant(userId, (tx) => findField(tx, fieldId));
    return row === null ? null : toResource(row);
  }

  async update(
    userId: string,
    fieldId: string,
    input: FieldUpdateRequest,
  ): Promise<FieldResource | null> {
    try {
      const row = await this.scope.withTenant(userId, (tx) =>
        updateField(tx, fieldId, updateInput(input)),
      );
      return row === null ? null : toResource(row);
    } catch (error) {
      rethrowFieldWriteError(error);
    }
  }

  /** `false` from another tenant, an already-deleted field, and a missing one alike. */
  async remove(userId: string, fieldId: string): Promise<boolean> {
    return this.scope.withTenant(userId, (tx) => softDeleteField(tx, fieldId));
  }
}

/** PostgreSQL's `integer` maximum, the widest `OFFSET` this API will pass. */
const MAX_OFFSET = 2_147_483_647;

function createInput(input: FieldCreateRequest): FieldCreate {
  return { name: input.name, geometry: input.geometry };
}

/**
 * Zod's `.optional()` infers `x?: T | undefined`; `FieldUpdate` under
 * `exactOptionalPropertyTypes` means "absent or `T`". Spreading only the keys the
 * caller sent preserves "absent means unchanged".
 */
function updateInput(input: FieldUpdateRequest): FieldUpdate {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.geometry === undefined ? {} : { geometry: input.geometry }),
  };
}

/**
 * `Date` → ISO-8601 UTC, and geometry exactly as `ST_AsGeoJSON` rendered it.
 * Mapping the seven public fields explicitly is what keeps `userId`, `deletedAt`,
 * and the agronomic columns from leaking through a spread.
 */
function toResource(row: FieldRow): FieldResource {
  // The stored geometry is readonly and typed as a tuple per position; the wire
  // type is a plain nested array. Copying is what makes the response independent
  // of the row object instead of a cast that hides the difference.
  const coordinates = row.geometry.coordinates.map((ring) =>
    ring.map(([longitude, latitude]) => [longitude, latitude] as [number, number]),
  );

  return {
    id: row.id,
    farmId: row.farmId,
    name: row.name,
    geometry: { type: "Polygon", coordinates },
    areaHa: row.areaHa,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
