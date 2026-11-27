import { Inject, Injectable } from "@nestjs/common";
import type { CropDetail, CropList, CropProfileVersion, CropSlug } from "@agroclimate/contracts";
import { cropDetailSchema, cropProfileVersionSchema } from "@agroclimate/contracts";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import {
  createTenantScope,
  findCropBySlug,
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
}
