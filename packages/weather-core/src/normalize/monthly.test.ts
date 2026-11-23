import { describe, expect, it } from "vitest";
import type { Seas5MonthlyPayload } from "../adapters/open-meteo-seasonal.js";
import type { DailyProviderPayload } from "../adapters/open-meteo-daily.js";
import {
  MONTHLY_MEMBER_AGGREGATION_VERSION,
  MONTHLY_NORMALIZER_VERSION,
  aggregateMonthlyMemberTotals,
  normalizeMonthlySeries,
  type NormalizedMonthlySeries,
} from "./monthly.js";

/**
 * Payloads here are **synthetic** — shaped like the adapter's output, not a
 * recording of a live provider response. What is reproduced is the pinned
 * evidence: `precipitation_mean` in `mm`, seven first-of-month rows.
 */
const SEVEN = [
  { month: "2026-11-01", value: 247.6 },
  { month: "2026-12-01", value: 336.4 },
  { month: "2027-01-01", value: 367.6 },
  { month: "2027-02-01", value: 335.7 },
  { month: "2027-03-01", value: 340.3 },
  { month: "2027-04-01", value: 332.8 },
  { month: "2027-05-01", value: 225.1 },
];

const PAYLOAD: Seas5MonthlyPayload = {
  provider: "open-meteo",
  model: "ecmwf_seas5",
  product: "seasonal",
  variable: "precipitation_mean",
  unit: "mm",
  adapterVersion: "open-meteo-seasonal-seas5@1.0.0",
  initializedAt: "2026-11-01T00:00:00Z",
  initializedAtSource: "request_configuration",
  attribution: "ECMWF / Open-Meteo, CC BY 4.0",
  requestedLatitude: -6.2,
  requestedLongitude: 106.8,
  servedLatitude: -6.125,
  servedLongitude: 106.875,
  sourceUrl: "https://seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_seas5",
  receivedAt: "2026-11-21T00:00:00.000Z",
  rawPayloadRef: null,
  months: SEVEN,
};

const withMonths = (months: Seas5MonthlyPayload["months"]): Seas5MonthlyPayload => ({
  ...PAYLOAD,
  months,
});

function normalized(value: NormalizedMonthlySeries | { ok: false }): NormalizedMonthlySeries {
  if ("ok" in value && value.ok === false) throw new Error("expected a normalized series");
  return value as NormalizedMonthlySeries;
}

