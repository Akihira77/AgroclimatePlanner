import type { GridRegistry } from "@agroclimate/contracts";
import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { GRID_REGISTRY } from "../tokens.js";
import { DashboardController } from "./dashboard.controller.js";
import { DashboardService } from "./dashboard.service.js";

@Module({})
export class DashboardModule {
  static register(gridRegistry: GridRegistry): DynamicModule {
    return {
      module: DashboardModule,
      controllers: [DashboardController],
      providers: [{ provide: GRID_REGISTRY, useValue: gridRegistry }, DashboardService],
      exports: [DashboardService],
    };
  }
}
