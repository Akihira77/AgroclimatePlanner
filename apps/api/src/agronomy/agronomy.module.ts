import type { GridRegistry } from "@agroclimate/contracts";
import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { GRID_REGISTRY } from "../tokens.js";
import { AgronomyController } from "./agronomy.controller.js";
import { AgronomyService } from "./agronomy.service.js";

@Module({})
export class AgronomyModule {
  static register(gridRegistry?: GridRegistry): DynamicModule {
    return {
      module: AgronomyModule,
      controllers: [AgronomyController],
      providers: [
        ...(gridRegistry === undefined
          ? []
          : [{ provide: GRID_REGISTRY, useValue: gridRegistry }]),
        AgronomyService,
      ],
      exports: [AgronomyService],
    };
  }
}
