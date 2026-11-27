import {
  baselineNormalsPayloadSchema,
  calendarMonthOf,
  dataInputRefSchema,
  hashBaselineNormals,
  hashDerivationDescriptor,
  monthlyOutlookHorizonSchema,
  type BaselineDataset,
  type DataInputRef,
  type MonthlyOutlookHorizon,
  type OutlookMonth,
} from "@agroclimate/contracts";

/**
 * Climatology-only outlook assembly — Phase 5.7A.
 *
 * Pure arithmetic and string work: no `Date`, no timezone, no database, no
 * provider. The 12-month horizon is a function of `firstMonth`, one cell key and
 * the stored 1991–2020 normals, so the same inputs produce byte-identical output
 * on every machine and every retry.
 *
 * Three boundaries are deliberately hard:
 *
 * 1. **Only lead months 7–12 may carry climatology.** `permittedMonthlyDataClasses`
 *    already refuses a climatology class outside that band, and this module never
 *    asks it to. Lead months 1–6 are assembled as explicit no-value entries; a
 *    climatology normal is never shifted into them to fill the grid — those months
 *    belong to the seasonal forecast band.
 * 2. **A month with no value is never persisted.** `MonthlyOutlook` requires at
 *    least one `inputRef`, and a `pending` month has none. Fabricating a
 *    sentinel ref would make the provenance record lie. Those months exist in the
 *    assembled horizon and nowhere else; the read path synthesises them.
 * 3. **A normal is not a forecast.** `climatology_normals.value_mm` is a mean of
 *    monthly totals with no initialization time. It is labelled
 *    `dataClass = "climatology"` + `missingReason = "beyond_horizon"` and nothing
 *    promotes it to a forecast class.
 *
 * Spread is not computed here. A climatology normal has no ensemble, and the
 * month-state columns require a reason whenever the spread is absent, so a
 * stable token is emitted instead of `NULL` next to `NULL`.
 */

/**
 * The derivation rule-set version. Bump when the assembly changes the numbers or
 * their meaning — the lead-month band, the normal-to-month matching rule, the
 * missing-baseline reason, or the provenance shape. Do not bump it for a refactor
 * that leaves the output byte-identical; the value is what a stored outlook
 * repeats, and a retry must not mint a new derivation.
 */
export const CLIMATOLOGY_OUTLOOK_DERIVATION_VERSION = "climatology-outlook@1.0.0";

/** The band `permittedMonthlyDataClasses` allows climatology in. Never widened here. */
export const CLIMATOLOGY_FIRST_LEAD_MONTH = 7;
export const CLIMATOLOGY_LAST_LEAD_MONTH = 12;

/**
 * `spread_unavailable_reason` tokens.
 *
 * The column is free text with no CHECK, so the vocabulary is held here rather
 * than invented per call site. A month with no value has no spread to describe;
 * a climatology normal has no ensemble to describe. Neither token is a claim
 * about a provider.
 */
export const SPREAD_REASON_NO_VALUE = "no_value";
export const SPREAD_REASON_CLIMATOLOGY = "climatology_has_no_ensemble";

/**
 * The one reason a month with no stored row is served with. Every lead month
 * 1–12 now has an approved source class, so "no product exists" is no longer true
 * of any of them; `pending` is the weakest true claim the read path can make.
 */
export const PENDING_OUTLOOK_REASON = "pending";

/** The baseline holds no normal for that calendar month (`tables-climate.md` §5). */
export const MISSING_BASELINE_REASON = "insufficient_history";

/** One stored `app.climatology_normals` row, as the aggregator consumes it. */
export interface StoredBaselineNormal {
  /** First day of a calendar month, e.g. `1991-04-01`. */
  readonly month: string;
  readonly valueMm: number;
  /** Complete baseline years that contributed; `NULL` is a gap in provenance. */
  readonly sampleYears: number | null;
}

