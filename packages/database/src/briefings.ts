import type {
  AiBriefing,
  BriefingUnreproducibleReason,
  ClimateBriefingBody,
  DataInputRef,
  NarrationStatus,
} from "@agroclimate/contracts";

import type { TenantTransaction } from "./tenant.js";

/**
 * Phase 8 AI briefing persistence (`app.ai_briefings`).
 *
 * Uses atomic stage-failed -> retire-old -> promote-new supersession so
 * `ai_briefings_cache_key` and `ai_briefings_superseded_state_check` remain
 * satisfied even when regenerating a briefing for an unchanged input snapshot.
 */

export interface PersistAiBriefingInput {
  readonly fieldId: string;
  readonly suitabilityRunId: string;
  readonly body: ClimateBriefingBody;
  readonly narrationStatus: NarrationStatus;
  readonly modelId: string;
  readonly promptVersion: string;
  readonly derivationVersion: string;
  readonly inputRefs: readonly DataInputRef[];
  readonly fieldSnapshotHash: string;
  readonly sourceArtifactHashes: readonly string[];
  readonly inputSnapshotHash: string;
  readonly reproducible: boolean;
  readonly unreproducibleReason: BriefingUnreproducibleReason | null;
}

interface RawAiBriefing {
  readonly id: string;
  readonly user_id: string;
  readonly field_id: string;
  readonly suitability_run_id: string;
  readonly body: ClimateBriefingBody;
  readonly narration_status: NarrationStatus;
  readonly model_id: string;
  readonly prompt_version: string;
  readonly derivation_version: string;
  readonly input_refs: DataInputRef[];
  readonly field_snapshot_hash: string;
  readonly source_artifact_hashes: string[];
  readonly input_snapshot_hash: string;
  readonly computed_at: Date;
  readonly reproducible: boolean;
  readonly unreproducible_reason: BriefingUnreproducibleReason | null;
  readonly status: "active" | "superseded" | "failed";
  readonly superseded_by_id: string | null;
  readonly created_at: Date;
}

function toAiBriefing(row: RawAiBriefing): AiBriefing {
  return {
    id: row.id,
    userId: row.user_id,
    fieldId: row.field_id,
    suitabilityRunId: row.suitability_run_id,
    body: row.body,
    narrationStatus: row.narration_status,
    modelId: row.model_id,
    promptVersion: row.prompt_version,
    derivationVersion: row.derivation_version,
    inputRefs: row.input_refs,
    fieldSnapshotHash: row.field_snapshot_hash,
    sourceArtifactHashes: row.source_artifact_hashes,
    inputSnapshotHash: row.input_snapshot_hash,
    computedAt: row.computed_at.toISOString(),
    reproducible: row.reproducible,
    unreproducibleReason: row.unreproducible_reason,
    status: row.status,
    supersededById: row.superseded_by_id,
    createdAt: row.created_at.toISOString(),
  };
}

export async function findCachedAiBriefing(
  tx: TenantTransaction,
  fieldId: string,
  inputSnapshotHash: string,
): Promise<AiBriefing | null> {
  const rows = await tx.$queryRaw<RawAiBriefing[]>`
    SELECT b.id::text AS id,
           b.user_id::text AS user_id,
           b.field_id::text AS field_id,
           b.suitability_run_id::text AS suitability_run_id,
           b.body,
           b.narration_status,
           b.model_id,
           b.prompt_version,
           b.derivation_version,
           b.input_refs,
           b.field_snapshot_hash,
           b.source_artifact_hashes,
           b.input_snapshot_hash,
           b.computed_at,
           b.reproducible,
           b.unreproducible_reason,
           b.status,
           b.superseded_by_id::text AS superseded_by_id,
           b.created_at
      FROM app.ai_briefings b
      JOIN app.fields f ON f.id = b.field_id AND f.user_id = b.user_id
     WHERE b.field_id = ${fieldId}::uuid
       AND b.input_snapshot_hash = ${inputSnapshotHash}
       AND b.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND b.status = 'active'
       AND f.deleted_at IS NULL
     LIMIT 1
  `;
  return rows[0] === undefined ? null : toAiBriefing(rows[0]);
}

