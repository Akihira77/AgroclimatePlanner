import type {
  CropCycle,
  CropCycleQuery,
  CropDetail,
  CropList,
  CropProfileVersion,
  CropSlug,
  Envelope,
} from "@agroclimate/contracts";
import { cropCycleQuerySchema, cropSlugSchema } from "@agroclimate/contracts";
import { z } from "zod";
import { Controller, Get, NotFoundException, Param, Query, Req, UseGuards } from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";
import { CropService } from "./crop.service.js";

const profileVersionIdSchema = z.uuid();

/**
 * Crop catalog read routes — Phase 6.1.
 *
 * Three flat `GET`s over global reference data (`tables-catalog.md` §2–§8). The
 * same `AuthGuard` as every other route: the catalog is identical for every
 * tenant, but "public" is not something this build offers anywhere else, and one
 * unauthenticated surface would be a second trust rule to keep in step.
 *
 * No mutations exist. `app_api` holds `SELECT` only, and a published profile is
 * frozen by trigger, so a route that wrote would need a role that cannot have one.
 */
@Controller()
@UseGuards(AuthGuard)
export class CropController {
  constructor(private readonly crops: CropService) {}

  @Get("crops")
  async list(@Req() request: AuthenticatedRequest): Promise<Envelope<CropList>> {
    return { data: await this.crops.list(authenticatedUserId(request)) };
  }

  @Get("crops/:slug")
  async find(
    @Req() request: AuthenticatedRequest,
    @Param("slug", new ZodValidationPipe(cropSlugSchema)) slug: CropSlug,
  ): Promise<Envelope<CropDetail>> {
    const crop = await this.crops.find(authenticatedUserId(request), slug);
    if (crop === null) throw notFound("CROP_NOT_FOUND");
    return { data: crop };
  }

  /**
   * The version's stages as calendar dates, from one cycle-start date.
   *
   * A projection, not a recommendation: it multiplies nothing, ranks nothing, and
   * reads no weather. The response carries the harvest as the cultivar's duration
   * range, because a single date would claim a precision the evidence does not have.
   */
  @Get("crop-profiles/:profileVersionId/cycle")
  async cycle(
    @Req() request: AuthenticatedRequest,
    @Param("profileVersionId", new ZodValidationPipe(profileVersionIdSchema))
    profileVersionId: string,
    @Query(new ZodValidationPipe(cropCycleQuerySchema)) query: CropCycleQuery,
  ): Promise<Envelope<CropCycle>> {
    const cycle = await this.crops.cycle(
      authenticatedUserId(request),
      profileVersionId,
      query.cycleStartDate,
    );
    if (cycle === null) throw notFound("PROFILE_NOT_FOUND");
    return { data: cycle };
  }

  /** The complete rulebook: stages, thresholds and citations for one version id. */
  @Get("crop-profiles/:profileVersionId")
  async profileVersion(
    @Req() request: AuthenticatedRequest,
    @Param("profileVersionId", new ZodValidationPipe(profileVersionIdSchema))
    profileVersionId: string,
  ): Promise<Envelope<CropProfileVersion>> {
    const version = await this.crops.profileVersion(authenticatedUserId(request), profileVersionId);
    if (version === null) throw notFound("PROFILE_NOT_FOUND");
    return { data: version };
  }
}

function notFound(code: "CROP_NOT_FOUND" | "PROFILE_NOT_FOUND"): NotFoundException {
  return new NotFoundException({ code });
}
