import type { TenantTransaction } from "./tenant.js";

/**
 * Crop catalog reads — Phase 6.1.
 *
 * The catalog is global reference data: no `user_id`, no RLS policy, and no tenant
 * predicate. The functions still take the caller's `TenantTransaction` so a read
 * shares the request's connection and role rather than opening a second one; the
 * tenant scope adds nothing here, and claiming otherwise would be a predicate that
 * does not exist.
 *
 * Read-only. `app_api` holds `SELECT` on these six tables and nothing else, and a
 * published profile is frozen by `crop_profile_versions_immutable` and its child
 * triggers. Nothing in this module writes.
 */

export interface CropRow {
  readonly id: string;
  readonly slug: string;
  readonly nameId: string;
  readonly nameEn: string;
  readonly category: string;
}

export interface CropProfileVersionSummaryRow {
  readonly id: string;
  readonly cultivarId: string;
  readonly ruleVersion: string;
  readonly status: string;
  readonly publishedAt: string | null;
  readonly supersedesId: string | null;
}

export interface CultivarRow {
  readonly id: string;
  readonly cropId: string;
  readonly name: string;
  readonly durationDaysMin: number;
  readonly durationDaysTypical: number;
  readonly durationDaysMax: number;
  readonly cycleStart: string;
  readonly nurseryDays: number | null;
  readonly photoperiodSensitivity: string | null;
  readonly altitudeMinM: number | null;
  readonly altitudeMaxM: number | null;
}

export interface GrowthStageRow {
  readonly id: string;
  readonly name: string;
  readonly startDayOffset: number;
  readonly endDayOffset: number;
  readonly isCritical: boolean;
  readonly requirementProfile: string | null;
}

export interface ConstraintRow {
  readonly id: string;
  readonly dimension: string;
  readonly comparator: string;
  readonly thresholdLower: number | null;
  readonly thresholdUpper: number | null;
  readonly thresholdCount: number | null;
  readonly unit: string | null;
  readonly growthStageId: string | null;
  readonly grade: string;
  readonly severity: string;
}

export interface SourceRefRow {
  readonly id: string;
  readonly title: string;
  readonly authors: string | null;
  readonly publicationYear: number;
  readonly publisher: string;
  readonly url: string;
  readonly accessedAt: string;
  readonly grade: string;
}

export interface CropProfileVersionRow extends CropProfileVersionSummaryRow {
  readonly growthStages: readonly GrowthStageRow[];
  readonly constraints: readonly ConstraintRow[];
  readonly sourceRefs: readonly SourceRefRow[];
}

export async function listCrops(tx: TenantTransaction): Promise<readonly CropRow[]> {
  return tx.$queryRaw<CropRow[]>`
    SELECT id::text AS id, slug, name_id AS "nameId", name_en AS "nameEn", category
      FROM app.crops
     ORDER BY name_id
  `;
}

export async function findCropBySlug(tx: TenantTransaction, slug: string): Promise<CropRow | null> {
  const rows = await tx.$queryRaw<CropRow[]>`
    SELECT id::text AS id, slug, name_id AS "nameId", name_en AS "nameEn", category
      FROM app.crops
     WHERE slug = ${slug}
  `;
  return rows[0] ?? null;
}

export async function listCultivars(
  tx: TenantTransaction,
  cropId: string,
): Promise<readonly CultivarRow[]> {
  return tx.$queryRaw<CultivarRow[]>`
    SELECT id::text                       AS id,
           crop_id::text                  AS "cropId",
           name,
           duration_days_min              AS "durationDaysMin",
           duration_days_typical          AS "durationDaysTypical",
           duration_days_max              AS "durationDaysMax",
           cycle_start                    AS "cycleStart",
           nursery_days                   AS "nurseryDays",
           photoperiod_sensitivity        AS "photoperiodSensitivity",
           altitude_min_m                 AS "altitudeMinM",
           altitude_max_m                 AS "altitudeMaxM"
      FROM app.cultivars
     WHERE crop_id = ${cropId}::uuid
     ORDER BY name
  `;
}

