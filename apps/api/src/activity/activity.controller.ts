import type {
  Envelope,
  FieldId,
  FieldObservation,
  FieldObservationCreateRequest,
  Harvest,
  HarvestCreateRequest,
  HarvestListMeta,
  Planting,
  PlantingCreateRequest,
  PlantingId,
  PlantingListQuery,
  PlantingUpdateRequest,
} from "@agroclimate/contracts";
import {
  fieldIdSchema,
  fieldObservationCreateSchema,
  harvestCreateSchema,
  plantingCreateSchema,
  plantingIdSchema,
  plantingListQuerySchema,
  plantingUpdateSchema,
} from "@agroclimate/contracts";
import {
  HarvestDateError,
  InvalidPlantingTransitionError,
  ObservationFutureDateError,
  PlantingReferenceError,
} from "@agroclimate/database";
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
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
import { ActivityService } from "./activity.service.js";

/**
 * Planting, harvest, and local field observation endpoints (Phase 3.6 & 3.7).
 */
@Controller()
@UseGuards(AuthGuard)
export class ActivityController {
  constructor(private readonly activity: ActivityService) {}

  @Post("plantings")
  async createPlanting(
    @Req() request: AuthenticatedRequest,
    @Body(new ZodValidationPipe(plantingCreateSchema)) body: PlantingCreateRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Envelope<Planting>> {
    try {
      const planting = await this.activity.createPlanting(authenticatedUserId(request), body);
      response.location(`/v1/plantings/${planting.id}`);
      return { data: planting };
    } catch (error) {
      if (error instanceof PlantingReferenceError) {
        throw new NotFoundException({
          code: "NOT_FOUND",
          message: error.code === "field_not_found" ? "Field not found" : "Cultivar not found",
        });
      }
      throw error;
    }
  }

  @Get("plantings")
  async listPlantings(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(plantingListQuerySchema)) query: PlantingListQuery,
  ): Promise<Envelope<readonly Planting[]>> {
    const items = await this.activity.listPlantings(authenticatedUserId(request), query);
    return { data: items };
  }

  @Get("plantings/:plantingId")
  async findPlanting(
    @Req() request: AuthenticatedRequest,
    @Param("plantingId", new ZodValidationPipe(plantingIdSchema)) plantingId: PlantingId,
  ): Promise<Envelope<Planting>> {
    const planting = await this.activity.findPlanting(authenticatedUserId(request), plantingId);
    if (planting === null) throw plantingNotFound();
    return { data: planting };
  }

  @Patch("plantings/:plantingId")
  async updatePlantingStatus(
    @Req() request: AuthenticatedRequest,
    @Param("plantingId", new ZodValidationPipe(plantingIdSchema)) plantingId: PlantingId,
    @Body(new ZodValidationPipe(plantingUpdateSchema)) body: PlantingUpdateRequest,
  ): Promise<Envelope<Planting>> {
    try {
      const planting = await this.activity.updatePlantingStatus(
        authenticatedUserId(request),
        plantingId,
        body.status,
      );
      if (planting === null) throw plantingNotFound();
      return { data: planting };
    } catch (error) {
      if (error instanceof InvalidPlantingTransitionError) {
        throw new ConflictException({
          code: "CONFLICT",
          message: `Cannot transition planting from ${error.from} to ${error.to}`,
        });
      }
      throw error;
    }
  }

  @Post("plantings/:plantingId/harvests")
  async createHarvest(
    @Req() request: AuthenticatedRequest,
    @Param("plantingId", new ZodValidationPipe(plantingIdSchema)) plantingId: PlantingId,
    @Body(new ZodValidationPipe(harvestCreateSchema)) body: HarvestCreateRequest,
  ): Promise<Envelope<Harvest>> {
    try {
      const harvest = await this.activity.createHarvest(
        authenticatedUserId(request),
        plantingId,
        body,
      );
      if (harvest === null) throw plantingNotFound();
      return { data: harvest };
    } catch (error) {
      if (error instanceof HarvestDateError) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: "Harvest date cannot precede planting date",
          details: [{ path: "harvestedAt", code: "invalid_date_order" }],
        });
      }
      throw error;
    }
  }

  @Get("plantings/:plantingId/harvests")
  async listHarvests(
    @Req() request: AuthenticatedRequest,
    @Param("plantingId", new ZodValidationPipe(plantingIdSchema)) plantingId: PlantingId,
  ): Promise<Envelope<readonly Harvest[], HarvestListMeta>> {
    const result = await this.activity.listHarvests(authenticatedUserId(request), plantingId);
    if (result === null) throw plantingNotFound();
    return {
      data: result.items,
      meta: { totalYieldKg: result.totalYieldKg },
    };
  }

  @Post("fields/:fieldId/observations")
  async createFieldObservation(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(fieldObservationCreateSchema)) body: FieldObservationCreateRequest,
  ): Promise<Envelope<FieldObservation>> {
    try {
      const observation = await this.activity.createFieldObservation(
        authenticatedUserId(request),
        fieldId,
        body,
      );
      if (observation === null) throw fieldNotFound();
      return { data: observation };
    } catch (error) {
      if (error instanceof ObservationFutureDateError) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: "Observation timestamp cannot be more than 1 day in the future",
          details: [{ path: "observedAt", code: "future_observation" }],
        });
      }
      throw error;
    }
  }

  @Get("fields/:fieldId/observations")
  async listFieldObservations(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<Envelope<readonly FieldObservation[]>> {
    const items = await this.activity.listFieldObservations(authenticatedUserId(request), fieldId);
    if (items === null) throw fieldNotFound();
    return { data: items };
  }
}

function plantingNotFound(): NotFoundException {
  return new NotFoundException({ code: "NOT_FOUND", message: "Planting not found" });
}

function fieldNotFound(): NotFoundException {
  return new NotFoundException({ code: "NOT_FOUND", message: "Field not found" });
}
