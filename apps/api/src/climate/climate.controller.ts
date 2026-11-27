import type {
  ClimateDailyOutlook,
  ClimateDailyOutlookQuery,
  ClimateOutlook,
  ClimateOutlookQuery,
  Envelope,
} from "@agroclimate/contracts";
import { climateDailyOutlookQuerySchema, climateOutlookQuerySchema } from "@agroclimate/contracts";
import { Controller, Get, NotFoundException, Query, Req, UseGuards } from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { ZodValidationPipe } from "../http/zod-validation.pipe.js";
import { ClimateService } from "./climate.service.js";

/**
 * Climate read routes (`api-conventions.md` §5).
 *
 * `GET /v1/climate/outlook` answers the twelve-month horizon 5.7A–D materialised:
 * lead months 1–6 `seasonal_forecast` when a complete SEAS5 run exists, lead months
 * 7–12 `climatology` where a normal exists, and `pending` for any month with no
 * stored row. A seasonal month also carries `availability` (`fresh | stale`),
 * derived at read time from the run's initialisation.
 *
 * Same `AuthGuard` as the Farm and Field routes, so session handling, the CSRF
 * rule for mutations, and the `Origin` middleware apply without a second
 * mechanism. `GET` carries no mutation, so no CSRF token is required.
 *
 * A field that is missing, foreign, or deleted answers `FIELD_NOT_FOUND`,
 * identically in all three cases. The grid failures the resolver raises keep their
 * own codes (`GRID_NOT_FOUND`, `CELL_NOT_FOUND`); see `http/resolution-errors.ts`.
 */
@Controller("climate")
@UseGuards(AuthGuard)
export class ClimateController {
  constructor(private readonly climate: ClimateService) {}

  @Get("outlook")
  async outlook(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(climateOutlookQuerySchema)) query: ClimateOutlookQuery,
  ): Promise<Envelope<ClimateOutlook>> {
    const outlook = await this.climate.outlook(authenticatedUserId(request), query);
    if (outlook === null) throw new NotFoundException({ code: "FIELD_NOT_FOUND" });
    return { data: outlook };
  }

  /**
   * `GET /v1/climate/forecast` — days 0–45, read from live `weather_records`.
   *
   * Two ordered segments: 0–14 `weather_forecast`, 15–45 `subseasonal_forecast`.
   * Each day carries its own model, run, freshness and resolution. The monthly
   * `outlook` route is unchanged and still the only source of lead months 1–12.
   */
  @Get("forecast")
  async forecast(
    @Req() request: AuthenticatedRequest,
    @Query(new ZodValidationPipe(climateDailyOutlookQuerySchema)) query: ClimateDailyOutlookQuery,
  ): Promise<Envelope<ClimateDailyOutlook>> {
    const forecast = await this.climate.forecast(authenticatedUserId(request), query);
    if (forecast === null) throw new NotFoundException({ code: "FIELD_NOT_FOUND" });
    return { data: forecast };
  }
}
