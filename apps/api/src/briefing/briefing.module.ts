import type { AiBriefingProvider } from "@agroclimate/agronomy";
import type { DynamicModule } from "@nestjs/common";
import { Module } from "@nestjs/common";

import { BriefingController } from "./briefing.controller.js";
import { BriefingService } from "./briefing.service.js";
import { AI_BRIEFING_PROVIDER } from "./briefing.tokens.js";

@Module({})
export class BriefingModule {
  static register(provider?: AiBriefingProvider): DynamicModule {
    return {
      module: BriefingModule,
      controllers: [BriefingController],
      providers: [
        {
          provide: AI_BRIEFING_PROVIDER,
          useValue: provider,
        },
        BriefingService,
      ],
    };
  }
}
