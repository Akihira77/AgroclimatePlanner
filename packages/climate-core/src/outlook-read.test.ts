import { describe, expect, it } from "vitest";
import { estimatorForDataClass, weatherDataClassSchema } from "@agroclimate/contracts";

import {
  assembleOutlookHorizon,
  PENDING_OUTLOOK_REASON,
  type StoredOutlookMonth,
} from "./outlook-read.js";

const FIRST_MONTH = "2026-11-01";
/** One fixed instant: freshness is compared against the run's release boundary. */
const NOW = "2026-11-20T00:00:00.000Z";

function climatologyRow(month: string, valueMm = 210.5): StoredOutlookMonth {
  return {
    month,
    dataClass: "climatology",
    evaluationBasis: "climatology",
    valueMm,
    missingReason: "beyond_horizon",
    baselineVersion: "era5-1991-2020-v1",
    anomalyKind: null,
    anomalyMm: null,
    ensembleSpreadMm: null,
    spreadUnavailableReason: "climatology_has_no_ensemble",
    derivationVersion: "climatology-outlook@1.0.0",
    initializedAt: null,
  };
}

function assembled(months: readonly StoredOutlookMonth[], firstMonth = FIRST_MONTH, now = NOW) {
  const outcome = assembleOutlookHorizon({ firstMonth, rows: months, now });
  if (!outcome.ok) throw new Error(`${outcome.kind}: ${outcome.message}`);
  return outcome.value.months;
}

describe("assembleOutlookHorizon — twelve months, no invention", () => {
  it("serves twelve entries with no value when nothing is stored", () => {
    const months = assembled([]);

    expect(months).toHaveLength(12);
    expect(months.map((month) => month.leadMonth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(months.every((month) => month.valueMm === null)).toBe(true);
    expect(months.every((month) => month.dataClass === null)).toBe(true);
    expect(months.every((month) => month.estimator === null)).toBe(true);
    expect(months.every((month) => month.derivationVersion === null)).toBe(true);
    // No zero. A zero is a measurement; absence is not.
    expect(months.some((month) => month.valueMm === 0)).toBe(false);
  });

  it("labels every month without a row pending", () => {
    // Every lead month 1–12 has an approved source after 5.7D, so "nothing was
    // requested" is no longer true of any of them.
    const months = assembled([]);

    expect(months.map((month) => month.missingReason)).toEqual(
      Array.from({ length: 12 }, () => PENDING_OUTLOOK_REASON),
    );
  });

  it("binds each lead month to its calendar month, across a year boundary", () => {
    const months = assembled([], FIRST_MONTH);

    expect(months[0]?.month).toBe("2026-11-01");
    expect(months[1]?.month).toBe("2026-12-01");
    expect(months[2]?.month).toBe("2027-01-01");
    expect(months[11]?.month).toBe("2027-10-01");
  });

  it("passes a stored climatology row through unchanged, labelled climatological_mean", () => {
    // Lead month 8 is the first month the climatology band permits.
    const months = assembled([climatologyRow("2027-06-01")]);
    const june = months[7];

    expect(june).toMatchObject({
      leadMonth: 8,
      month: "2027-06-01",
      dataClass: "climatology",
      evaluationBasis: "climatology",
      valueMm: 210.5,
      estimator: "climatological_mean",
      baselineVersion: "era5-1991-2020-v1",
      anomalyKind: null,
      ensembleSpreadMm: null,
      spreadUnavailableReason: "climatology_has_no_ensemble",
      unit: "mm",
      derivationVersion: "climatology-outlook@1.0.0",
    });
  });

  it("labels a stored seasonal row ensemble_mean and dates its freshness", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2026-12-01", 297.6),
      dataClass: "seasonal_forecast",
      evaluationBasis: "monthly",
      missingReason: null,
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
      derivationVersion: "seasonal-outlook@1.0.0",
      initializedAt: "2026-11-01T00:00:00.000Z",
    };

    const december = assembled([row])[1];

    expect(december).toMatchObject({
      dataClass: "seasonal_forecast",
      evaluationBasis: "monthly",
      valueMm: 297.6,
      estimator: "ensemble_mean",
      baselineVersion: null,
      derivationVersion: "seasonal-outlook@1.0.0",
      availability: "fresh",
    });
  });

  it("labels the same seasonal row stale past the run's next release, value unchanged", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2026-12-01", 297.6),
      dataClass: "seasonal_forecast",
      evaluationBasis: "monthly",
      missingReason: null,
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
      derivationVersion: "seasonal-outlook@1.0.0",
      initializedAt: "2026-11-01T00:00:00.000Z",
    };

    // Boundary is 2026-12-05T12:00Z: the 5th, 12Z, of the month after init.
    const before = assembled([row], FIRST_MONTH, "2026-12-05T11:59:59.999Z")[1];
    const after = assembled([row], FIRST_MONTH, "2026-12-05T12:00:00.000Z")[1];

    expect(before).toMatchObject({ availability: "fresh", valueMm: 297.6 });
    expect(after).toMatchObject({ availability: "stale", valueMm: 297.6 });
  });

  it("gives a climatology month no availability at all", () => {
    expect(assembled([climatologyRow("2027-06-01")])[7]?.availability).toBeNull();
  });

  it("refuses a seasonal row with no run to date it", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2026-12-01", 297.6),
      dataClass: "seasonal_forecast",
      evaluationBasis: "monthly",
      missingReason: null,
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
      derivationVersion: "seasonal-outlook@1.0.0",
      initializedAt: null,
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && /no forecast run to date it/.test(outcome.message)).toBe(true);
  });

  it("serves a stored absence as the absence it records", () => {
    // A row may hold no value; the read passes its reason through instead of
    // inventing a number or attributing a derivation to the gap.
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      dataClass: null,
      evaluationBasis: "monthly",
      valueMm: null,
      missingReason: "pending",
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
    };

    const june = assembled([row])[7];

    expect(june).toMatchObject({
      leadMonth: 8,
      month: "2027-06-01",
      dataClass: null,
      valueMm: null,
      missingReason: "pending",
      estimator: null,
      derivationVersion: null,
      unit: "mm",
    });
  });

  it("refuses a stored month with a class and no value", () => {
    // Coercing this to an absence would serve an unlabelled month for a row that
    // names a class. The row is contradictory, so nothing honest can be rendered.
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      dataClass: "seasonal_forecast",
      evaluationBasis: "monthly",
      valueMm: null,
      missingReason: "no_value",
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
    expect(outcome.ok === false && /a data class and no value/.test(outcome.message)).toBe(true);
  });

  it("refuses a stored month with a value and no data class", () => {
    // Coercing this to an absence would drop a measured number; coercing it to a
    // forecast would invent the class. Both are worse than refusing it.
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      dataClass: null,
      evaluationBasis: "monthly",
      valueMm: 120.5,
      missingReason: null,
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
    expect(outcome.ok === false && /a value and no data class/.test(outcome.message)).toBe(true);
  });

  it("refuses a stored absence that carries an anomaly", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      dataClass: null,
      evaluationBasis: "monthly",
      valueMm: null,
      missingReason: "pending",
      baselineVersion: null,
      anomalyKind: "model_anomaly",
      spreadUnavailableReason: "no_value",
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
  });

  it("refuses a stored absence that names no reason", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      dataClass: null,
      evaluationBasis: "monthly",
      valueMm: null,
      missingReason: null,
      baselineVersion: null,
      spreadUnavailableReason: "no_value",
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
  });

  it("keeps a month with a missing baseline at no value rather than zero", () => {
    // Leads 8 and 12 are stored; leads 9–11 are not, and none of them is zero.
    const months = assembled([climatologyRow("2027-06-01"), climatologyRow("2027-10-01")]);
    const unanswered = months[8];

    expect(unanswered?.valueMm).toBeNull();
    expect(unanswered?.dataClass).toBeNull();
    expect(unanswered?.missingReason).toBe(PENDING_OUTLOOK_REASON);
  });

  it("keeps the twelve-month axis when absences and real months are mixed", () => {
    const months = assembled([
      climatologyRow("2027-06-01", 101),
      {
        ...climatologyRow("2027-08-01"),
        dataClass: null,
        evaluationBasis: "monthly",
        valueMm: null,
        missingReason: "pending",
        baselineVersion: null,
        spreadUnavailableReason: "no_value",
      },
      climatologyRow("2027-10-01", 303),
    ]);

    expect(months).toHaveLength(12);
    expect(months.map((month) => month.leadMonth)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(months.map((month) => month.valueMm)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      101,
      null,
      null,
      null,
      303,
    ]);
    expect(months.map((month) => month.estimator)).toEqual([
      null,
      null,
      null,
      null,
      null,
      null,
      null,
      "climatological_mean",
      null,
      null,
      null,
      "climatological_mean",
    ]);
  });
});