export interface ClimatologyOutlookInput {
  /** The calendar month lead month 1 describes, first-of-month. */
  readonly firstMonth: string;
  readonly cellKey: string;
  readonly baselineVersion: string;
  readonly baselineDataset: BaselineDataset;
  /** The stored normals for this cell under `baselineVersion`. May be empty. */
  readonly normals: readonly StoredBaselineNormal[];
  /** Defaults to `CLIMATOLOGY_OUTLOOK_DERIVATION_VERSION`. */
  readonly derivationVersion?: string | undefined;
}

/** One month that may be persisted: a real value with real inputs behind it. */
export interface ClimatologyOutlookMonth {
  readonly month: string;
  readonly valueMm: number;
  readonly baselineVersion: string;
  /** The `spread_unavailable_reason` token; the spread itself is not derived here. */
  readonly spreadUnavailableReason: string;
}

export interface ClimatologyOutlookDerivation {
  readonly derivationVersion: string;
  readonly inputRefs: readonly DataInputRef[];
  readonly inputSnapshotHash: string;
  readonly baselineHash: string;
  /** Only the climatology months. Lead months 1–6 are absent by construction. */
  readonly months: readonly ClimatologyOutlookMonth[];
}

export interface ClimatologyOutlook {
  readonly horizon: MonthlyOutlookHorizon;
  /**
   * Null when the baseline holds no normal for this cell: there is nothing to
   * hash and nothing to persist, and the horizon says so per month.
   */
  readonly derivation: ClimatologyOutlookDerivation | null;
}

export type ClimatologyOutlookFailureKind = "invalid_input" | "insufficient_provenance";

export type ClimatologyOutlookOutcome =
  | { readonly ok: true; readonly value: ClimatologyOutlook }
  | {
      readonly ok: false;
      readonly kind: ClimatologyOutlookFailureKind;
      readonly message: string;
    };

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

function fail(
  kind: ClimatologyOutlookFailureKind,
  message: string,
): Extract<ClimatologyOutlookOutcome, { ok: false }> {
  return { ok: false, kind, message };
}

/** Month-of-year index 0–11 from a first-of-month key. */
function monthIndexOf(month: string): number {
  return Number(month.slice(5, 7)) - 1;
}

function noValueMonth(
  leadMonth: number,
  month: string,
  missingReason: "pending" | "insufficient_history",
): OutlookMonth {
  return {
    leadMonth,
    month,
    dataClass: null,
    evaluationBasis: "monthly",
    valueMm: null,
    missingReason,
    baselineVersion: null,
    anomalyKind: null,
    ensembleSpreadMm: null,
    spreadUnavailableReason: SPREAD_REASON_NO_VALUE,
  };
}

function climatologyMonth(
  leadMonth: number,
  month: string,
  normal: StoredBaselineNormal,
  baselineVersion: string,
): OutlookMonth {
  return {
    leadMonth,
    month,
    dataClass: "climatology",
    evaluationBasis: "climatology",
    valueMm: normal.valueMm,
    // `beyond_horizon` is the only reason that travels with a value, and the
    // database CHECK forces a climatology label to carry it.
    missingReason: "beyond_horizon",
    baselineVersion,
    anomalyKind: null,
    ensembleSpreadMm: null,
    spreadUnavailableReason: SPREAD_REASON_CLIMATOLOGY,
  };
}

/**
 * Assemble twelve labelled months and, when real inputs exist, the derivation
 * that may be persisted for lead months 7–12.
 */
