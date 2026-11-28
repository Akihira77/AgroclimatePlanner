import type {
  CellResolution,
  CellResolutionRequest,
  Envelope,
  Field,
  FieldAgronomyProfile,
  FieldAgronomyUpdateRequest,
  FieldCreateRequest,
  FieldId,
  FieldListQuery,
  FieldUpdateRequest,
  PageMeta,
} from "@agroclimate/contracts";
import {
  cellResolutionRequestSchema,
  fieldAgronomyUpdateSchema,
  fieldCreateSchema,
  fieldIdSchema,
  fieldListQuerySchema,
  fieldUpdateSchema,
} from "@agroclimate/contracts";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import type { Response } from "express";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";
import { FieldService } from "./field.service.js";

/**
 * Field CRUD (`docs/architecture/farm-field-domain-contracts.md` §6.1).
 *
 * Flat collection and flat detail (`Q3`), behind the same `AuthGuard` as the Farm
 * routes, so session, `X-CSRF-Token` on mutations, and the `Origin` middleware
 * apply without a second mechanism.
 *
 * Two 404s are distinct on purpose. A write or a `farmId` filter whose *parent* is
 * missing answers `FARM_NOT_FOUND` — that is the noun the caller named. A field
 * that is missing, foreign, or deleted answers `FIELD_NOT_FOUND`, always identically.
 */
@Controller("fields")
@UseGuards(AuthGuard)
export class FieldController {
  constructor(private readonly fields: FieldService) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(fieldCreateSchema)) body: FieldCreateRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Envelope<Field>> {
    const field = await this.fields.create(authenticatedUserId(request), body);
    // `null` is the parent: not this tenant's, deleted, or nonexistent. The API
    // does not disclose which, and it does not pretend a Field was the problem.
    if (field === null) throw farmNotFound();

    response.location(`/v1/fields/${field.id}`);
    return { data: field };
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(fieldListQuerySchema)) query: FieldListQuery,
  ): Promise<Envelope<Field[], PageMeta>> {
    const page = await this.fields.list(authenticatedUserId(request), query);
    if (page === null) throw farmNotFound();

    return {
      data: [...page.items],
      meta: { page: query.page, pageSize: query.pageSize, total: page.total },
    };
  }

  @Get(":fieldId")
  async find(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<Envelope<Field>> {
    const field = await this.fields.find(authenticatedUserId(request), fieldId);
    if (field === null) throw fieldNotFound();
    return { data: field };
  }

  /** Last-write-wins (`Q8`); replacing `geometry` recomputes `areaHa` in the database. */
  @Patch(":fieldId")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(fieldUpdateSchema)) body: FieldUpdateRequest,
  ): Promise<Envelope<Field>> {
    const field = await this.fields.update(authenticatedUserId(request), fieldId, body);
    if (field === null) throw fieldNotFound();
    return { data: field };
  }

  /**
   * `200`, not `201`: the route answers with a resolution, and the only row it may
   * write is a global cell identity with no addressable URL — a `201` with no
   * `Location`, or one pointing at `/v1/fields/:id`, would both be untrue. The
   * second identical call returns the same body with the same status.
   *
   * A `fieldId` that is missing, foreign, or deleted answers `FIELD_NOT_FOUND`
   * before the registry is consulted. An unknown `(provider, model)` and a
   * position outside the grid answer `GRID_NOT_FOUND` and `CELL_NOT_FOUND`
   * respectively, and neither writes a cell.
   */
  @Post(":fieldId/resolve-cell")
  @HttpCode(200)
  async resolveCell(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(cellResolutionRequestSchema)) body: CellResolutionRequest,
  ): Promise<Envelope<CellResolution>> {
    const resolution = await this.fields.resolveCell(authenticatedUserId(request), fieldId, body);
    if (resolution === null) throw fieldNotFound();
    return { data: resolution };
  }

  @Get(":fieldId/agronomy")
  async getAgronomy(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<Envelope<FieldAgronomyProfile>> {
    const profile = await this.fields.getAgronomyProfile(authenticatedUserId(request), fieldId);
    if (profile === null) throw fieldNotFound();
    return { data: profile };
  }

  @Patch(":fieldId/agronomy")
  async updateAgronomy(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(fieldAgronomyUpdateSchema)) body: FieldAgronomyUpdateRequest,
  ): Promise<Envelope<FieldAgronomyProfile>> {
    const profile = await this.fields.updateAgronomyProfile(
      authenticatedUserId(request),
      fieldId,
      body,
    );
    if (profile === null) throw fieldNotFound();
    return { data: profile };
  }

  /** `204`; the row is soft-deleted, never removed. Farm deletion still refuses while a field is live. */
  @Delete(":fieldId")
  @HttpCode(204)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<void> {
    const removed = await this.fields.remove(authenticatedUserId(request), fieldId);
    if (!removed) throw fieldNotFound();
  }
}

function farmNotFound(): NotFoundException {
  return new NotFoundException({ code: "FARM_NOT_FOUND" });
}

function fieldNotFound(): NotFoundException {
  return new NotFoundException({ code: "FIELD_NOT_FOUND" });
}
