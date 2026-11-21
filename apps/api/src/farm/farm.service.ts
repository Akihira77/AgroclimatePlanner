import { Inject, Injectable } from "@nestjs/common";
import type {
  Farm as FarmResource,
  FarmCreateRequest,
  FarmListQuery,
  FarmUpdateRequest,
} from "@agroclimate/contracts";
import type {
  Farm as FarmRow,
  FarmCreate,
  FarmDeleteOutcome,
  FarmUpdate,
  PrismaClient,
  TenantScope,
} from "@agroclimate/database";
import {
  createFarm,
  createTenantScope,
  findFarm,
  listFarms,
  softDeleteFarm,
  updateFarm,
} from "@agroclimate/database";

import { DATABASE_CLIENT } from "../tokens.js";

/**
 * Farm CRUD over the Phase 4.2 primitives (`docs/architecture/farm-field-domain-contracts.md`
 * §6).
 *
 * The tenant id is passed in by the controller from `request.auth.user.id` and
 * reaches the database only as `app.user_id` inside `withTenant`. It is never a
 * query parameter, a body field, or a SQL argument, so there is nothing here a
 * caller could override.
 *
 * Exactly one tenant scope per request: the scope is opened here and the
 * transaction is handed to the primitive. The primitives do not open their own
 * (a nested `withTenant` is rejected by design), and this layer contains no SQL.
 */
@Injectable()
export class FarmService {
  private readonly scope: TenantScope;

  constructor(@Inject(DATABASE_CLIENT) client: PrismaClient) {
    this.scope = createTenantScope(client);
  }

  async create(userId: string, input: FarmCreateRequest): Promise<FarmResource> {
    const row = await this.scope.withTenant(userId, (tx) => createFarm(tx, createInput(input)));
    return toResource(row);
  }

  /**
   * `offset` is clamped to the largest `integer`: `page` has no upper bound beyond
   * being an integer, and `(page - 1) * pageSize` can otherwise exceed what
   * PostgreSQL accepts as an `OFFSET` argument. A page past the end is a valid
   * empty answer, not an error.
   */
  async list(
    userId: string,
    query: FarmListQuery,
  ): Promise<{ readonly items: readonly FarmResource[]; readonly total: number }> {
    const offset = Math.min((query.page - 1) * query.pageSize, MAX_OFFSET);
    const page = await this.scope.withTenant(userId, (tx) =>
      listFarms(tx, { limit: query.pageSize, offset, sort: query.sort }),
    );
    return { items: page.items.map(toResource), total: page.total };
  }

  /** `null` covers both "does not exist" and "belongs to another tenant". */
  async find(userId: string, farmId: string): Promise<FarmResource | null> {
    const row = await this.scope.withTenant(userId, (tx) => findFarm(tx, farmId));
    return row === null ? null : toResource(row);
  }

  async update(
    userId: string,
    farmId: string,
    input: FarmUpdateRequest,
  ): Promise<FarmResource | null> {
    const row = await this.scope.withTenant(userId, (tx) =>
      updateFarm(tx, farmId, updateInput(input)),
    );
    return row === null ? null : toResource(row);
  }

  /**
   * The concurrency-sensitive decision lives in the primitive, not here. A
   * check-then-delete in this service would reintroduce the race the database
   * layer already closes.
   */
  async remove(userId: string, farmId: string): Promise<FarmDeleteOutcome> {
    return this.scope.withTenant(userId, (tx) => softDeleteFarm(tx, farmId));
  }
}

/**
 * Zod's `.optional()` infers `x?: T | undefined`, while `FarmCreate` under
 * `exactOptionalPropertyTypes` means "absent or `T`". Spreading only the keys the
 * caller sent states that difference once instead of widening the database type
 * and losing the distinction the primitive relies on.
 */
function createInput(input: FarmCreateRequest): FarmCreate {
  return {
    name: input.name,
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

/** Same rule for PATCH: an absent key must stay absent, or it would mean "clear". */
function updateInput(input: FarmUpdateRequest): FarmUpdate {
  return {
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.region === undefined ? {} : { region: input.region }),
    ...(input.notes === undefined ? {} : { notes: input.notes }),
  };
}

/** PostgreSQL's `integer` maximum, the widest `OFFSET` this API will pass. */
const MAX_OFFSET = 2_147_483_647;

/**
 * `Date` → ISO-8601 UTC, which is what `farmSchema` accepts. Mapping the six
 * public fields explicitly is what keeps `userId` and `deletedAt` from leaking
 * through a spread the day the row gains a column.
 */
function toResource(row: FarmRow): FarmResource {
  return {
    id: row.id,
    name: row.name,
    region: row.region,
    notes: row.notes,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
