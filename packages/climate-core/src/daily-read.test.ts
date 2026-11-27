import { describe, expect, it } from "vitest";

import { addCalendarDays } from "@agroclimate/contracts";

import {
  assembleDailyHorizon,
  dailyHorizonWindow,
  jakartaDateOfInstant,
  type DailyRecordRow,
} from "./daily-read.js";

const FIRST_DATE = "2026-11-27";
const NOW = "2026-11-27T06:00:00.000Z";

/** A deterministic daily row at the start of a lead day, in Jakarta. */
function row(
  leadDay: number,
  value: number | null,
  overrides: Partial<DailyRecordRow> = {},
): DailyRecordRow {
  return {
    // 00:00 Asia/Jakarta is 17:00Z on the previous printed day.
    validAt: `${addCalendarDays(FIRST_DATE, leadDay - 1)}T17:00:00.000Z`,
    value,
    unit: "mm",
    dataClass: leadDay <= 14 ? "weather_forecast" : "subseasonal_forecast",
    provider: "open-meteo",
    model: leadDay <= 14 ? "ecmwf_ifs025" : "ecmwf_ec46",
    initializedAt: "2026-11-27T00:00:00.000Z",
    temporalResolution: "daily",
    aggregationLevel: "daily_sum",
    ensembleMember: null,
    ...overrides,
  };
}

function assembled(rows: readonly DailyRecordRow[], now = NOW) {
  const outcome = assembleDailyHorizon({
    firstDate: FIRST_DATE,
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    rows,
    now,
  });
  if (!outcome.ok) throw new Error(`${outcome.kind}: ${outcome.message}`);
  return outcome.value.segments;
}

describe("jakartaDateOfInstant and the query window", () => {
  it("rolls a UTC instant into the Jakarta day it belongs to", () => {
    expect(jakartaDateOfInstant("2026-11-26T17:00:00.000Z")).toBe("2026-11-27");
    expect(jakartaDateOfInstant("2026-11-26T16:59:59.000Z")).toBe("2026-11-26");
    expect(jakartaDateOfInstant("2026-11-27T00:00:00.000Z")).toBe("2026-11-27");
  });

  it("covers lead days 0–45 as a half-open window", () => {
    const window = dailyHorizonWindow(FIRST_DATE);

    expect(window.from).toBe("2026-11-26T17:00:00.000Z");
    expect(window.to).toBe("2027-01-11T17:00:00.000Z");
  });
});

describe("assembleDailyHorizon — dense, ordered, no invention", () => {
  it("serves both segments with no value when nothing is stored", () => {
    const segments = assembled([]);

    expect(segments.map((segment) => segment.band)).toEqual(["daily", "subseasonal"]);
    expect(segments[0]!.days).toHaveLength(15);
    expect(segments[1]!.days).toHaveLength(31);
    expect(segments[0]!.days.map((day) => day.leadDay)).toEqual(
      Array.from({ length: 15 }, (_, index) => index),
    );
    expect(segments[1]!.days[0]!.leadDay).toBe(15);
    expect(segments[1]!.days.at(-1)!.leadDay).toBe(45);

    for (const segment of segments) {
      for (const day of segment.days) {
        expect(day.valueMm).toBeNull();
        expect(day.dataClass).toBeNull();
        expect(day.model).toBeNull();
        expect(day.initializedAt).toBeNull();
        expect(day.availability).toBeNull();
        expect(day.missingReason).toBe("pending");
      }
    }
  });

  it("states the band TTL on every day, including absent ones", () => {
    const [daily, subseasonal] = assembled([]);

    expect(daily!.days[3]!.staleAfterHours).toBe(6);
    expect(daily!.days[4]!.staleAfterHours).toBe(12);
    expect(daily!.days[14]!.staleAfterHours).toBe(12);
    expect(subseasonal!.days[0]!.staleAfterHours).toBe(48);
  });

  it("serves a stored day with its own class, model, run, and date", () => {
    const [daily] = assembled([
      row(0, 12.5, { initializedAt: "2026-11-27T03:00:00.000Z" }),
      row(9, 0),
    ]);

    const first = daily!.days[0]!;
    expect(first).toMatchObject({
      date: FIRST_DATE,
      leadDay: 0,
      valueMm: 12.5,
      dataClass: "weather_forecast",
      model: "ecmwf_ifs025",
      initializedAt: "2026-11-27T03:00:00.000Z",
      availability: "fresh",
      missingReason: null,
    });
    // Zero is a measurement, not an absence.
    expect(daily!.days[9]!.valueMm).toBe(0);
    expect(daily!.days[9]!.missingReason).toBeNull();
  });

  it("treats a stored null value as pending, because nothing records why", () => {
    const [daily] = assembled([row(1, null)]);

    expect(daily!.days[1]!.valueMm).toBeNull();
    expect(daily!.days[1]!.missingReason).toBe("pending");
    expect(daily!.days[1]!.dataClass).toBeNull();
    expect(daily!.days[1]!.model).toBeNull();
  });

  it("drops rows outside the horizon instead of failing them", () => {
    const [daily, subseasonal] = assembled([row(-1, 5), row(46, 5)]);

    expect(daily!.days.every((day) => day.valueMm === null)).toBe(true);
    expect(subseasonal!.days.every((day) => day.valueMm === null)).toBe(true);
  });

  it("keeps the newest run when two rows describe one day", () => {
    const [daily] = assembled([
      row(2, 1, { initializedAt: "2026-11-26T00:00:00.000Z" }),
      row(2, 2, { initializedAt: "2026-11-27T00:00:00.000Z" }),
    ]);

    expect(daily!.days[2]!.valueMm).toBe(2);
  });
});