describe("assembleOutlookHorizon — refusals", () => {
  it("refuses a firstMonth that is not the first of a calendar month", () => {
    const outcome = assembleOutlookHorizon({ firstMonth: "2026-11-15", rows: [], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("invalid_input");
  });

  it("refuses two active rows for one month", () => {
    const outcome = assembleOutlookHorizon({
      firstMonth: FIRST_MONTH,
      rows: [climatologyRow("2026-11-01"), climatologyRow("2026-11-01", 200)],
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
  });

  it("refuses a row outside the requested horizon", () => {
    const outcome = assembleOutlookHorizon({
      firstMonth: FIRST_MONTH,
      rows: [climatologyRow("2028-01-01")],
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && /outside the requested horizon/.test(outcome.message)).toBe(
      true,
    );
  });

  it("refuses a class with no approved monthly estimator", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2026-11-01"),
      dataClass: "reanalysis",
      evaluationBasis: "monthly",
      missingReason: null,
      baselineVersion: null,
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && /no approved monthly estimator/.test(outcome.message)).toBe(
      true,
    );
  });

  it("refuses a value carrying a no-value reason", () => {
    const row: StoredOutlookMonth = {
      ...climatologyRow("2027-06-01"),
      missingReason: "pending",
    };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
  });

  it("refuses a climatology month claiming the monthly basis", () => {
    const row: StoredOutlookMonth = { ...climatologyRow("2027-06-01"), evaluationBasis: "monthly" };

    const outcome = assembleOutlookHorizon({ firstMonth: FIRST_MONTH, rows: [row], now: NOW });

    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("inconsistent_row");
  });

  it("refuses a negative value rather than clamping it", () => {
    const outcome = assembleOutlookHorizon({
      firstMonth: FIRST_MONTH,
      rows: [climatologyRow("2027-06-01", -1)],
      now: NOW,
    });

    expect(outcome.ok).toBe(false);
  });
});

describe("estimatorForDataClass", () => {
  it("maps the two approved classes and nothing else", () => {
    expect(estimatorForDataClass("seasonal_forecast")).toBe("ensemble_mean");
    expect(estimatorForDataClass("climatology")).toBe("climatological_mean");
    expect(estimatorForDataClass(null)).toBeNull();

    const unapproved = weatherDataClassSchema.options.filter(
      (dataClass) => dataClass !== "seasonal_forecast" && dataClass !== "climatology",
    );
    expect(unapproved.length).toBeGreaterThan(0);
    for (const dataClass of unapproved) {
      expect(estimatorForDataClass(dataClass)).toBeNull();
    }
  });
});
