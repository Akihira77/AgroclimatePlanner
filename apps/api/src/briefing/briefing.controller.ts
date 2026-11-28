import { BriefingContextError } from "@agroclimate/agronomy";
import type {
  AiBriefing,
  BriefingGenerateRequest,
  Envelope,
  FieldId,
} from "@agroclimate/contracts";
import { briefingGenerateRequestSchema, fieldIdSchema } from "@agroclimate/contracts";
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  NotFoundException,
  Param,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";
import { BriefingNotFoundError, BriefingService } from "./briefing.service.js";

/**
 * Phase 8 AI Agricultural Analyst briefing endpoints (`OPEN-11`).
 */
@Controller()
@UseGuards(AuthGuard)
export class BriefingController {
  constructor(private readonly briefings: BriefingService) {}

  @Post("fields/:fieldId/briefing")
  async generateBriefing(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
    @Body(new ZodValidationPipe(briefingGenerateRequestSchema)) body: BriefingGenerateRequest,
  ): Promise<Envelope<AiBriefing>> {
    try {
      const briefing = await this.briefings.generateBriefing(
        authenticatedUserId(request),
        fieldId,
        body,
      );
      return { data: briefing };
    } catch (error) {
      if (error instanceof BriefingNotFoundError) {
        throw new NotFoundException({
          code: "NOT_FOUND",
          message: "Suitability evaluation not found",
        });
      }
      if (error instanceof BriefingContextError) {
        throw new BadRequestException({
          code: "VALIDATION_FAILED",
          message: error.message,
          details: [{ path: "fieldId", code: error.code }],
        });
      }
      throw error;
    }
  }

  @Get("fields/:fieldId/briefing")
  async getLatestBriefing(
    @Req() request: AuthenticatedRequest,
    @Param("fieldId", new ZodValidationPipe(fieldIdSchema)) fieldId: FieldId,
  ): Promise<Envelope<AiBriefing>> {
    const briefing = await this.briefings.getLatestBriefing(authenticatedUserId(request), fieldId);
    if (briefing === null) {
      throw new NotFoundException({
        code: "NOT_FOUND",
        message: "AI briefing not found",
      });
    }
    return { data: briefing };
  }
}
