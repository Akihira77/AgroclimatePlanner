import type {
  Envelope,
  Farm,
  FarmCreateRequest,
  FarmId,
  FarmListQuery,
  FarmUpdateRequest,
  PageMeta,
} from "@agroclimate/contracts";
import {
  farmCreateSchema,
  farmIdSchema,
  farmListQuerySchema,
  farmUpdateSchema,
} from "@agroclimate/contracts";
import {
  Body,
  ConflictException,
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
import { FarmService } from "./farm.service.js";

/**
 * Farm CRUD (`docs/architecture/farm-field-domain-contracts.md` §6.1, rows 1–5).
 *
 * `AuthGuard` is the whole security contract: it authenticates the session,
 * attaches the subject, and — because it derives the requirement from the HTTP
 * method — enforces `X-CSRF-Token` on every `POST`/`PATCH`/`DELETE` here. There is
 * no second authentication check and no per-route CSRF annotation to forget.
 * `Origin` was already validated by middleware, before the body was parsed.
 *
 * The subject is read from `request.auth` and nowhere else: no path, query, or
 * body field can name an owner.
 */
@Controller("farms")
@UseGuards(AuthGuard)
export class FarmController {
  constructor(private readonly farms: FarmService) {}

  @Post()
  async create(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(farmCreateSchema)) body: FarmCreateRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Envelope<Farm>> {
    const farm = await this.farms.create(authenticatedUserId(request), body);
    // Relative on purpose: `Location` may be relative to the effective request
    // URI, and the API is served behind a single origin. No scheme or host is
    // invented from a `Host` header the server does not trust.
    response.location(`/v1/farms/${farm.id}`);
    return { data: farm };
  }

  @Get()
  async list(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(farmListQuerySchema)) query: FarmListQuery,
  ): Promise<Envelope<Farm[], PageMeta>> {
    const page = await this.farms.list(authenticatedUserId(request), query);
    return {
      data: [...page.items],
      meta: { page: query.page, pageSize: query.pageSize, total: page.total },
    };
  }

  @Get(":farmId")
  async find(
    @Req() request: AuthenticatedRequest,
    @Param("farmId", new ZodValidationPipe(farmIdSchema)) farmId: FarmId,
  ): Promise<Envelope<Farm>> {
    const farm = await this.farms.find(authenticatedUserId(request), farmId);
    if (farm === null) throw farmNotFound();
    return { data: farm };
  }

  /**
   * Returns the updated row, so a client does not have to re-read to learn the
   * server's `updatedAt`. No `If-Match`: `Q8` approved last-write-wins for v1.
   */
  @Patch(":farmId")
  async update(
    @Req() request: AuthenticatedRequest,
    @Param("farmId", new ZodValidationPipe(farmIdSchema)) farmId: FarmId,
    @Body(new ZodValidationPipe(farmUpdateSchema)) body: FarmUpdateRequest,
  ): Promise<Envelope<Farm>> {
    const farm = await this.farms.update(authenticatedUserId(request), farmId, body);
    if (farm === null) throw farmNotFound();
    return { data: farm };
  }

  /**
   * `204` for a soft delete, `404` for a farm that is not this tenant's (and for
   * one already deleted), `409` when live fields still reference it (`Q2`). The
   * database primitive has already made that decision under a row lock; this
   * handler only names it in HTTP terms.
   */
  @Delete(":farmId")
  @HttpCode(204)
  async remove(
    @Req() request: AuthenticatedRequest,
    @Param("farmId", new ZodValidationPipe(farmIdSchema)) farmId: FarmId,
  ): Promise<void> {
    const outcome = await this.farms.remove(authenticatedUserId(request), farmId);
    if (outcome === "not_found") throw farmNotFound();
    if (outcome === "has_live_fields") throw new ConflictException();
  }
}

/** The branded `404` family, so the client learns which noun was missing. */
function farmNotFound(): NotFoundException {
  return new NotFoundException({ code: "FARM_NOT_FOUND" });
}
