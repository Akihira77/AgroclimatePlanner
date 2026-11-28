import type { FieldObservationKind } from "@agroclimate/contracts";

import { isCheckViolation, pgErrorInfo } from "./run-errors.js";
import type { TenantTransaction } from "./tenant.js";

/**
 * Local field observation persistence (Phase 3.7).
 *
 * `entered_by` equals `user_id` in v1 (`D7`), enforced by
 * `field_observations_entered_by_check`.
 */

export class ObservationFutureDateError extends Error {
  constructor(observedAt: string) {
    super(`observedAt is more than 1 day in the future: ${observedAt}`);
    this.name = "ObservationFutureDateError";
  }
}

export interface FieldObservationRecord {
  readonly id: string;
  readonly fieldId: string;
  readonly kind: FieldObservationKind;
  readonly value: number | null;
  readonly unit: string | null;
  readonly observedAt: Date;
  readonly method: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface FieldObservationCreateInput {
  readonly kind: FieldObservationKind;
  readonly value?: number | null;
  readonly unit?: string | null;
  readonly observedAt: string;
  readonly method?: string | null;
}

interface RawObservation {
  readonly id: string;
  readonly field_id: string;
  readonly kind: FieldObservationKind;
  readonly value: number | null;
  readonly unit: string | null;
  readonly observed_at: Date;
  readonly method: string | null;
  readonly created_at: Date;
  readonly updated_at: Date;
}

function toObservation(row: RawObservation): FieldObservationRecord {
  return {
    id: row.id,
    fieldId: row.field_id,
    kind: row.kind,
    value: row.value,
    unit: row.unit,
    observedAt: row.observed_at,
    method: row.method,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createFieldObservation(
  tx: TenantTransaction,
  fieldId: string,
  input: FieldObservationCreateInput,
): Promise<FieldObservationRecord | null> {
  const fieldRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.fields
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;
  if (fieldRows.length === 0) return null;

  try {
    const rows = await tx.$queryRaw<RawObservation[]>`
      INSERT INTO app.field_observations (
        user_id,
        field_id,
        kind,
        value,
        unit,
        observed_at,
        method,
        entered_by
      )
      VALUES (
        NULLIF(current_setting('app.user_id', true), '')::uuid,
        ${fieldId}::uuid,
        ${input.kind},
        ${input.value ?? null},
        ${input.unit ?? null},
        ${input.observedAt}::timestamptz,
        ${input.method ?? null},
        NULLIF(current_setting('app.user_id', true), '')::uuid
      )
      RETURNING id::text AS id,
                field_id::text AS field_id,
                kind,
                value,
                unit,
                observed_at,
                method,
                created_at,
                updated_at
    `;

    const row = rows[0];
    if (row === undefined) throw new Error("field observation insert returned no row");
    return toObservation(row);
  } catch (error) {
    const info = pgErrorInfo(error);
    if (
      isCheckViolation(error) &&
      (info.constraint === "field_observations_observed_at_check" ||
        (info.message ?? "").includes("field_observations_observed_at_check"))
    ) {
      throw new ObservationFutureDateError(input.observedAt);
    }
    throw error;
  }
}

export async function listFieldObservations(
  tx: TenantTransaction,
  fieldId: string,
  limit = 100,
): Promise<readonly FieldObservationRecord[] | null> {
  const fieldRows = await tx.$queryRaw<{ id: string }[]>`
    SELECT id::text AS id
      FROM app.fields
     WHERE id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
       AND deleted_at IS NULL
  `;
  if (fieldRows.length === 0) return null;

  const rows = await tx.$queryRaw<RawObservation[]>`
    SELECT id::text AS id,
           field_id::text AS field_id,
           kind,
           value,
           unit,
           observed_at,
           method,
           created_at,
           updated_at
      FROM app.field_observations
     WHERE field_id = ${fieldId}::uuid
       AND user_id = NULLIF(current_setting('app.user_id', true), '')::uuid
     ORDER BY observed_at DESC, id DESC
     LIMIT ${limit}
  `;

  return rows.map(toObservation);
}