export async function findLatestAiBriefing(
  tx: TenantTransaction,
  fieldId: string,
): Promise<AiBriefing | null> {
  const rows = await tx.$queryRaw<RawAiBriefing[]>`
    SELECT b.id::text AS id,
           b.user_id::text AS user_id,
           b.field_id::text AS field_id,
           b.suitability_run_id::text AS suitability_run_id,
           b.body,
           b.narration_status,
           b.model_id,
           b.prompt_version,
           b.derivation_version,
           b.input_refs,
           b.field_snapshot_hash,
           b.source_artifact_hashes,
           b.input_snapshot_hash,
           b.computed_at,
           b.reproducible,
           b.unreproducible_reason,
           b.status,
           b.superseded_by_id::text AS superseded_by_id,
           b.created_at
      FROM app.ai_briefings b
      JOIN app.fields f ON f.id = b.field_id AND f.user_id = b.user_id
     WHERE b.field_id = ${fieldId}::uuid
       AND b.user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND b.status = 'active'
       AND f.deleted_at IS NULL
     ORDER BY b.computed_at DESC, b.id DESC
     LIMIT 1
  `;
  return rows[0] === undefined ? null : toAiBriefing(rows[0]);
}

export async function persistAiBriefing(
  tx: TenantTransaction,
  input: PersistAiBriefingInput,
): Promise<AiBriefing> {
  const fieldLock = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.fields
     WHERE id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
     FOR UPDATE
  `;
  if (fieldLock.length === 0) {
    throw new Error(`field not found for ai briefing persistence: ${input.fieldId}`);
  }

  await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.ai_briefings
     WHERE field_id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND status = 'active'
     FOR UPDATE
  `;

  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.ai_briefings (
      user_id,
      field_id,
      suitability_run_id,
      body,
      narration_status,
      model_id,
      prompt_version,
      derivation_version,
      input_refs,
      field_snapshot_hash,
      source_artifact_hashes,
      input_snapshot_hash,
      reproducible,
      unreproducible_reason,
      status
    )
    VALUES (
      NULLIF(current_setting('app.user_id', true), '')::uuid,
      ${input.fieldId}::uuid,
      ${input.suitabilityRunId}::uuid,
      ${JSON.stringify(input.body)}::jsonb,
      ${input.narrationStatus},
      ${input.modelId},
      ${input.promptVersion},
      ${input.derivationVersion},
      ${JSON.stringify(input.inputRefs)}::jsonb,
      ${input.fieldSnapshotHash},
      ${input.sourceArtifactHashes as string[]},
      ${input.inputSnapshotHash},
      ${input.reproducible},
      ${input.unreproducibleReason},
      'failed'
    )
    RETURNING id::text AS id
  `;
  const newId = inserted[0]?.id;
  if (newId === undefined) {
    throw new Error("ai_briefings insert returned no id");
  }

  await tx.$queryRaw`
    UPDATE app.ai_briefings
       SET status = 'superseded',
           superseded_by_id = ${newId}::uuid
     WHERE field_id = ${input.fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND status = 'active'
       AND id <> ${newId}::uuid
  `;

  await tx.$queryRaw`
    UPDATE app.ai_briefings
       SET status = 'active'
     WHERE id = ${newId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  `;

  const rows = await tx.$queryRaw<RawAiBriefing[]>`
    SELECT id::text AS id,
           user_id::text AS user_id,
           field_id::text AS field_id,
           suitability_run_id::text AS suitability_run_id,
           body,
           narration_status,
           model_id,
           prompt_version,
           derivation_version,
           input_refs,
           field_snapshot_hash,
           source_artifact_hashes,
           input_snapshot_hash,
           computed_at,
           reproducible,
           unreproducible_reason,
           status,
           superseded_by_id::text AS superseded_by_id,
           created_at
      FROM app.ai_briefings
     WHERE id = ${newId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
  `;
  const loaded = rows[0];
  if (loaded === undefined) {
    throw new Error("persisted ai briefing could not be reloaded");
  }
  return toAiBriefing(loaded);
}
