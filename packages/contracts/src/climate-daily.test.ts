import { describe, expect, it } from "vitest";

import {
  DAILY_BAND,
  SUBSESONAL_BAND,
  addCalendarDays,
  calendarDaysBetween,
  climateDailyOutlookQuerySchema,
  climateDailyOutlookSchema,
  dailyBandOf,
  permittedDailyDataClasses,
} from "../src/climate.js";

const FIELD_ID = "0192f0aa-0000-7000-8000-0000000000aa";

function day(leadDay: number, firstDate: string, value: number | null) {
  return {
    date: addCalendarDays(firstDate, leadDay),
    leadDay,
    dataClass:
      value === null
        ? null
        : dailyBandOf(leadDay) === "daily"
          ? "weather_forecast"
          : "subseasonal_forecast",
    model: value === null ? null : "ecmwf_if",
    valueMm: value,
    missingReason: value === null ? "pending" : null,
    initializedAt: value === null ? null : "2026-11-27T00:00:00.000Z",
    availability: value === null ? null : "fresh",
    staleAfterHours: leadDay <= 3 ? 6 : leadDay <= 14 ? 12 : 48,
    temporalResolution: "daily",
    aggregationLevel: "daily_sum",
  };
}

function response(
  firstDate = "2026-11-27",
  fill: (leadDay: number) => number | null = (leadDay) => leadDay + 1,
) {
  const segment = (from: number, to: number, band: "daily" | "subseasonal") => {
    const days = [];
    for (let leadDay = from; leadDay <= to; leadDay += 1) {
      days.push(day(leadDay, firstDate, fill(leadDay)));
    }
    return {
      band,
      evaluationBasis: "daily",
      dataClass: band === "daily" ? "weather_forecast" : "subseasonal_forecast",
      unit: "mm",
      days,
    };
  };

  return {
    fieldId: FIELD_ID,
    provider: "ecmwf",
    model: "ifs",
    firstDate,
    unit: "mm",
    segments: [
      segment(DAILY_BAND.fromLeadDay, DAILY_BAND.toLeadDay, "daily"),
      segment(SUBSESONAL_BAND.fromLeadDay, SUBSESONAL_BAND.toLeadDay, "subseasonal"),
    ],
  };
}

describe("calendar day arithmetic", () => {
  it("crosses month, year, and leap-day boundaries without a clock", () => {
    expect(addCalendarDays("2026-11-27", 4)).toBe("2026-12-01");
    expect(addCalendarDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(addCalendarDays("2024-02-28", 1)).toBe("2024-02-29");
    expect(addCalendarDays("2023-02-28", 1)).toBe("2023-03-01");
    expect(addCalendarDays("2026-11-27", -1)).toBe("2026-11-26");
    expect(calendarDaysBetween("2026-11-27", "2027-01-05")).toBe(39);
    expect(calendarDaysBetween("2027-01-05", "2026-11-27")).toBe(-39);
    // The difference is day labels, not 23 or 25 hours of a clock.
    expect(calendarDaysBetween("2026-11-27", "2026-11-28")).toBe(1);
  });

  it("refuses a malformed date instead of guessing", () => {
    expect(() => addCalendarDays("2026-02-31", 1)).toThrow(RangeError);
    expect(() => addCalendarDays("2026-13-01", 1)).toThrow(RangeError);
  });
});

describe("daily horizon bands", () => {
  it("maps lead days to the horizon map's bands and nothing else", () => {
    expect(dailyBandOf(-1)).toBeNull();
    expect(dailyBandOf(0)).toBe("daily");
    expect(dailyBandOf(14)).toBe("daily");
    expect(dailyBandOf(15)).toBe("subseasonal");
    expect(dailyBandOf(45)).toBe("subseasonal");
    expect(dailyBandOf(46)).toBeNull();
    expect(permittedDailyDataClasses(7)).toEqual(["weather_forecast"]);
    expect(permittedDailyDataClasses(30)).toEqual(["subseasonal_forecast"]);
    expect(permittedDailyDataClasses(46)).toEqual([]);
  });
});

describe("climateDailyOutlookSchema", () => {
  it("accepts two ordered dense segments", () => {
    expect(climateDailyOutlookSchema.safeParse(response()).success).toBe(true);
  });

  it("requires 15 daily days and 31 subseasonal days", () => {
    const sparse = response();
    sparse.segments[0]!.days.splice(0, 1);
    expect(climateDailyOutlookSchema.safeParse(sparse).success).toBe(false);

    const short = response();
    short.segments[1]!.days.splice(0, 1);
    expect(climateDailyOutlookSchema.safeParse(short).success).toBe(false);
  });

  it("rejects a band carrying another band's class", () => {
    const swapped = response();
    swapped.segments[0]!.dataClass = "subseasonal_forecast";
    expect(climateDailyOutlookSchema.safeParse(swapped).success).toBe(false);
  });

  it("rejects segments in the wrong order", () => {
    const reversed = response();
    reversed.segments.reverse();
    expect(climateDailyOutlookSchema.safeParse(reversed).success).toBe(false);
  });

  it("rejects a date that does not follow from firstDate and leadDay", () => {
    const drifted = response();
    drifted.segments[0]!.days[3]!.date = "2026-12-25";
    expect(climateDailyOutlookSchema.safeParse(drifted).success).toBe(false);
  });

  it("rejects a value without provenance and a provenance without a value", () => {
    const unlabelled = response();
    unlabelled.segments[0]!.days[0]!.dataClass = null;
    expect(climateDailyOutlookSchema.safeParse(unlabelled).success).toBe(false);

    const labelledAbsence = response("2026-11-27", (leadDay) =>
      leadDay === 0 ? null : leadDay + 1,
    );
    labelledAbsence.segments[0]!.days[0]!.model = "ecmwf_if";
    expect(climateDailyOutlookSchema.safeParse(labelledAbsence).success).toBe(false);
  });

  it("requires a reason when a day has no value", () => {
    const silent = response("2026-11-27", (leadDay) => (leadDay === 2 ? null : leadDay + 1));
    silent.segments[0]!.days[2]!.missingReason = null;
    expect(climateDailyOutlookSchema.safeParse(silent).success).toBe(false);

    const contradictory = response();
    contradictory.segments[0]!.days[0]!.missingReason = "ingest_failed";
    expect(climateDailyOutlookSchema.safeParse(contradictory).success).toBe(false);
  });
});

describe("climateDailyOutlookQuerySchema", () => {
  it("accepts a field and a source pair, and refuses client-supplied geometry", () => {
    const base = { fieldId: FIELD_ID, provider: "ecmwf", model: "ifs" };

    expect(climateDailyOutlookQuerySchema.safeParse(base).success).toBe(true);
    expect(
      climateDailyOutlookQuerySchema.safeParse({ ...base, firstDate: "2026-11-27" }).success,
    ).toBe(true);
    expect(
      climateDailyOutlookQuerySchema.safeParse({ ...base, firstDate: "2026-11-27T00:00:00Z" })
        .success,
    ).toBe(false);
    for (const extra of [
      { lat: "-6.15" },
      { cellKey: "-7.00,106.00" },
      { dataClass: "weather_forecast" },
    ]) {
      expect(climateDailyOutlookQuerySchema.safeParse({ ...base, ...extra }).success).toBe(false);
    }
  });
});