/**
 * One cultivar by id, or `null`.
 *
 * The cycle projection needs the duration range and the cycle-start event, and a
 * profile version names its cultivar only by id. Reading it here keeps the join in
 * SQL rather than assembling it in a service from a list it happened to fetch.
 */
export async function findCultivar(
  tx: TenantTransaction,
  cultivarId: string,
): Promise<CultivarRow | null> {
  const rows = await tx.$queryRaw<CultivarRow[]>`
    SELECT id::text                   AS id,
           crop_id::text              AS "cropId",
           name,
           duration_days_min          AS "durationDaysMin",
           duration_days_typical      AS "durationDaysTypical",
           duration_days_max          AS "durationDaysMax",
           cycle_start                AS "cycleStart",
           nursery_days               AS "nurseryDays",
           photoperiod_sensitivity    AS "photoperiodSensitivity",
           altitude_min_m             AS "altitudeMinM",
           altitude_max_m             AS "altitudeMaxM"
      FROM app.cultivars
     WHERE id = ${cultivarId}::uuid
  `;
  return rows[0] ?? null;
}

/** Every version of every cultivar of one crop, newest first. */
export async function listProfileVersionsForCrop(
  tx: TenantTransaction,
  cropId: string,
): Promise<readonly CropProfileVersionSummaryRow[]> {
  return tx.$queryRaw<CropProfileVersionSummaryRow[]>`
    SELECT v.id::text                          AS id,
           v.cultivar_id::text                 AS "cultivarId",
           v.rule_version                      AS "ruleVersion",
           v.status,
           to_char(v.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",
           v.supersedes_id::text               AS "supersedesId"
      FROM app.crop_profile_versions v
      JOIN app.cultivars c ON c.id = v.cultivar_id
     WHERE c.crop_id = ${cropId}::uuid
     ORDER BY v.created_at DESC, v.rule_version DESC
  `;
}

export async function findProfileVersion(
  tx: TenantTransaction,
  profileVersionId: string,
): Promise<CropProfileVersionRow | null> {
  const versions = await tx.$queryRaw<CropProfileVersionSummaryRow[]>`
    SELECT v.id::text                          AS id,
           v.cultivar_id::text                 AS "cultivarId",
           v.rule_version                      AS "ruleVersion",
           v.status,
           to_char(v.published_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "publishedAt",
           v.supersedes_id::text               AS "supersedesId"
      FROM app.crop_profile_versions v
     WHERE v.id = ${profileVersionId}::uuid
  `;
  const version = versions[0];
  if (version === undefined) return null;

  const [growthStages, constraints, sourceRefs] = await Promise.all([
    tx.$queryRaw<GrowthStageRow[]>`
      SELECT id::text          AS id,
             name,
             start_day_offset  AS "startDayOffset",
             end_day_offset    AS "endDayOffset",
             is_critical       AS "isCritical",
             requirement_profile AS "requirementProfile"
        FROM app.growth_stages
       WHERE profile_version_id = ${profileVersionId}::uuid
       ORDER BY start_day_offset, name
    `,
    tx.$queryRaw<ConstraintRow[]>`
      SELECT id::text             AS id,
             dimension,
             comparator,
             threshold_lower::float8 AS "thresholdLower",
             threshold_upper::float8 AS "thresholdUpper",
             threshold_count      AS "thresholdCount",
             unit,
             growth_stage_id::text AS "growthStageId",
             grade,
             severity
        FROM app.constraints
       WHERE profile_version_id = ${profileVersionId}::uuid
       ORDER BY dimension, comparator, id
    `,
    tx.$queryRaw<SourceRefRow[]>`
      SELECT id::text        AS id,
             title,
             authors,
             publication_year AS "publicationYear",
             publisher,
             url,
             to_char(accessed_at, 'YYYY-MM-DD') AS "accessedAt",
             grade
        FROM app.source_refs
       WHERE profile_version_id = ${profileVersionId}::uuid
       ORDER BY grade, publication_year, title
    `,
  ]);

  return { ...version, growthStages, constraints, sourceRefs };
}
