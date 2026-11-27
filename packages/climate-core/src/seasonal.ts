import {
  dataInputRefSchema,
  hashDerivationDescriptor,
  hashSeasonalRecordSet,
  seasonalRecordSetPayloadSchema,
  type DataInputRef,
} from "@agroclimate/contracts";

/**
 * Seasonal outlook assembly — Phase 5.7D.
 *
 * Pure arithmetic and string work: no `Date`-from-the-clock, no database, no
 * network, no mutable global state. Every time-dependent input is named
 * explicitly, so the same population produces byte-identical output and hashes
 * on every machine and every retry.
 *
 * The population is **all or nothing**, per month *and* across the run window.
 * A month is assembled only when it carries exactly the 50 internal member indices
 * `0..49` this adapter exposes, each with a non-null monthly total, and the
 * derivation exists only when all six months of the run's window are present. 49
 * members, 51 members, a duplicate index, a hole, a null, a missing month, or two
 * months sharing a member identity is refused rather than averaged over the
 * remainder — a mean of "most of" an ensemble is a different product.
 *
 * `seasonal_value_mm = sum(member_monthly_total_mm) / 50`. The provider's
 * `precipitation_mean` is never an input here: it is neither a member total nor
 * run-anchored.
 *
 * This file does **not** prove that the 50 adapter columns are ECMWF's 51
 * physical members. It records the population it consumed, and nothing more.
 */

/** The store audit of 5.7D's derivation version. Bump only when the numbers change. */
export const SEASONAL_OUTLOOK_DERIVATION_VERSION = "seasonal-outlook@1.0.0";

/** The exact index set every complete month must provide. */
export const SEASONAL_REQUIRED_MEMBER_COUNT = 50;

/**
 * `spread_unavailable_reason` for a seasonal month.
 *
 * The value is an ensemble mean, but spread is deliberately not derived in 5.7D
 * (`Q-P5-SPREAD`). The column requires a reason whenever the spread is NULL.
 */
export const SPREAD_REASON_SEASONAL = "ensemble_spread_not_derived";

/** One live member-month row, as the assembler consumes it. */
export interface SeasonalMemberTotal {
  /** First day of the target calendar month, `YYYY-MM-01`. */
  readonly month: string;
  /** Zero-based internal index, exactly `0..49`. */
  readonly memberIndex: number;
  /** The member's complete monthly total in mm. */
  readonly valueMm: number;
}

export interface SeasonalOutlookInput {
  /** The ForecastRun's `initialized_at`, UTC ISO instant. */
  readonly initializedAt: string;
  readonly cellKey: string;
  readonly forecastRunId: string;
  readonly ingestionRunId: string;
  /** Complete member-months only. A partial month is refused, not skipped. */
  readonly members: readonly SeasonalMemberTotal[];
  /** Defaults to `SEASONAL_OUTLOOK_DERIVATION_VERSION`. */
  readonly derivationVersion?: string | undefined;
}

export interface SeasonalOutlookMonth {
  readonly month: string;
  readonly valueMm: number;
  readonly spreadUnavailableReason: string;
}

export interface SeasonalOutlookDerivation {
  readonly derivationVersion: string;
  readonly inputRefs: readonly DataInputRef[];
  readonly inputSnapshotHash: string;
  readonly recordSetHash: string;
  /** Only the fully populated months, in calendar order. */
  readonly months: readonly SeasonalOutlookMonth[];
}

export type SeasonalOutlookFailureKind =
  "invalid_input" | "incomplete_population" | "insufficient_provenance";

export type SeasonalOutlookOutcome =
  | { readonly ok: true; readonly value: SeasonalOutlookDerivation }
  | {
      readonly ok: false;
      readonly kind: SeasonalOutlookFailureKind;
      readonly message: string;
    };

const FIRST_OF_MONTH = /^\d{4}-\d{2}-01$/;

function fail(
  kind: SeasonalOutlookFailureKind,
  message: string,
): Extract<SeasonalOutlookOutcome, { ok: false }> {
  return { ok: false, kind, message };
}

/** First-of-month key `offset` months after `month`; pure integer arithmetic. */
function monthAfter(month: string, offset: number): string {
  const year = Number(month.slice(0, 4));
  const monthOfYear = Number(month.slice(5, 7));
  const total = year * 12 + (monthOfYear - 1) + offset;
  return `${String(Math.floor(total / 12)).padStart(4, "0")}-${String((total % 12) + 1).padStart(2, "0")}-01`;
}

