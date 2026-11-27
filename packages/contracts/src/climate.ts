import { z } from "zod";
import {
  isoDateSchema,
  isoInstantSchema,
  missingReasonSchema,
  opaqueIdSchema,
  weatherDataClassSchema,
  type WeatherDataClass,
} from "./enums.js";
import { fieldIdSchema } from "./field.js";
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
 * One cell/variable pair the ingest asked for. The pair is the unit: two
 * parallel arrays would lose which variable belongs to which cell, and a
 * selector that cannot say that cannot be hashed faithfully.
 */
export const targetSelectorEntrySchema = z.strictObject({
  cellKey: z.string().min(1),
  variable: z.string().min(1),
});
export type TargetSelectorEntry = z.infer<typeof targetSelectorEntrySchema>;

/**
 * The canonical target selector — `{ cells: [{ cellKey, variable }] }`.
 *
 * `canonicalArrayRules.cells` sorts by the tuple `(cellKey, variable)` and
 * dedupes an exactly repeated pair, so `targetSelectorHashOf` is a function of
 * the set, not of the order a caller happened to build it in.
 */
export const targetSelectorSchema = z.strictObject({
  cells: z.array(targetSelectorEntrySchema),
});
export type TargetSelector = z.infer<typeof targetSelectorSchema>;

/** `targetSelectorHash = SHA256(canonicalJson({ cells }))`. */
export function targetSelectorHashOf(selector: TargetSelector): string {
  return sha256Hex(canonicalJson({ cells: selector.cells }));
}

/* ------------------------------------------------------------------ *
 * Climatology baseline — Phase 5.5
 * ------------------------------------------------------------------ */

/** The datasets a baseline builder may produce. Matches `climatology_normals_dataset_check`. */
export const baselineDatasetSchema = z.enum(["era5", "chirps_v3", "nasa_power"]);
export type BaselineDataset = z.infer<typeof baselineDatasetSchema>;

/**
 * One stored monthly normal, as it exists in `app.climatology_normals`.
 *
 * `month` is the first day of a calendar month. `sampleYears` is the number of
 * baseline years that contributed a complete monthly total; it is never a
 * coverage percentage and never inferred from the period length.
 */
export const baselineMonthlyNormalSchema = z.strictObject({
  cellKey: z.string().min(1),
  month: isoDateSchema.refine((month) => month.slice(8, 10) === "01", {
    message: "month must be the first day of a calendar month",
  }),
  valueMm: z.number().nonnegative(),
  sampleYears: z.number().int().positive().max(30),
});
export type BaselineMonthlyNormal = z.infer<typeof baselineMonthlyNormalSchema>;

/**
 * The baseline hash preimage: the exact monthly normals of the cell subset a
 * derivation consumed, not a global hash of the table.
 *
 * `monthlyNormals` is a set ordered by `(cellKey, month)` in the canonicaliser,
 * so the hash is independent of emission order. A duplicate `(cellKey, month)`
 * with conflicting content is a canonicalisation error, not a silent collapse.
 */
export const baselineNormalsPayloadSchema = z.strictObject({
  baselineVersion: z.string().min(1),
  baselineDataset: baselineDatasetSchema,
  monthlyNormals: z.array(baselineMonthlyNormalSchema).min(1),
});
export type BaselineNormalsPayload = z.infer<typeof baselineNormalsPayloadSchema>;

/**
 * The idempotency key of one ingestion job:
 * `ingest:{queue}:{forecastRunId}:{ingestionVersion}`.
 *
 * `forecastRunId` is mandatory because `ingestionVersion` is not derived from
 * it: two forecast runs fetched with the same adapter, normalizer and target
 * selector share a version, and a key without the run id would make the second
 * run unenqueueable.
 *
 * `ingestionVersion` — not `targetSelectorHash` — is what makes a normalizer or
 * adapter bump produce a distinct job. `targetSelectorHash` is already inside
 * the version, so naming it again would add nothing and could drift.
 */
