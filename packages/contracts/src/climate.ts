import { z } from "zod";
import {
  isoDateSchema,
  isoInstantSchema,
  missingReasonSchema,
  weatherDataClassSchema,
  type WeatherDataClass,
} from "./enums.js";
import { dataInputRefSchema } from "./provenance.js";
import { sha256Hex } from "./hash.js";
import { canonicalJson } from "./canonical.js";

/**
 * Climate-plane contracts — `docs/architecture/climate-data-foundation.md` §5.1,
 * §5.3, §5.6.
 *
 * These are contracts, not a runtime: no adapter, no worker, no persistence, and
 * no provider constant appears here. The grid resolver lives in `grid.ts`; only
 * its `GridSpec` type is referenced.
 */

/* ------------------------------------------------------------------ *
 * Run identity — §5.3
 * ------------------------------------------------------------------ */

/** `product` is the storage CHECK's vocabulary, not a provider's. */
export const forecastProductSchema = z.enum(["forecast", "ensemble", "seasonal", "archive"]);
export type ForecastProduct = z.infer<typeof forecastProductSchema>;

/**
 * Natural identity. `modelVersion` is outside it on purpose: no integrated
 * provider publishes one that changes mid-run, and including it would mint a new
 * identity whenever a provider relabelled the same output.
 */
export const forecastRunIdentitySchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  product: forecastProductSchema,
  initializedAt: isoInstantSchema,
});
export type ForecastRunIdentity = z.infer<typeof forecastRunIdentitySchema>;

/** The persisted row. The id is UUIDv7, minted once per natural identity. */
export const forecastRunSchema = forecastRunIdentitySchema
  .extend({
    id: z.uuid({ version: "v7" }),
    horizonEnd: isoInstantSchema,
    receivedAt: isoInstantSchema,
    createdAt: isoInstantSchema,
  })
  .superRefine((run, ctx) => {
    if (run.horizonEnd <= run.initializedAt) {
      ctx.addIssue({
        code: "custom",
        path: ["horizonEnd"],
        message: "horizonEnd must be after initializedAt",
      });
    }
  });
export type ForecastRun = z.infer<typeof forecastRunSchema>;

export const ingestionRunStatusSchema = z.enum([
  "queued",
  "running",
  "partial",
  "succeeded",
  "failed",
]);
export type IngestionRunStatus = z.infer<typeof ingestionRunStatusSchema>;

const sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/);

/**
 * `ingestionVersion = sha256(adapterVersion, normalizerVersion, targetSelectorHash)`.
 *
 * The preimage is a flat object of three strings: canonical JSON sorts its keys,
 * so the version does not depend on argument order or on this function's source.
 */
export function ingestionVersionOf(input: {
  readonly adapterVersion: string;
  readonly normalizerVersion: string;
  readonly targetSelectorHash: string;
}): string {
  return sha256Hex(
    canonicalJson({
      adapterVersion: input.adapterVersion,
      normalizerVersion: input.normalizerVersion,
      targetSelectorHash: input.targetSelectorHash,
    }),
  );
}

/**
 * Identity of one logical ingest. `attempt` is deliberately absent: it is a
 * physical retry counter on the row, never a component of identity.
 */
export const ingestionRunIdentitySchema = z.strictObject({
  forecastRunId: z.uuid({ version: "v7" }),
  ingestionVersion: sha256HexSchema,
});
export type IngestionRunIdentity = z.infer<typeof ingestionRunIdentitySchema>;

export const ingestionRunErrorSchema = z.strictObject({
  code: z.string().min(1),
  message: z.string().min(1),
  payloadRef: z.string().min(1).optional(),
});
export type IngestionRunError = z.infer<typeof ingestionRunErrorSchema>;

export const ingestionRunSchema = ingestionRunIdentitySchema
  .extend({
    id: z.uuid({ version: "v7" }),
    adapterVersion: z.string().min(1),
    normalizerVersion: z.string().min(1),
    targetSelectorHash: sha256HexSchema,
    status: ingestionRunStatusSchema,
    attempt: z.number().int().min(1),
    startedAt: isoInstantSchema,
    finishedAt: isoInstantSchema.nullable(),
    recordCount: z.number().int().nonnegative(),
    coveragePercent: z.number().min(0).max(100),
    error: ingestionRunErrorSchema.nullable(),
    rawPayloadRef: z.string().min(1).nullable(),
    createdAt: isoInstantSchema,
  })
  .superRefine((run, ctx) => {
    const terminal =
      run.status === "succeeded" || run.status === "failed" || run.status === "partial";
    if (terminal !== (run.finishedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["finishedAt"],
        message: `finishedAt must be ${terminal ? "set" : "null"} for status "${run.status}"`,
      });
    }
    if (run.ingestionVersion !== ingestionVersionOf(run)) {
      ctx.addIssue({
        code: "custom",
        path: ["ingestionVersion"],
        message: "ingestionVersion does not match the versions it claims to derive from",
      });
    }
  });
