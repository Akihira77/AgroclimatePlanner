import { z } from "zod";

import { isoDateSchema, isoInstantSchema, opaqueIdSchema } from "./enums.js";
import { envelopeSchema } from "./response.js";

/**
 * Planting, harvest, and local field observation contracts (Phase 3.6 & 3.7).
 *
 * `OPEN-09` (settled 2026-11-28): `plantings.status` uses the four-value
 * vocabulary `active | harvested | failed | abandoned`.
 */

export const plantingStatusSchema = z.enum(["active", "harvested", "failed", "abandoned"]);
export type PlantingStatus = z.infer<typeof plantingStatusSchema>;

export const plantingCycleStartSchema = z.enum(["sowing", "transplant"]);
export type PlantingCycleStart = z.infer<typeof plantingCycleStartSchema>;

export const plantingIdSchema = z.uuid();
export type PlantingId = z.infer<typeof plantingIdSchema>;

export const plantingCreateSchema = z.strictObject({
  fieldId: z.uuid(),
  cultivarId: z.uuid(),
  plantedAt: isoDateSchema,
  cycleStartUsed: plantingCycleStartSchema,
  areaPlantedHa: z.number().finite().positive(),
});
export type PlantingCreateRequest = z.infer<typeof plantingCreateSchema>;

export const plantingUpdateSchema = z.strictObject({
  status: plantingStatusSchema,
});
export type PlantingUpdateRequest = z.infer<typeof plantingUpdateSchema>;

export const plantingSchema = z.strictObject({
  id: opaqueIdSchema,
  fieldId: opaqueIdSchema,
  cultivarId: opaqueIdSchema,
  cultivarName: z.string().min(1),
  cropSlug: z.string().min(1),
  cropNameId: z.string().min(1),
  plantedAt: isoDateSchema,
  cycleStartUsed: plantingCycleStartSchema,
  areaPlantedHa: z.number().positive(),
  status: plantingStatusSchema,
  expectedHarvestEarliest: isoDateSchema,
  expectedHarvestTypical: isoDateSchema,
  expectedHarvestLatest: isoDateSchema,
  totalYieldKg: z.number().nonnegative(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type Planting = z.infer<typeof plantingSchema>;

export const plantingListQuerySchema = z.strictObject({
  fieldId: z.uuid().optional(),
  status: plantingStatusSchema.optional(),
});
export type PlantingListQuery = z.infer<typeof plantingListQuerySchema>;

export const harvestCreateSchema = z.strictObject({
  harvestedAt: isoDateSchema,
  yieldKg: z.number().finite().nonnegative(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type HarvestCreateRequest = z.infer<typeof harvestCreateSchema>;

export const harvestSchema = z.strictObject({
  id: opaqueIdSchema,
  plantingId: opaqueIdSchema,
  harvestedAt: isoDateSchema,
  yieldKg: z.number().nonnegative(),
  notes: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type Harvest = z.infer<typeof harvestSchema>;

export const harvestListMetaSchema = z.strictObject({
  totalYieldKg: z.number().nonnegative(),
});
export type HarvestListMeta = z.infer<typeof harvestListMetaSchema>;

export const fieldObservationKindSchema = z.enum([
  "rainfall",
  "soil_moisture",
  "temperature",
  "note",
]);
export type FieldObservationKind = z.infer<typeof fieldObservationKindSchema>;

export const fieldObservationCreateSchema = z
  .strictObject({
    kind: fieldObservationKindSchema,
    value: z.number().finite().nullable().optional(),
    unit: z.string().trim().min(1).max(32).nullable().optional(),
    observedAt: isoInstantSchema,
    method: z.string().trim().min(1).max(200).nullable().optional(),
  })
  .superRefine((obs, ctx) => {
    const hasValue = obs.value !== undefined && obs.value !== null;
    const hasUnit = obs.unit !== undefined && obs.unit !== null;

    if (obs.kind === "note") {
      if (hasValue) {
        ctx.addIssue({
          code: "custom",
          path: ["value"],
          message: "note observation must not carry a numeric value",
        });
      }
      if (hasUnit) {
        ctx.addIssue({
          code: "custom",
          path: ["unit"],
          message: "note observation must not carry a unit",
        });
      }
      return;
    }

    if (!hasValue) {
      ctx.addIssue({
        code: "custom",
        path: ["value"],
        message: "measurement observation requires a numeric value",
      });
    }
    if (!hasUnit) {
      ctx.addIssue({
        code: "custom",
        path: ["unit"],
        message: "measurement observation requires a unit",
      });
    }
  });
export type FieldObservationCreateRequest = z.infer<typeof fieldObservationCreateSchema>;

export const fieldObservationSchema = z.strictObject({
  id: opaqueIdSchema,
  fieldId: opaqueIdSchema,
  kind: fieldObservationKindSchema,
  value: z.number().nullable(),
  unit: z.string().nullable(),
  observedAt: isoInstantSchema,
  method: z.string().nullable(),
  createdAt: isoInstantSchema,
  updatedAt: isoInstantSchema,
});
export type FieldObservation = z.infer<typeof fieldObservationSchema>;

export const plantingEnvelopeSchema = envelopeSchema(plantingSchema);
export const plantingListEnvelopeSchema = envelopeSchema(z.array(plantingSchema));
export const harvestEnvelopeSchema = envelopeSchema(harvestSchema);
export const harvestListEnvelopeSchema = envelopeSchema(
  z.array(harvestSchema),
  harvestListMetaSchema,
);
export const fieldObservationEnvelopeSchema = envelopeSchema(fieldObservationSchema);
export const fieldObservationListEnvelopeSchema = envelopeSchema(z.array(fieldObservationSchema));