describe("monthly normalizer", () => {
  it("keeps the provider's quantity, unit, and value untouched", () => {
    const series = normalized(normalizeMonthlySeries(PAYLOAD));
    expect(series.quantity).toBe("precipitation_mean");
    expect(series.nativeUnit).toBe("mm");
    expect(series.months[0]).toEqual({
      month: "2026-11-01",
      nativeValue: 247.6,
      missingReason: null,
    });
    expect(series.presentMonths).toBe(7);
    expect(series.nullMonths).toBe(0);
  });

  it("never invents valueMm or a monthly total", () => {
    const series = normalized(normalizeMonthlySeries(PAYLOAD));
    expect("valueMm" in series).toBe(false);
    // The sum is computable but would be a fabricated quantity; nothing stores it.
    const sum = series.months.reduce((total, month) => total + (month.nativeValue ?? 0), 0);
    expect(sum).toBeGreaterThan(0);
    expect(Object.keys(series)).not.toContain("valueMm");
  });

  it("refuses a unit with no approved conversion", () => {
    const outcome = normalizeMonthlySeries({ ...PAYLOAD, unit: "kg m-2 s-1" });
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) {
      expect(outcome.kind).toBe("unsupported_unit");
      expect(outcome.message).toContain("kg m-2 s-1");
    }
  });

  it("keeps null as null with a reason, never zero", () => {
    const series = normalized(
      normalizeMonthlySeries(
        withMonths([
          { month: "2026-11-01", value: 247.6 },
          { month: "2026-12-01", value: null },
        ]),
      ),
    );
    expect(series.months[1]).toEqual({
      month: "2026-12-01",
      nativeValue: null,
      missingReason: "provider_null",
    });
    expect(series.presentMonths).toBe(1);
    expect(series.nullMonths).toBe(1);
  });

  it("refuses a negative or non-finite precipitation amount", () => {
    for (const value of [-0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const outcome = normalizeMonthlySeries(withMonths([{ month: "2026-11-01", value }]));
      expect("ok" in outcome && outcome.ok === false).toBe(true);
      if ("ok" in outcome && outcome.ok === false) expect(outcome.kind).toBe("invalid_payload");
    }
  });

  it("refuses an empty series", () => {
    const outcome = normalizeMonthlySeries(withMonths([]));
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) expect(outcome.kind).toBe("invalid_payload");
  });

  it("refuses a month that is not the first of the month", () => {
    const outcome = normalizeMonthlySeries(
      withMonths([
        { month: "2026-11-15", value: 1 },
        { month: "2026-12-01", value: 2 },
      ]),
    );
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) expect(outcome.kind).toBe("invalid_payload");
  });

  it("refuses a duplicate or out-of-order month", () => {
    const duplicate = normalizeMonthlySeries(
      withMonths([
        { month: "2026-11-01", value: 1 },
        { month: "2026-11-01", value: 2 },
      ]),
    );
    expect("ok" in duplicate && duplicate.ok === false).toBe(true);

    const reversed = normalizeMonthlySeries(
      withMonths([
        { month: "2026-12-01", value: 2 },
        { month: "2026-11-01", value: 1 },
      ]),
    );
    expect("ok" in reversed && reversed.ok === false).toBe(true);
  });

  it("accepts a series that crosses the year boundary", () => {
    const series = normalized(
      normalizeMonthlySeries(
        withMonths([
          { month: "2026-12-01", value: 300 },
          { month: "2027-01-01", value: 310 },
          { month: "2027-02-01", value: 320 },
        ]),
      ),
    );
    expect(series.months.map((month) => month.month)).toEqual([
      "2026-12-01",
      "2027-01-01",
      "2027-02-01",
    ]);
  });

  it("rejects a series with a missing calendar month", () => {
    // Ordered, plausible, and wrong: January never arrives.
    const outcome = normalizeMonthlySeries(
      withMonths([
        { month: "2026-11-01", value: 1 },
        { month: "2026-12-01", value: 2 },
        { month: "2027-02-01", value: 3 },
      ]),
    );
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) {
      expect(outcome.kind).toBe("invalid_payload");
      expect(outcome.message).toContain("months[2]");
      expect(outcome.message).toContain("2027-02-01");
      expect(outcome.message).toContain("2026-12-01");
    }
  });

  it("rejects a gap immediately after December", () => {
    const outcome = normalizeMonthlySeries(
      withMonths([
        { month: "2026-11-01", value: 1 },
        { month: "2026-12-01", value: 2 },
        { month: "2027-02-01", value: 3 },
      ]),
    );
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) expect(outcome.kind).toBe("invalid_payload");
  });

  it("rejects seven months that skip one", () => {
    const outcome = normalizeMonthlySeries(
      withMonths([
        { month: "2026-12-01", value: 1 },
        { month: "2027-01-01", value: 2 },
        { month: "2027-03-01", value: 3 },
        { month: "2027-04-01", value: 4 },
        { month: "2027-05-01", value: 5 },
        { month: "2027-06-01", value: 6 },
        { month: "2027-07-01", value: 7 },
      ]),
    );
    expect("ok" in outcome && outcome.ok === false).toBe(true);
    if ("ok" in outcome && outcome.ok === false) expect(outcome.kind).toBe("invalid_payload");
  });

  it("is deterministic and ordered for equal input", () => {
    const first = normalized(normalizeMonthlySeries(PAYLOAD));
    const second = normalized(normalizeMonthlySeries(PAYLOAD));
    expect(first).toEqual(second);
    expect(first.months.map((month) => month.month)).toEqual(SEVEN.map((month) => month.month));
  });

  it("preserves provenance and refuses to claim reproducibility", () => {
    const series = normalized(normalizeMonthlySeries(PAYLOAD));
    expect(series.provider).toBe("open-meteo");
    expect(series.model).toBe("ecmwf_seas5");
    expect(series.adapterVersion).toBe(PAYLOAD.adapterVersion);
    expect(series.normalizerVersion).toBe(MONTHLY_NORMALIZER_VERSION);
    expect(series.initializedAt).toBe(PAYLOAD.initializedAt);
    expect(series.initializedAtSource).toBe("request_configuration");
    expect(series.attribution).toBe(PAYLOAD.attribution);
    expect(series.requestedLatitude).toBe(-6.2);
    expect(series.servedLatitude).toBe(-6.125);
    expect(series.rawPayloadRef).toBeNull();
    expect(series.reproducibility).toEqual({
      reproducible: false,
      reason: "raw_payload_not_retained",
    });
  });

  it("freezes the output so a caller cannot mutate a canonical month", () => {
    const series = normalized(normalizeMonthlySeries(PAYLOAD));
    expect(Object.isFrozen(series)).toBe(true);
    expect(Object.isFrozen(series.months)).toBe(true);
  });
});

