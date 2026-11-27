import { Inject, Injectable } from "@nestjs/common";
import type {
  CropCycle,
  CropDetail,
  CropList,
  CropProfileVersion,
  CropSlug,
} from "@agroclimate/contracts";
import {
  cropCycleSchema,
  cropDetailSchema,
  cropProfileVersionSchema,
} from "@agroclimate/contracts";
import { projectCycle } from "@agroclimate/agronomy";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import {
  createTenantScope,
  findCropBySlug,
  findCultivar,
  findProfileVersion,
  listCrops,
  listCultivars,
  listProfileVersionsForCrop,
} from "@agroclimate/database";

import { DATABASE_CLIENT } from "../tokens.js";

/**
 * Crop catalog reads — Phase 6.1.
 *
 * The catalog is global reference data: no `user_id`, no RLS, no tenant predicate.
 * It is still read through the caller's tenant transaction so the request uses one
 * connection and one role (`app_api`, which holds `SELECT` and nothing else).
 *
 * Nothing here writes, derives, or repairs. A profile that fails its contract is a
 * seed defect and is reported as an error rather than served in a softened shape:
 * a recommendation must be able to name the exact rulebook it was judged against.
 */
@Injectable()
export class CropService {
  private readonly scope: TenantScope;

  constructor(@Inject(DATABASE_CLIENT) client: PrismaClient) {
    this.scope = createTenantScope(client);
  }

  async list(userId: string): Promise<CropList> {
    return this.scope.withTenant(userId, async (tx) => ({
      crops: [...(await listCrops(tx))],
    }));
  }

  /** `null` when no crop carries the slug; the controller answers `CROP_NOT_FOUND`. */
  async find(userId: string, slug: CropSlug): Promise<CropDetail | null> {
    return this.scope.withTenant(userId, async (tx) => {
      const crop = await findCropBySlug(tx, slug);
      if (crop === null) return null;

      const cultivars = await listCultivars(tx, crop.id);
      const versions = await listProfileVersionsForCrop(tx, crop.id);

      const detail = {
        ...crop,
        cultivars: cultivars.map((cultivar) => ({
          ...cultivar,
          // Newest first, as `listProfileVersionsForCrop` orders them. A cultivar
          // with no version keeps an empty list rather than a synthetic draft.
          profileVersions: versions.filter((version) => version.cultivarId === cultivar.id),
        })),
      };

      const parsed = cropDetailSchema.safeParse(detail);
      if (!parsed.success) {
        throw new Error(
          `crop ${slug} does not satisfy its response contract: ${parsed.error.issues[0]?.path.join(".") ?? "root"}`,
        );
      }
      return parsed.data;
    });
  }

  /** `null` when the version id is unknown; the controller answers `PROFILE_NOT_FOUND`. */
  async profileVersion(
    userId: string,
    profileVersionId: string,
  ): Promise<CropProfileVersion | null> {
    return this.scope.withTenant(userId, async (tx) => {
      const version = await findProfileVersion(tx, profileVersionId);
      if (version === null) return null;

      const parsed = cropProfileVersionSchema.safeParse(version);
      if (!parsed.success) {
        throw new Error(
          `crop profile ${profileVersionId} does not satisfy its response contract: ${parsed.error.issues[0]?.path.join(".") ?? "root"}`,
        );
      }
      return parsed.data;
    });
  }

  /**
   * The rulebook's stages placed on the calendar. `null` when the version is
   * unknown; the controller answers `PROFILE_NOT_FOUND`.
   *
   * Pure arithmetic over two stored facts — the offsets and the cultivar's duration
   * range. It intentionally consults no climate value and produces no verdict: a
   * projection says when a phase falls, and a suitability claim needs the field
   * vocabulary (`OPEN-21`) and a validated grid (`OPEN-18`) that do not exist yet.
   */
  async cycle(
    userId: string,
    profileVersionId: string,
    cycleStartDate: string,
  ): Promise<CropCycle | null> {
    return this.scope.withTenant(userId, async (tx) => {
      const version = await findProfileVersion(tx, profileVersionId);
      if (version === null) return null;

      const cultivar = await findCultivar(tx, version.cultivarId);
      // A profile whose cultivar is gone is a broken catalog, not an absence: the
      // FK makes it impossible, so reaching here means the row was read wrong.
      if (cultivar === null) {
        throw new Error(
          `crop profile ${profileVersionId} names cultivar ${version.cultivarId}, which does not exist`,
        );
      }

      const projected = projectCycle({
        stages: version.growthStages,
        cycleStartDate,
        durationDays: {
          min: cultivar.durationDaysMin,
          typical: cultivar.durationDaysTypical,
          max: cultivar.durationDaysMax,
        },
      });

      const parsed = cropCycleSchema.safeParse({
        profileVersionId: version.id,
        cultivarId: cultivar.id,
        cultivarName: cultivar.name,
        cycleStart: cultivar.cycleStart,
        cycleStartDate: projected.cycleStartDate,
        duration: {
          min: cultivar.durationDaysMin,
          typical: cultivar.durationDaysTypical,
          max: cultivar.durationDaysMax,
        },
        harvest: {
          earliest: projected.harvestEarliest,
          typical: projected.harvestTypical,
          latest: projected.harvestLatest,
        },
        stages: projected.stages,
      });
      if (!parsed.success) {
        throw new Error(
          `crop cycle for profile ${profileVersionId} does not satisfy its response contract: ${parsed.error.issues[0]?.path.join(".") ?? "root"}`,
        );
      }
      return parsed.data;
    });
  }
}
