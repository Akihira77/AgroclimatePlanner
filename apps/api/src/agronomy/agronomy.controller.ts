import {
  ConstraintRuleError,
  SuitabilityInputError,
  WindowGenerationError,
  WindowPartitionError,
} from "@agroclimate/agronomy";
import type {
  Envelope,
  FieldEvaluateRequest,
  FieldId,
  FieldRecommendations,
  FieldRecommendationsQuery,
  PlantingWindow,
  PlantingWindowListQuery,
  SuitabilityRunWithWindows,
} from "@agroclimate/contracts";
import {
  fieldEvaluateRequestSchema,
  fieldIdSchema,
  fieldRecommendationsQuerySchema,
  plantingWindowListQuerySchema,
} from "@agroclimate/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Logger,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";
import { AgronomyResourceNotFoundError, AgronomyService } from "./agronomy.service.js";

/**
 * Phase 6 agronomic suitability evaluation and planting-window endpoints.
 */
@Controller()
@UseGuards(AuthGuard)
export class AgronomyController {
  constructor(private readonly agronomy: AgronomyService) {}

  @Post("fields/:fieldId/evaluate")
  async evaluateField(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(fieldEvaluateRequestSchema)) body: FieldEvaluateRequest,
  ): Promise<Envelope<SuitabilityRunWithWindows>> {
    try {
      const run = await this.agronomy.evaluateField(authenticatedUserId(request), fieldId, body);
      return { data: run };
    } catch (error) {
      if (error instanceof AgronomyResourceNotFoundError) {
        if (error.code === "profile_not_published") {
          throw new BadRequestException({
            code: "VALIDATION_FAILED",
            message: error.message,
            details: [{ path: "profileVersionId", code: error.code }],
          });
        }
        throw new NotFoundException({
          code: "NOT_FOUND",
          message: error.code === "field_not_found" ? "Field not found" : "Profile not found",
        });
      }
      if (error instanceof WindowPartitionError) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: error.message,
          details: error.violations.map((v) => ({
            path: `candidates.${v.startDate ?? "window"}`,
            code: v.code,
          })),
        });
      }
      if (
        error instanceof WindowGenerationError ||
        error instanceof SuitabilityInputError ||
        error instanceof ConstraintRuleError
      ) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: error.message,
          details: [
            {
              path: "candidates",
              code: error instanceof ConstraintRuleError ? error.reason : error.code,
            },
          ],
        });
      }
      throw error;
    }
  }

  @Get("fields/:fieldId/suitability")
  async getLatestSuitability(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<Envelope<SuitabilityRunWithWindows>> {
    const run = await this.agronomy.getLatestSuitability(authenticatedUserId(request), fieldId);
    if (run === null) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "Suitability evaluation not found",
      });
    }
    return { data: run };
  }

  @Get("planting-windows")
  async listPlantingWindows(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(plantingWindowListQuerySchema)) query: PlantingWindowListQuery,
  ): Promise<Envelope<readonly PlantingWindow[]>> {
    const windows = await this.agronomy.listPlantingWindows(authenticatedUserId(request), query);
    return { data: windows };
  }

  @Get("fields/:fieldId/recommendations")
  async getFieldRecommendations(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Query(new ZodValidationPipe(fieldRecommendationsQuerySchema))
    query: FieldRecommendationsQuery,
  ): Promise<Envelope<FieldRecommendations>> {
    try {
      const data = await this.agronomy.recommendForField(
        authenticatedUserId(request),
        fieldId,
        query.horizonMonths as 3 | 6 | 12,
      );
      return { data };
    } catch (error) {
      if (error instanceof AgronomyResourceNotFoundError) {
        throw new NotFoundException({
          code: "NOT_FOUND",
          message: "Field not found",
        });
      }
      Logger.error(
        `recommendForField failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`,
        "AgronomyController",
      );
      throw error;
    }
  }
}