/* ------------------------------------------------------------------ *
 * SEAS5 per-member monthly aggregation — ADR-001 D8b
 * ------------------------------------------------------------------ */

const DAY_MS = 86_400_000;

/**
 * Daily member values, shaped like `fetchSeas5MemberDaily`. `value(member,
 * date)` decides each day; a null is a provider null.
 */
function memberPayload(
  options: {
    firstDay?: string;
    monthLengths?: readonly number[];
    members?: readonly number[];
    value?: (member: number, date: string) => number | null;
    unit?: string;
    dropDays?: number;
  } = {},
): DailyProviderPayload {
  const members = options.members ?? Array.from({ length: 50 }, (_, index) => index);
  const dates: string[] = [];
  let cursor = Date.parse(`${options.firstDay ?? "2027-01-01"}T00:00:00.000Z`);
  for (const length of options.monthLengths ?? [31, 28]) {
    for (let index = 0; index < length; index += 1) {
      dates.push(new Date(cursor + index * DAY_MS).toISOString().slice(0, 10));
    }
    const next = new Date(cursor);
    next.setUTCMonth(next.getUTCMonth() + 1);
    cursor = next.getTime();
  }
  const kept =
    options.dropDays === undefined ? dates : dates.slice(0, dates.length - options.dropDays);
  const days = members.flatMap((member) =>
    kept.map((date) => ({
      date,
      member,
      value: options.value ? options.value(member, date) : 1,
    })),
  );
  return {
    provider: "open-meteo",
    model: "ecmwf_seas5",
    product: "seasonal",
    variable: "precipitation_sum",
    unit: options.unit ?? "mm",
    adapterVersion: "open-meteo-seasonal-seas5-member@1.0.0",
    attribution: "ECMWF / Open-Meteo, CC BY 4.0",
    requestedLatitude: -6.2,
    requestedLongitude: 106.8,
    servedLatitude: -6.125,
    servedLongitude: 106.875,
    sourceUrl: "https://seasonal-api.open-meteo.com/v1/seasonal?models=ecmwf_seas5",
    receivedAt: "2026-11-23T00:00:00.000Z",
    rawPayloadRef: null,
    ensembleSize: members.length,
    days,
  };
}

function aggregated(value: ReturnType<typeof aggregateMonthlyMemberTotals>) {
  if (!value.ok) throw new Error(`expected an aggregate series, got: ${value.message}`);
  return value.value;
}