describe("freshness per band", () => {
  it("ages 0–3 d at 6 h, 4–14 d at 12 h, and 15–45 d at 48 h", () => {
    const cases: ReadonlyArray<[leadDay: number, ageHours: number, expected: string]> = [
      [3, 5, "fresh"],
      [3, 7, "stale"],
      [10, 11, "fresh"],
      [10, 13, "stale"],
      [30, 47, "fresh"],
      [30, 49, "stale"],
    ];

    for (const [leadDay, ageHours, expected] of cases) {
      const initializedAt = new Date(Date.parse(NOW) - ageHours * 60 * 60 * 1000).toISOString();
      const [daily, subseasonal] = assembled([row(leadDay, 3, { initializedAt })]);
      const day = leadDay <= 14 ? daily!.days[leadDay]! : subseasonal!.days[leadDay - 15]!;
      expect(day.availability, `lead ${leadDay} at ${ageHours} h`).toBe(expected);
    }
  });
});

describe("inconsistent stored rows are refused, not dropped", () => {
  const failure = (rows: readonly DailyRecordRow[]): string => {
    const outcome = assembleDailyHorizon({
      firstDate: FIRST_DATE,
      provider: "open-meteo",
      model: "ecmwf_ifs025",
      rows,
      now: NOW,
    });
    if (outcome.ok) throw new Error("expected a failure");
    return outcome.kind;
  };

  it("refuses an ensemble member in a single-value slot", () => {
    expect(failure([row(0, 3, { ensembleMember: 7 })])).toBe("inconsistent_row");
  });

  it("refuses a non-millimetre unit", () => {
    expect(failure([row(0, 3, { unit: "cm" })])).toBe("inconsistent_row");
  });

  it("refuses a non-daily row", () => {
    expect(
      failure([row(0, 3, { temporalResolution: "monthly", aggregationLevel: "monthly_sum" })]),
    ).toBe("inconsistent_row");
  });

  it("refuses a class that contradicts its band", () => {
    expect(failure([row(0, 3, { dataClass: "subseasonal_forecast" })])).toBe("inconsistent_row");
    expect(failure([row(20, 3, { dataClass: "weather_forecast" })])).toBe("inconsistent_row");
    expect(failure([row(0, 3, { dataClass: "not_a_class" })])).toBe("inconsistent_row");
  });

  it("refuses an unparseable instant", () => {
    expect(failure([row(0, 3, { validAt: "2026-11-27 00:00:00" })])).toBe("inconsistent_row");
  });
});