export function assembleClimatologyOutlook(
  input: ClimatologyOutlookInput,
): ClimatologyOutlookOutcome {
  const derivationVersion = input.derivationVersion ?? CLIMATOLOGY_OUTLOOK_DERIVATION_VERSION;

  if (!FIRST_OF_MONTH.test(input.firstMonth)) {
    return fail("invalid_input", "firstMonth must be the first day of a calendar month");
  }
  if (input.cellKey.length === 0) {
    return fail("invalid_input", "cellKey must be non-empty");
  }
  if (input.baselineVersion.length === 0) {
    return fail("invalid_input", "baselineVersion must be non-empty");
  }
  if (derivationVersion.trim().length === 0) {
    return fail("invalid_input", "derivationVersion must be non-empty");
  }

  const byMonthOfYear = new Map<number, StoredBaselineNormal>();
  for (const normal of input.normals) {
    if (!FIRST_OF_MONTH.test(normal.month)) {
      return fail("invalid_input", `normal month "${normal.month}" is not a first-of-month key`);
    }
    if (!Number.isFinite(normal.valueMm) || normal.valueMm < 0) {
      return fail("invalid_input", `normal "${normal.month}" is not a non-negative amount`);
    }
    const index = monthIndexOf(normal.month);
    if (byMonthOfYear.has(index)) {
      return fail("invalid_input", `two normals share month-of-year ${index + 1}`);
    }
    byMonthOfYear.set(index, normal);
  }

  // A provenance hash over a normal with an unknown sample count would have to
  // invent the count. Refuse the cell instead: there is no honest hash to write.
  if (input.normals.length > 0 && input.normals.some((normal) => normal.sampleYears === null)) {
    return fail(
      "insufficient_provenance",
      "a stored normal has no sample_years; the baseline hash preimage cannot be built",
    );
  }

  const months: OutlookMonth[] = [];
  const persistable: ClimatologyOutlookMonth[] = [];
  for (let leadMonth = 1; leadMonth <= 12; leadMonth += 1) {
    let month: string;
    try {
      month = calendarMonthOf(input.firstMonth, leadMonth);
    } catch (error) {
      return fail(
        "invalid_input",
        error instanceof Error ? error.message : "firstMonth is not a usable calendar month",
      );
    }

    if (leadMonth < CLIMATOLOGY_FIRST_LEAD_MONTH) {
      months.push(noValueMonth(leadMonth, month, PENDING_OUTLOOK_REASON));
      continue;
    }

    const normal = byMonthOfYear.get(monthIndexOf(month));
    if (normal === undefined) {
      months.push(noValueMonth(leadMonth, month, MISSING_BASELINE_REASON));
      continue;
    }
    months.push(climatologyMonth(leadMonth, month, normal, input.baselineVersion));
    persistable.push({
      month,
      valueMm: normal.valueMm,
      baselineVersion: input.baselineVersion,
      spreadUnavailableReason: SPREAD_REASON_CLIMATOLOGY,
    });
  }

  const parsed = monthlyOutlookHorizonSchema.safeParse({ firstMonth: input.firstMonth, months });
  if (!parsed.success) {
    return fail(
      "invalid_input",
      `the assembled horizon is not a valid outlook: ${parsed.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const persisted = persistable;

  if (persisted.length === 0) {
    return { ok: true, value: { horizon: parsed.data, derivation: null } };
  }

  const payload = baselineNormalsPayloadSchema.safeParse({
    baselineVersion: input.baselineVersion,
    baselineDataset: input.baselineDataset,
    monthlyNormals: input.normals.map((normal) => ({
      cellKey: input.cellKey,
      month: normal.month,
      valueMm: normal.valueMm,
      sampleYears: normal.sampleYears,
    })),
  });
  if (!payload.success) {
    return fail(
      "insufficient_provenance",
      `the stored normals are not a valid baseline hash preimage: ${payload.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const baselineHash = hashBaselineNormals(payload.data);

  const ref = dataInputRefSchema.safeParse({
    kind: "baseline",
    role: "climatology",
    purpose: "input",
    baselineVersion: input.baselineVersion,
    baselineHash,
    cellKeys: [input.cellKey],
  });
  if (!ref.success) {
    return fail(
      "insufficient_provenance",
      `the baseline input ref is not valid: ${ref.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }

  const inputRefs = [ref.data];
  const inputSnapshotHash = hashDerivationDescriptor({
    artifact: "monthly_outlook",
    inputRefs,
    derivationVersion,
  });

  return {
    ok: true,
    value: {
      horizon: parsed.data,
      derivation: {
        derivationVersion,
        inputRefs,
        inputSnapshotHash,
        baselineHash,
        months: persisted,
      },
    },
  };
}