describe("SEAS5 per-member monthly aggregation", () => {
  it("sums each member over every day of its calendar month, not 30-day blocks", () => {
    const series = aggregated(aggregateMonthlyMemberTotals(memberPayload(), "-6.00,106.00"));

    expect(series.aggregationVersion).toBe(MONTHLY_MEMBER_AGGREGATION_VERSION);
    expect(series.months).toEqual(["2027-01-01", "2027-02-01"]);
    expect(series.ensembleSize).toBe(50);
    // 50 members × 2 months
    expect(series.values).toHaveLength(100);

    const january = series.values.filter((value) => value.validAt === "2027-01-01T00:00:00.000Z");
    const february = series.values.filter((value) => value.validAt === "2027-02-01T00:00:00.000Z");
    expect(january).toHaveLength(50);
    expect(february).toHaveLength(50);
    expect(january.every((value) => value.value === 31)).toBe(true);
    expect(february.every((value) => value.value === 28)).toBe(true);
  });

  it("keeps member identity, size and provenance fields on every row", () => {
    const series = aggregated(
      aggregateMonthlyMemberTotals(
        memberPayload({ value: (member) => member / 10 }),
        "-6.00,106.00",
      ),
    );
    const january = series.values.filter((value) => value.validAt === "2027-01-01T00:00:00.000Z");

    expect(january.map((value) => value.ensembleMember)).toEqual(
      Array.from({ length: 50 }, (_, index) => index),
    );
    expect(january.every((value) => value.ensembleSize === 50)).toBe(true);
    expect(january.every((value) => value.variable === "precipitation_sum")).toBe(true);
    expect(january.every((value) => value.unit === "mm")).toBe(true);
    expect(january.every((value) => value.temporalResolution === "monthly")).toBe(true);
    expect(january.every((value) => value.aggregationLevel === "monthly_sum")).toBe(true);
    expect(january.every((value) => value.cellKey === "-6.00,106.00")).toBe(true);
    // Member 7 at 0.7 mm/day over 31 days.
    expect(january[7]?.value).toBeCloseTo(21.7, 10);
  });

  it("nulls only the member-month with a missing day, never zero-filling it", () => {
    const series = aggregated(
      aggregateMonthlyMemberTotals(
        memberPayload({
          value: (member, date) => (member === 3 && date === "2027-01-17" ? null : 2),
        }),
        "-6.00,106.00",
      ),
    );

    const broken = series.values.find(
      (value) => value.ensembleMember === 3 && value.validAt === "2027-01-01T00:00:00.000Z",
    );
    expect(broken?.value).toBeNull();

    const intact = series.values.filter(
      (value) => value.validAt === "2027-01-01T00:00:00.000Z" && value.ensembleMember !== 3,
    );
    expect(intact).toHaveLength(49);
    expect(intact.every((value) => value.value === 62)).toBe(true);

    // A different month for the same member is unaffected.
    const february = series.values.find(
      (value) => value.ensembleMember === 3 && value.validAt === "2027-02-01T00:00:00.000Z",
    );
    expect(february?.value).toBe(56);
  });

  it("refuses a month whose axis does not cover every day", () => {
    const series = aggregated(aggregateMonthlyMemberTotals(memberPayload({ dropDays: 1 }), "c"));
    const january = series.values.filter((value) => value.validAt === "2027-01-01T00:00:00.000Z");
    // The dropped day is the last of February, so January is untouched and
    // February is incomplete for every member — and stays null.
    expect(january.every((value) => value.value === 31)).toBe(true);
    const february = series.values.filter((value) => value.validAt === "2027-02-01T00:00:00.000Z");
    expect(february).toHaveLength(50);
    expect(february.every((value) => value.value === null)).toBe(true);
  });

  it("refuses a duplicate day rather than summing it twice", () => {
    const payload = memberPayload();
    const doubled = {
      ...payload,
      days: [...payload.days, { date: "2027-01-01", member: 0, value: 5 }],
    } as DailyProviderPayload;
    const outcome = aggregateMonthlyMemberTotals(doubled, "c");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("repeats");
  });

  it("refuses an impossible calendar day", () => {
    const payload = memberPayload();
    const broken = {
      ...payload,
      days: payload.days.map((day) =>
        day.member === 0 && day.date === "2027-02-28" ? { ...day, date: "2027-02-30" } : day,
      ),
    } as DailyProviderPayload;
    const outcome = aggregateMonthlyMemberTotals(broken, "c");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("not a calendar day");
  });

  it("refuses a non-mm unit, a negative amount, and a null member", () => {
    const inches = aggregateMonthlyMemberTotals(memberPayload({ unit: "inch" }), "c");
    expect(inches.ok).toBe(false);
    if (!inches.ok) expect(inches.kind).toBe("unsupported_unit");

    const negative = aggregateMonthlyMemberTotals(
      memberPayload({ value: (member) => (member === 1 ? -0.1 : 1) }),
      "c",
    );
    expect(negative.ok).toBe(false);
    if (!negative.ok) expect(negative.kind).toBe("invalid_payload");

    const deterministic = memberPayload();
    const nullMember = {
      ...deterministic,
      days: deterministic.days.map((day) => (day.member === 0 ? { ...day, member: null } : day)),
    } as DailyProviderPayload;
    const outcome = aggregateMonthlyMemberTotals(nullMember, "c");
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.message).toContain("deterministic");
  });
});
