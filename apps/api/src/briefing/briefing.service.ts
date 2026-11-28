import {
  BRIEFING_DERIVATION_VERSION,
  BRIEFING_PROMPT_VERSION,
  DETERMINISTIC_FALLBACK_MODEL_ID,
  generateGroundedBriefing,
} from "@agroclimate/agronomy";
import type { AiBriefingProvider } from "@agroclimate/agronomy";
import type { AiBriefing, BriefingGenerateRequest } from "@agroclimate/contracts";
import { aiBriefingSchema, hashDerivationDescriptor } from "@agroclimate/contracts";
import {
  createTenantScope,
  findCachedAiBriefing,
  findLatestAiBriefing,
  findLatestSuitabilityRun,
  persistAiBriefing,
} from "@agroclimate/database";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import { Inject, Injectable, Optional } from "@nestjs/common";

import { DATABASE_CLIENT } from "../tokens.js";
import { AI_BRIEFING_PROVIDER } from "./briefing.tokens.js";

export class BriefingNotFoundError extends Error {
  readonly code = "suitability_not_found";

  constructor(message: string) {
    super(message);
    this.name = "BriefingNotFoundError";
  }
}

@Injectable()
export class BriefingService {
  private readonly tenants: TenantScope;

  constructor(
    @Inject(DATABASE_CLIENT) prisma: PrismaClient,
    @Optional() @Inject(AI_BRIEFING_PROVIDER) private readonly provider?: AiBriefingProvider,
  ) {
    this.tenants = createTenantScope(prisma);
  }

  async generateBriefing(
    userId: string,
    fieldId: string,
    request: BriefingGenerateRequest,
  ): Promise<AiBriefing> {
    // Phase 1 (read tx): load latest suitability run & check cache without holding a DB tx open during LLM call.
    const { run, cached } = await this.tenants.withTenant(userId, async (tx) => {
      const latestRun = await findLatestSuitabilityRun(tx, fieldId);
      if (latestRun === null) {
        throw new BriefingNotFoundError(`no active suitability run for field: ${fieldId}`);
      }

      if (request.question === undefined && !request.forceRegenerate) {
        const sourceArtifactHashes = Array.from(
          new Set([
            latestRun.inputSnapshotHash,
            ...latestRun.plantingWindows.map((w) => w.inputSnapshotHash),
          ]),
        ).sort();
        const expectedModelId = this.provider?.modelId ?? DETERMINISTIC_FALLBACK_MODEL_ID;
        const expectedHash = hashDerivationDescriptor({
          artifact: "ai_briefing",
          inputRefs: [...latestRun.inputRefs],
          fieldSnapshotHash: latestRun.fieldSnapshotHash,
          sourceArtifactHashes,
          promptVersion: BRIEFING_PROMPT_VERSION,
          modelId: expectedModelId,
          derivationVersion: BRIEFING_DERIVATION_VERSION,
        });
        const hit = await findCachedAiBriefing(tx, fieldId, expectedHash);
        if (hit !== null) {
          return { run: latestRun, cached: aiBriefingSchema.parse(hit) };
        }
      }

      return { run: latestRun, cached: null };
    });

    if (cached !== null) {
      return cached;
    }

    // Phase 2 (outside tx): call optional LLM provider with grounding validator & deterministic fallback.
    const generated = await generateGroundedBriefing({
      run,
      ...(request.question === undefined ? {} : { question: request.question }),
      ...(this.provider === undefined ? {} : { provider: this.provider }),
    });

    const inputSnapshotHash = hashDerivationDescriptor({
      artifact: "ai_briefing",
      inputRefs: [...run.inputRefs],
      fieldSnapshotHash: run.fieldSnapshotHash,
      sourceArtifactHashes: [...generated.sourceArtifactHashes],
      promptVersion: generated.promptVersion,
      modelId: generated.modelId,
      derivationVersion: generated.derivationVersion,
    });

    // Phase 3 (write tx): persist atomically with stage-failed -> retire-old -> promote-new supersession.
    const persisted = await this.tenants.withTenant(userId, (tx) =>
      persistAiBriefing(tx, {
        fieldId: run.fieldId,
        suitabilityRunId: run.id,
        body: generated.body,
        narrationStatus: generated.narrationStatus,
        modelId: generated.modelId,
        promptVersion: generated.promptVersion,
        derivationVersion: generated.derivationVersion,
        inputRefs: run.inputRefs,
        fieldSnapshotHash: run.fieldSnapshotHash,
        sourceArtifactHashes: generated.sourceArtifactHashes,
        inputSnapshotHash,
        reproducible: generated.reproducible,
        unreproducibleReason: generated.unreproducibleReason,
      }),
    );

    return aiBriefingSchema.parse(persisted);
  }

  async getLatestBriefing(userId: string, fieldId: string): Promise<AiBriefing | null> {
    const briefing = await this.tenants.withTenant(userId, (tx) =>
      findLatestAiBriefing(tx, fieldId),
    );
    return briefing === null ? null : aiBriefingSchema.parse(briefing);
  }
}