/** The UTC month of an instant, first-of-month. */
function utcMonthOfInstant(instant: string): string | null {
  if (!instant.endsWith("Z")) return null;
  const parsed = new Date(instant);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(0, 7)}-01`;
}

/**
 * The six calendar months one SEAS5 run fills, first-of-month, in order.
 *
 * Exported because the persistence layer must read exactly the months this
 * assembler will accept: two independent computations of the window would drift.
 * `null` means the instant is not a UTC ISO instant.
 */
export function seasonalOutlookMonths(initializedAt: string): readonly string[] | null {
  const initializedMonth = utcMonthOfInstant(initializedAt);
  if (initializedMonth === null) return null;
  return Array.from({ length: 6 }, (_unused, index) => monthAfter(initializedMonth, index + 1));
}

export function assembleSeasonalOutlook(input: SeasonalOutlookInput): SeasonalOutlookOutcome {
  const derivationVersion = input.derivationVersion ?? SEASONAL_OUTLOOK_DERIVATION_VERSION;

  if (input.cellKey.length === 0) return fail("invalid_input", "cellKey must be non-empty");
  if (input.forecastRunId.length === 0) {
    return fail("invalid_input", "forecastRunId must be non-empty");
  }
  if (input.ingestionRunId.length === 0) {
    return fail("invalid_input", "ingestionRunId must be non-empty");
  }
  if (derivationVersion.trim().length === 0) {
    return fail("invalid_input", "derivationVersion must be non-empty");
  }

  const expectedMonths = seasonalOutlookMonths(input.initializedAt);
  if (expectedMonths === null) {
    return fail("invalid_input", "initializedAt must be a UTC ISO instant");
  }
  const expected = new Set(expectedMonths);

  const byMonth = new Map<string, Map<number, number>>();
  for (const member of input.members) {
    if (!FIRST_OF_MONTH.test(member.month)) {
      return fail("invalid_input", `member month "${member.month}" is not a first-of-month key`);
    }
    if (!expected.has(member.month)) {
      return fail(
        "invalid_input",
        `member month "${member.month}" is outside the run window ${expectedMonths.join(", ")}`,
      );
    }
    if (
      !Number.isInteger(member.memberIndex) ||
      member.memberIndex < 0 ||
      member.memberIndex >= SEASONAL_REQUIRED_MEMBER_COUNT
    ) {
      return fail(
        "invalid_input",
        `member index ${member.memberIndex} is outside 0..${SEASONAL_REQUIRED_MEMBER_COUNT - 1}`,
      );
    }
    if (!Number.isFinite(member.valueMm) || member.valueMm < 0) {
      return fail(
        "invalid_input",
        `member ${member.memberIndex} of ${member.month} is not a finite non-negative total`,
      );
    }

    let month = byMonth.get(member.month);
    if (month === undefined) {
      month = new Map();
      byMonth.set(member.month, month);
    }
    if (month.has(member.memberIndex)) {
      return fail(
        "incomplete_population",
        `member ${member.memberIndex} appears twice for ${member.month}`,
      );
    }
    month.set(member.memberIndex, member.valueMm);
  }

  if (byMonth.size === 0) {
    return fail("incomplete_population", "no member-month was supplied");
  }

  // Every supplied month must be complete. A partial month is a caller bug, not a
  // month to average over the members it happens to have.
  for (const [month, members] of byMonth) {
    if (members.size !== SEASONAL_REQUIRED_MEMBER_COUNT) {
      return fail(
        "incomplete_population",
        `month "${month}" carries ${members.size} members; exactly ${SEASONAL_REQUIRED_MEMBER_COUNT} are required`,
      );
    }
    for (let index = 0; index < SEASONAL_REQUIRED_MEMBER_COUNT; index += 1) {
      if (!members.has(index)) {
        return fail(
          "incomplete_population",
          `month "${month}" is missing member index ${index}; the set must be exactly 0..${SEASONAL_REQUIRED_MEMBER_COUNT - 1}`,
        );
      }
    }
  }

  const months: SeasonalOutlookMonth[] = [];
  const consumed: { month: string; memberIndex: number; valueMm: number }[] = [];
  const memberCountByMonth: { month: string; memberCount: number }[] = [];

  for (const month of expectedMonths) {
    const members = byMonth.get(month);
    if (members === undefined) {
      // All or nothing: one run's window is written whole or not at all. A month
      // filled from a different run's ingest would make the record-set hash
      // describe a population that never existed.
      return fail(
        "incomplete_population",
        `month "${month}" of the run window carries no member rows; the window ${expectedMonths.join(", ")} must be complete`,
      );
    }

    let sum = 0;
    for (const value of members.values()) sum += value;
    months.push({
      month,
      valueMm: sum / SEASONAL_REQUIRED_MEMBER_COUNT,
      spreadUnavailableReason: SPREAD_REASON_SEASONAL,
    });
    memberCountByMonth.push({ month, memberCount: members.size });
    for (const [memberIndex, valueMm] of members) {
      consumed.push({ month, memberIndex, valueMm });
    }
  }

  // Canonical order is a property of the producer, never of the caller's array:
  // a reordered population must hash identically.
  consumed.sort((left, right) =>
    left.month === right.month
      ? left.memberIndex - right.memberIndex
      : left.month < right.month
        ? -1
        : 1,
  );

  const recordSet = seasonalRecordSetPayloadSchema.safeParse({
    artifact: "seasonal_outlook_population",
    forecastRunId: input.forecastRunId,
    ingestionRunId: input.ingestionRunId,
    cellKey: input.cellKey,
    memberCountByMonth,
    members: consumed,
  });
  if (!recordSet.success) {
    return fail(
      "insufficient_provenance",
      `the consumed population is not a valid record-set preimage: ${recordSet.error.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
  }
  const recordSetHash = hashSeasonalRecordSet(recordSet.data);

  const ref = dataInputRefSchema.safeParse({
    kind: "forecast",
    role: "seasonal",
    purpose: "input",
    forecastRunIds: [input.forecastRunId],
    ingestionRunIds: [input.ingestionRunId],
    recordSetHash,
  });
  if (!ref.success) {
    return fail(
      "insufficient_provenance",
      `the forecast input ref is not valid: ${ref.error.issues.map((issue) => issue.message).join("; ")}`,
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
    value: { derivationVersion, inputRefs, inputSnapshotHash, recordSetHash, months },
  };
}
