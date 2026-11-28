import type { DashboardAdvisory, Envelope } from "@agroclimate/contracts";
import { Controller, Get, Req, UseGuards } from "@nestjs/common";

import type { AuthenticatedRequest } from "../auth/auth.guard.js";
import { AuthGuard, authenticatedUserId } from "../auth/auth.guard.js";
import { DashboardService } from "./dashboard.service.js";

@Controller("dashboard")
@UseGuards(AuthGuard)
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get("advisory")
  async getAdvisory(@Req() request: AuthenticatedRequest): Promise<Envelope<DashboardAdvisory>> {
    const data = await this.dashboard.advisory(authenticatedUserId(request));
    return { data };
  }
}