export type IngestionRun = z.infer<typeof ingestionRunSchema>;

/* ------------------------------------------------------------------ *
 * Adapter boundary — §5.1 and §5.1.1
 * ------------------------------------------------------------------ */

export const adapterMetaSchema = z.strictObject({
  provider: z.string().min(1),
  model: z.string().min(1),
  product: forecastProductSchema,
  initializedAt: isoInstantSchema,
  horizonEnd: isoInstantSchema,
  attribution: z.string().min(1),
  sourceUrl: z.string().min(1),
  adapterVersion: z.string().min(1),
});
export type AdapterMeta = z.infer<typeof adapterMetaSchema>;

/**
 * One observation as the adapter sees it. Run ids are **absent**: they are minted
 * before the fetch and stamped by the worker, and an adapter that invented them
 * would be claiming an identity it does not own.
 */
export const adapterObservationSchema = z.strictObject({
  variable: z.string().min(1),
  dataClass: weatherDataClassSchema,
  amount: z.number().optional(),
  unit: z.string().min(1),
  validAt: isoInstantSchema,
  requestedLat: z.number(),
  requestedLon: z.number(),
  servedLat: z.number(),
  servedLon: z.number(),
  servedValueIsInterpolated: z.boolean(),
  ensembleMember: z.number().int().nonnegative().nullable(),
  missingReason: missingReasonSchema.nullable(),
});
export type AdapterObservation = z.infer<typeof adapterObservationSchema>;

export const adapterCoverageSchema = z
  .strictObject({
    requestedCells: z.number().int().nonnegative(),
    answeredCells: z.number().int().nonnegative(),
    coveragePercent: z.number().min(0).max(100),
  })
  .superRefine((coverage, ctx) => {
    if (coverage.answeredCells > coverage.requestedCells) {
      ctx.addIssue({
        code: "custom",
        path: ["answeredCells"],
        message: "answeredCells cannot exceed requestedCells",
      });
    }
  });
export type AdapterCoverage = z.infer<typeof adapterCoverageSchema>;

const adapterResponseBase = {
  meta: adapterMetaSchema,
  receivedAt: isoInstantSchema,
  rawPayloadRef: z.string().min(1).nullable(),
  sourceUrl: z.string().min(1),
};

/**
 * The taxonomy of §5.1.1, one variant per class. Retry policy is a queue concern;
 * the adapter classifies and stops there.
 */
export const adapterResultSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    ...adapterResponseBase,
    kind: z.literal("complete"),
    observations: z.array(adapterObservationSchema),
    coverage: adapterCoverageSchema,
  }),
  z
    .strictObject({
      ...adapterResponseBase,
      kind: z.literal("partial"),
      observations: z.array(adapterObservationSchema),
      coverage: adapterCoverageSchema,
    })
    .superRefine((result, ctx) => {
      if (result.coverage.coveragePercent >= 100) {
        ctx.addIssue({
          code: "custom",
          path: ["coverage", "coveragePercent"],
          message: "a partial result must report coverage below 100",
        });
      }
    }),
  z.strictObject({
    kind: z.literal("transport"),
    receivedAt: isoInstantSchema,
    meta: adapterMetaSchema.optional(),
    message: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("rate_limited"),
    receivedAt: isoInstantSchema,
    meta: adapterMetaSchema.optional(),
    message: z.string().min(1),
    retryAfterSeconds: z.number().int().nonnegative().optional(),
  }),
  z.strictObject({
    kind: z.literal("request_invalid"),
    receivedAt: isoInstantSchema,
    meta: adapterMetaSchema.optional(),
    message: z.string().min(1),
  }),
  z.strictObject({
    kind: z.literal("provider_changed"),
    receivedAt: isoInstantSchema,
    meta: adapterMetaSchema.optional(),
    message: z.string().min(1),
  }),
]);
export type AdapterResult = z.infer<typeof adapterResultSchema>;

/* ------------------------------------------------------------------ *
 * Monthly outlook — §5.6 and temporal-and-weather-semantics.md §3, §6
 * ------------------------------------------------------------------ */

/**
 * Lead month index, 0 = the current month. The bands are the binding table's,
 * not an extrapolation: months 0–1 are assembled from the daily and subseasonal
 * bands, months 2–7 are seasonal, months 8–12 are the historical normal.
 */