export function ingestionJobIdentityOf(input: {
  readonly queue: string;
  readonly forecastRunId: string;
  readonly adapterVersion: string;
  readonly normalizerVersion: string;
  readonly targetSelectorHash: string;
}): { readonly ingestionVersion: string; readonly idempotencyKey: string } {
  const ingestionVersion = ingestionVersionOf(input);
  return {
    ingestionVersion,
    idempotencyKey: `ingest:${input.queue}:${input.forecastRunId}:${ingestionVersion}`,
  };
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

/**
 * Coverage percentage, in basis points, rounded half away from zero.
 *
 * One implementation so the schema and a producer cannot disagree. `requestedCells`
 * must be at least one: a request for nothing is a programming error, not a result,
 * which removes the division-by-zero case instead of inventing a meaning for it.
 */
export function coveragePercentOf(requestedCells: number, answeredCells: number): number {
  if (!Number.isInteger(requestedCells) || requestedCells < 1) {
    throw new RangeError("requestedCells must be a positive integer");
  }
  if (!Number.isInteger(answeredCells) || answeredCells < 0) {
    throw new RangeError("answeredCells must be a non-negative integer");
  }
  return Math.round((answeredCells * 10_000) / requestedCells) / 100;
}

export const adapterCoverageSchema = z
  .strictObject({
    requestedCells: z.number().int().min(1),
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
    if (
      coverage.requestedCells >= 1 &&
      coverage.coveragePercent !==
        coveragePercentOf(coverage.requestedCells, coverage.answeredCells)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["coveragePercent"],
        message: `coveragePercent must equal coveragePercentOf(${coverage.requestedCells}, ${coverage.answeredCells})`,
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
  z
    .strictObject({
      ...adapterResponseBase,
      kind: z.literal("complete"),
      observations: z.array(adapterObservationSchema),
      coverage: adapterCoverageSchema,
    })
    .superRefine((result, ctx) => {
      // Counts decide, never the rounded percentage: 20 000 of 20 001 cells rounds
      // to 100 but is still a partial answer (F-07).
      if (result.coverage.answeredCells !== result.coverage.requestedCells) {
        ctx.addIssue({
          code: "custom",
          path: ["coverage", "answeredCells"],
          message: "a complete result must answer every requested cell",
        });
      }
    }),
  z
    .strictObject({
      ...adapterResponseBase,
      kind: z.literal("partial"),
      observations: z.array(adapterObservationSchema),
      coverage: adapterCoverageSchema,
    })
    .superRefine((result, ctx) => {
      // Same rule from the other side: a rounded 100 must not be read as complete,
      // so only the counts can make this variant invalid.
      if (result.coverage.answeredCells >= result.coverage.requestedCells) {
        ctx.addIssue({
          code: "custom",
          path: ["coverage", "answeredCells"],
          message: "a partial result must leave at least one requested cell unanswered",
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
 * Lead month is **1-based and inclusive: 1–12**. Exactly twelve entries describe
 * the rolling outlook; there is no month 0 and no month 13.
 *
 * The bands follow `temporal-and-weather-semantics.md` §3 and are a **source
 * capability** test, not an inference from the daily bands. A calendar month is
 * 28–31 days, so a class is permitted only when one documented product supplies a
 * monthly quantity for the whole month:
 *
 * - `seasonal_forecast` — SEAS5 monthly rows are observed. One run supplies the
 *   initialisation month plus six following months; under the approved lead-month
 *   definition (lead 1 = the month *after* initialisation) that is leads 1–6.
 * - `climatology` — a 1991–2020 monthly normal. Approved band: leads 7–12.
 *
 * `weather_forecast` (16 d) and `subseasonal_forecast` (EC46, 46 d, and **no**
 * monthly product: `models=ecmwf_ec46&monthly=…` returns 0 rows) cannot supply a
 * whole calendar month. A month built from their daily values would need a
 * daily→monthly aggregation rule and a coverage threshold, neither of which exists;
 * that is `Q-P5-6`, not a class this contract may accept.
 */
export const MONTHLY_OUTLOOK_BANDS = [
  { fromLeadMonth: 1, toLeadMonth: 6, permitted: ["seasonal_forecast"] },
  { fromLeadMonth: 7, toLeadMonth: 12, permitted: ["climatology"] },
] as const satisfies ReadonlyArray<{
  fromLeadMonth: number;
  toLeadMonth: number;
  permitted: readonly WeatherDataClass[];
}>;

/** The twelve valid lead months, in order. */
export const LEAD_MONTHS = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] as const;

/** Empty for anything outside `1..12`; the schema rejects rather than guesses. */
export function permittedMonthlyDataClasses(leadMonth: number): readonly WeatherDataClass[] {
  const band = MONTHLY_OUTLOOK_BANDS.find(
    (candidate) => leadMonth >= candidate.fromLeadMonth && leadMonth <= candidate.toLeadMonth,
  );
  return band ? band.permitted : [];
}

/**
 * The calendar month that lead month `n` refers to, given the month lead month 1
 * refers to. Pure string arithmetic: no `Date`, no timezone, and December→January
 * rollover is a year increment by construction.
 */
export function calendarMonthOf(firstMonth: string, leadMonth: number): string {
  if (!isoDateSchema.safeParse(firstMonth).success || firstMonth.slice(8, 10) !== "01") {
    throw new RangeError("firstMonth must be a valid calendar date on the first of a month");
  }
  if (!Number.isInteger(leadMonth) || leadMonth < 1 || leadMonth > 12) {
    throw new RangeError("leadMonth must be an integer between 1 and 12");
  }
  const year = Number(firstMonth.slice(0, 4));
  const month = Number(firstMonth.slice(5, 7));
  const total = year * 12 + (month - 1) + (leadMonth - 1);
  const monthOfYear = (total % 12) + 1;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String(monthOfYear).padStart(2, "0")}-01`;
}

/** The two bases a materialised outlook month may carry. */
export const outlookEvaluationBasisSchema = z.enum(["monthly", "climatology"]);
export type OutlookEvaluationBasis = z.infer<typeof outlookEvaluationBasisSchema>;

/** The reasons that mean "no value may be claimed" (`beyond_horizon` is separate). */
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
    leadMonth: z.number().int().min(1).max(12),
    /** First day of the calendar month this entry describes. */
    month: isoDateSchema,
    dataClass: weatherDataClassSchema.nullable(),
    evaluationBasis: outlookEvaluationBasisSchema,
    valueMm: z.number().nonnegative().nullable(),
    missingReason: missingReasonSchema.nullable(),
    baselineVersion: z.string().min(1).nullable(),
    anomalyKind: z.enum(["model_anomaly", "baseline_difference"]).nullable(),
    ensembleSpreadMm: z.number().nonnegative().nullable(),
    spreadUnavailableReason: z.string().min(1).nullable(),
  })
  .superRefine((month, ctx) => {
    if (month.month.slice(8, 10) !== "01") {
      ctx.addIssue({
        code: "custom",
        path: ["month"],
        message: "month must be the first day of a calendar month",
      });
    }
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
    // F-05: class and basis are two statements about the same value and may not
    // contradict. A climatology value is not a forecast; a forecast value is not
    // a historical normal; a month with no value is neither.
    if (month.dataClass === null) {
      if (month.evaluationBasis !== "monthly") {
        ctx.addIssue({
          code: "custom",
          path: ["evaluationBasis"],
          message: "a month with no value cannot claim a climatology evaluation basis",
        });
      }
    } else {
      const isClimatology = month.dataClass === "climatology";
      if (isClimatology !== (month.evaluationBasis === "climatology")) {
        ctx.addIssue({
          code: "custom",
          path: ["evaluationBasis"],
          message: isClimatology
            ? "a climatology month must use the climatology evaluation basis"
            : "a forecast month must not claim a climatology evaluation basis",
        });
      }
    }
    // An anomaly is derived from a value; a month without one has nothing to
    // compare, and a baseline difference must name its baseline.
    if (month.valueMm === null && month.anomalyKind !== null) {
      ctx.addIssue({
        code: "custom",
        path: ["anomalyKind"],
        message: "a month with no value cannot carry an anomaly",
      });
    }
    if (month.anomalyKind === "baseline_difference" && month.baselineVersion === null) {
      ctx.addIssue({
        code: "custom",
        path: ["baselineVersion"],
        message: "a baseline_difference anomaly must name its baseline",
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
    // permits climatology may carry it, and earlier months may not.
    const permitted = permittedMonthlyDataClasses(month.leadMonth);
    if (permitted.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["leadMonth"],
        message: "leadMonth must be between 1 and 12",
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

/** One issue about the horizon axis, path relative to the horizon object. */
interface HorizonIssue {
  readonly path: (string | number)[];
  readonly message: string;
}

/**
 * The twelve-entry rule, in one place because two schemas apply it: entry `i` is
 * lead month `i + 1`, and lead month `n` names `calendarMonthOf(firstMonth, n)`.
 * A duplicate therefore also leaves a gap.
 *
 * An off-axis `firstMonth` is reported alone, because every entry would otherwise
 * repeat the same consequence.
 */
function horizonIssues(
  firstMonth: string,
  months: readonly { readonly leadMonth: number; readonly month: string }[],
): HorizonIssue[] {
  if (firstMonth.slice(8, 10) !== "01") {
    return [
      { path: ["firstMonth"], message: "firstMonth must be the first day of a calendar month" },
    ];
  }

  const issues: HorizonIssue[] = [];
  months.forEach((month, index) => {
    const expectedLeadMonth = index + 1;
    if (month.leadMonth !== expectedLeadMonth) {
      issues.push({
        path: ["months", index, "leadMonth"],
        message: `entry ${index} must be lead month ${expectedLeadMonth}; entries are ordered 1–12`,
      });
    }
    const expectedMonth = calendarMonthOf(firstMonth, expectedLeadMonth);
    if (month.month !== expectedMonth) {
      issues.push({
        path: ["months", index, "month"],
        message: `lead month ${expectedLeadMonth} of ${firstMonth} is ${expectedMonth}`,
      });
    }
  });
  return issues;
}

/**
 * A complete rolling outlook: twelve months, lead months 1–12 in order, each
 * bound to its calendar month. The array is a **sequence**, so position carries
 * meaning and no normalisation is attempted.
 */
export const monthlyOutlookHorizonSchema = z
  .strictObject({
    /** The calendar month lead month 1 describes. */
    firstMonth: isoDateSchema,
    months: z.array(outlookMonthSchema).length(12),
  })
  .superRefine((horizon, ctx) => {
    for (const issue of horizonIssues(horizon.firstMonth, horizon.months)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });
export type MonthlyOutlookHorizon = z.infer<typeof monthlyOutlookHorizonSchema>;

/** The materialised row the read path serves, built on the month-state rules. */
export const monthlyOutlookSchema = outlookMonthSchema.extend({
  id: z.uuid({ version: "v7" }),
  outlookCellId: z.uuid({ version: "v7" }),
  variable: z.literal("precipitation"),
  derivationVersion: z.string().min(1),
  inputRefs: z.array(dataInputRefSchema).min(1),
  inputSnapshotHash: sha256HexSchema,
  computedAt: isoInstantSchema,
  status: z.enum(["active", "superseded", "failed"]),
  supersededById: z.uuid({ version: "v7" }).nullable(),
});
export type MonthlyOutlook = z.infer<typeof monthlyOutlookSchema>;

/* ------------------------------------------------------------------ *
 * Monthly value estimator — Q-P5-7, resolved 2026-11-24
 * ------------------------------------------------------------------ */

/**
 * How `valueMm` was estimated. Both estimators answer one question — the expected
 * precipitation accumulation of a single calendar month, in mm — over different
 * populations, and neither is a realised total.
 *
 * - `ensemble_mean`: the arithmetic mean of the 50 SEAS5 members' monthly totals
 *   for one initialisation, i.e. the provider's `precipitation_mean`. Measured on
 *   2026-11-23: the mean of the per-member monthly sums reproduces that column for
 *   all seven months (ratios 0.989–1.011, the provider's 0.1 mm rounding), so the
 *   provider quantity and the member series describe the same thing.
 * - `climatological_mean`: the arithmetic mean of the baseline years' monthly
 *   totals for one calendar month — a historical normal, never a forecast.
 */
export const monthlyOutlookEstimatorSchema = z.enum(["ensemble_mean", "climatological_mean"]);
export type MonthlyOutlookEstimator = z.infer<typeof monthlyOutlookEstimatorSchema>;

/**
 * The approved mapping, and the whole of it. A class absent from this object has
 * **no** approved estimator, so a value that claims one is unrepresentable rather
 * than guessed.
 *
 * No estimator column exists: the mapping is total over the classes v1 can
 * produce, so `data_class` determines it and a stored copy could only drift from
 * the contract. A second estimator for the same class would need the column.
 */
const ESTIMATOR_BY_DATA_CLASS: Readonly<
  Partial<Record<WeatherDataClass, MonthlyOutlookEstimator>>
> = {
  seasonal_forecast: "ensemble_mean",
  climatology: "climatological_mean",
};

/** `null` when there is no class, or when the class has no approved monthly estimator. */
export function estimatorForDataClass(
  dataClass: WeatherDataClass | null,
): MonthlyOutlookEstimator | null {
  if (dataClass === null) return null;
  return ESTIMATOR_BY_DATA_CLASS[dataClass] ?? null;
}

/* ------------------------------------------------------------------ *
 * Seasonal record-set provenance — Phase 5.7D
 * ------------------------------------------------------------------ */

/**
 * The canonical preimage of a seasonal month's `recordSetHash`.
 *
 * The hash identifies the **population actually consumed**, not merely its size:
 * the run and ingestion identities, the cell, every member index with its monthly
 * total, and the valid member count per month. Changing a member identity, a
 * consumed value, the member count, or the set of months changes the hash.
 *
 * Ordering is the producer's responsibility: the assembler sorts members by
 * `(month, memberIndex)` before hashing, so an equivalent population in a
 * different emission order hashes identically. The schema does not re-sort, since
 * a hash function that silently rewrites its input hides a caller's mistake.
 */
export const seasonalRecordSetPayloadSchema = z.strictObject({
  artifact: z.literal("seasonal_outlook_population"),
  forecastRunId: opaqueIdSchema,
  ingestionRunId: opaqueIdSchema,
  cellKey: z.string().min(1),
  memberCountByMonth: z
    .array(
      z.strictObject({
        month: isoDateSchema,
        memberCount: z.number().int().positive(),
      }),
    )
    .min(1),
  members: z
    .array(
      z.strictObject({
        month: isoDateSchema,
        memberIndex: z.number().int().min(0).max(49),
        valueMm: z.number().nonnegative(),
      }),
    )
    .min(1),
});
export type SeasonalRecordSetPayload = z.infer<typeof seasonalRecordSetPayloadSchema>;

/* ------------------------------------------------------------------ *
 * Monthly outlook read path — 5.7B
 * ------------------------------------------------------------------ */

/**
 * Read-time freshness of a materialised seasonal month — Phase 5.7D.
 *
 * `fresh` and `stale` are both **usable**. A month with no investment-derived
 * value (climatology, or no row at all) carries `null`: freshness is a property
 * of a forecast run, not of a normal or of an absence.
 */
export const outlookAvailabilitySchema = z.enum(["fresh", "stale"]);
export type OutlookAvailability = z.infer<typeof outlookAvailabilitySchema>;

/**
 * One served month: the stored month state (`outlookMonthSchema`) plus what a
 * consumer needs in order to read the number honestly — the estimator that
 * produced it, the unit, and the derivation that wrote the row.
 *
 * `unit` is repeated per month on purpose. `valueMm` already carries mm in its
 * name, and a consumer that has to recover a unit from a field name is one
 * refactor away from rendering a ratio as millimetres.
 *
 * A month with no value carries no estimator and no derivation: nothing produced
 * it, and naming a derivation would attribute a formula to an absence.
 */
export const climateOutlookMonthSchema = outlookMonthSchema
  .extend({
    unit: z.literal("mm"),
    estimator: monthlyOutlookEstimatorSchema.nullable(),
    /** The derivation that wrote the row; `null` when no row exists for the month. */
    derivationVersion: z.string().min(1).nullable(),
    /** Read-time only. Never stored, never inferred for a normal or an absence. */
    availability: outlookAvailabilitySchema.nullable(),
  })
  .superRefine((month, ctx) => {
    const expected = estimatorForDataClass(month.dataClass);

    const isForecast = month.dataClass === "seasonal_forecast";
    if (isForecast !== (month.availability !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["availability"],
        message: isForecast
          ? "a seasonal forecast month must state whether it is fresh or stale"
          : "only a seasonal forecast month carries read-time availability",
      });
    }

    if (month.dataClass === null) {
      if (month.estimator !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["estimator"],
          message: "a month with no value cannot carry an estimator",
        });
      }
      if (month.derivationVersion !== null) {
        ctx.addIssue({
          code: "custom",
          path: ["derivationVersion"],
          message: "a month with no value cannot name a derivation",
        });
      }
      return;
    }

    if (expected === null) {
      ctx.addIssue({
        code: "custom",
        path: ["dataClass"],
        message: `dataClass "${month.dataClass}" has no approved monthly estimator`,
      });
      return;
    }

    if (month.estimator !== expected) {
      ctx.addIssue({
        code: "custom",
        path: ["estimator"],
        message: `dataClass "${month.dataClass}" is estimated by "${expected}", not "${month.estimator}"`,
      });
    }

    if (month.derivationVersion === null) {
      ctx.addIssue({
        code: "custom",
        path: ["derivationVersion"],
        message: "a month with a value must name the derivation that produced it",
      });
    }
  });
export type ClimateOutlookMonth = z.infer<typeof climateOutlookMonthSchema>;

/**
 * `GET /v1/climate/outlook` — Phase 5.7B.
 *
 * `provider`/`model` are the grid identity, named by the caller. The API holds no
 * persisted field→cell mapping (`field_outlook_cells` has no writer; 5.2 defers
 * it), so the resolution is the same explicit registry lookup
 * `POST /v1/fields/:fieldId/resolve-cell` performs. Deriving a model from a field
 * would be inventing a mapping.
 *
 * `firstMonth` is optional and is echoed in the response. There is no stored
 * "current horizon": an outlook is materialised for the twelve months starting at
 * the month its `aggregate` job named. Omitting it asks for the horizon beginning
 * with the current Asia/Jakarta month — what a dashboard means — and the response
 * states which horizon it answered, so the caller never has to assume.
 */
export const climateOutlookQuerySchema = z.strictObject({
  fieldId: fieldIdSchema,
  provider: z.string().min(1).max(64),
  model: z.string().min(1).max(128),
  firstMonth: isoDateSchema
    .refine((month) => month.slice(8, 10) === "01", {
      message: "firstMonth must be the first day of a calendar month",
    })
    .optional(),
});
export type ClimateOutlookQuery = z.infer<typeof climateOutlookQuerySchema>;

/**
 * The twelve-month horizon as served.
 *
 * Every month is present, including the ones with no row. A month that was never
 * materialised is `pending` with no value: it is not zero, and it is not
 * `ingest_failed` — nothing stores the cause of a failed outlook derivation, so
 * the read path cannot claim one.
 */
export const climateOutlookSchema = z
  .strictObject({
    fieldId: z.uuid(),
    provider: z.string().min(1),
    model: z.string().min(1),
    firstMonth: isoDateSchema,
    /** The unit every month's `valueMm` is expressed in. */
    unit: z.literal("mm"),
    months: z.array(climateOutlookMonthSchema).length(12),
  })
  .superRefine((outlook, ctx) => {
    for (const issue of horizonIssues(outlook.firstMonth, outlook.months)) {
      ctx.addIssue({ code: "custom", ...issue });
    }
  });
export type ClimateOutlook = z.infer<typeof climateOutlookSchema>;