export const MONTHLY_OUTLOOK_BANDS = [
  { fromLeadMonth: 0, toLeadMonth: 1, permitted: ["weather_forecast", "subseasonal_forecast"] },
  { fromLeadMonth: 2, toLeadMonth: 7, permitted: ["seasonal_forecast"] },
  { fromLeadMonth: 8, toLeadMonth: 12, permitted: ["climatology"] },
] as const satisfies ReadonlyArray<{
  fromLeadMonth: number;
  toLeadMonth: number;
  permitted: readonly WeatherDataClass[];
}>;

/** Empty for an index outside `0..12`; the schema rejects rather than guesses. */
export function permittedMonthlyDataClasses(leadMonth: number): readonly WeatherDataClass[] {
  const band = MONTHLY_OUTLOOK_BANDS.find(
    (candidate) => leadMonth >= candidate.fromLeadMonth && leadMonth <= candidate.toLeadMonth,
  );
  return band ? band.permitted : [];
}

/** The five reasons that mean "no value may be claimed". */
const noValueReasons = new Set([
  "pending",
  "ingest_failed",
  "provider_unavailable",
  "not_requested",
  "insufficient_history",
  "below_coverage_threshold",
]);

export const outlookMonthSchema = z
  .strictObject({
    leadMonth: z.number().int().min(0).max(12),
    month: isoDateSchema,
    dataClass: weatherDataClassSchema.nullable(),
    valueMm: z.number().nonnegative().nullable(),
    missingReason: missingReasonSchema.nullable(),
    baselineVersion: z.string().min(1).nullable(),
    anomalyKind: z.enum(["model_anomaly", "baseline_difference"]).nullable(),
    ensembleSpreadMm: z.number().nonnegative().nullable(),
    spreadUnavailableReason: z.string().min(1).nullable(),
  })
  .superRefine((month, ctx) => {
    // Value presence and class presence move together. A value with no class has
    // no label; a class with no value is a fabricated number.
    if ((month.valueMm === null) !== (month.dataClass === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: "valueMm and dataClass must be present or absent together",
      });
    }
    if (month.valueMm === null && month.missingReason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["missingReason"],
        message: "a month with no value must state why",
      });
    }
    if (
      month.missingReason !== null &&
      noValueReasons.has(month.missingReason) &&
      month.valueMm !== null
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["valueMm"],
        message: `missingReason "${month.missingReason}" forbids a value`,
      });
    }
    // Climatology is a labelled historical normal, never a filled forecast.
    if (month.missingReason === "beyond_horizon" && month.dataClass !== "climatology") {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: "beyond_horizon may only label climatology",
      });
    }
    if (month.dataClass === "climatology") {
      if (month.baselineVersion === null) {
        ctx.addIssue({
          code: "custom",
          path: ["baselineVersion"],
          message: "a climatology month must name its baseline",
        });
      }
      if (month.missingReason !== "beyond_horizon") {
        ctx.addIssue({
          code: "custom",
          path: ["missingReason"],
          message: "a climatology month must be labelled beyond_horizon",
        });
      }
      if (month.anomalyKind !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["anomalyKind"],
          message: "a climatology month carries no initialization-derived anomaly",
        });
      }
    }
    if (month.ensembleSpreadMm === null && month.spreadUnavailableReason === null) {
      ctx.addIssue({
        code: "custom",
        path: ["spreadUnavailableReason"],
        message: "a missing spread must state its reason",
      });
    }
    if (month.ensembleSpreadMm !== null && month.spreadUnavailableReason !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["spreadUnavailableReason"],
        message: "a present spread must not carry a missing reason",
      });
    }
    // A missing forecast must not silently become climatology: only the band that
    // permits climatology may carry it, and months before it may not.
    const permitted = permittedMonthlyDataClasses(month.leadMonth);
    if (permitted.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["leadMonth"],
        message: "leadMonth must be between 0 and 12",
      });
    } else if (month.dataClass !== null && !permitted.includes(month.dataClass)) {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: `dataClass "${month.dataClass}" is not permitted at lead month ${month.leadMonth}`,
      });
    }
  });
export type OutlookMonth = z.infer<typeof outlookMonthSchema>;

/** The materialised row the read path serves, built on the month-state rules. */
export const monthlyOutlookSchema = outlookMonthSchema.extend({
  id: z.uuid({ version: "v7" }),
  outlookCellId: z.uuid({ version: "v7" }),
  variable: z.literal("precipitation"),
  evaluationBasis: z.enum(["monthly", "climatology"]),
  derivationVersion: z.string().min(1),
  inputRefs: z.array(dataInputRefSchema).min(1),
  inputSnapshotHash: sha256HexSchema,
  computedAt: isoInstantSchema,
  status: z.enum(["active", "superseded", "failed"]),
  supersededById: z.uuid({ version: "v7" }).nullable(),
});
export type MonthlyOutlook = z.infer<typeof monthlyOutlookSchema>;
