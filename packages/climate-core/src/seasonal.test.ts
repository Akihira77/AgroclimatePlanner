import { hashSeasonalRecordSet, seasonalRecordSetPayloadSchema } from "@agroclimate/contracts";
import { describe, expect, it } from "vitest";

import {
  SEASONAL_OUTLOOK_DERIVATION_VERSION,
  SEASONAL_REQUIRED_MEMBER_COUNT,
  SPREAD_REASON_SEASONAL,
  assembleSeasonalOutlook,
  seasonalOutlookMonths,
  type SeasonalMemberTotal,
} from "./seasonal.js";

/** 1 November 2026 initialisation → lead 1 is December 2026, lead 6 is May 2027. */
const INIT = "2026-11-01T00:00:00.000Z";
const MONTHS = ["2026-12-01", "2027-01-01", "2027-02-01", "2027-03-01", "2027-04-01", "2027-05-01"];

const FORECAST_RUN_ID = "0192f0aa-0000-7000-8000-0000000000f1";
const INGESTION_RUN_ID = "0192f0aa-0000-7000-8000-0000000000f2";
const CELL_KEY = "-6.25,106.75";

/** Member `index` carries `index` mm, so every mean is hand-computable. */
function members(valueOf: (index: number) => number = (index) => index): SeasonalMemberTotal[] {
  const rows: SeasonalMemberTotal[] = [];
  for (const month of MONTHS) {
    for (let index = 0; index < SEASONAL_REQUIRED_MEMBER_COUNT; index += 1) {
      rows.push({ month, memberIndex: index, valueMm: valueOf(index) });
    }
  }
  return rows;
}

function assemble(overrides: Partial<Parameters<typeof assembleSeasonalOutlook>[0]> = {}) {
  return assembleSeasonalOutlook({
    initializedAt: INIT,
    cellKey: CELL_KEY,
    forecastRunId: FORECAST_RUN_ID,
    ingestionRunId: INGESTION_RUN_ID,
    members: members(),
    ...overrides,
  });
}

function ok(outcome: ReturnType<typeof assemble>) {
  if (!outcome.ok) throw new Error(`${outcome.kind}: ${outcome.message}`);
  return outcome.value;
}

describe("seasonalOutlookMonths — lead 1 is the month after initialisation", () => {
  it("returns the six months one run fills", () => {
    expect(seasonalOutlookMonths(INIT)).toEqual(MONTHS);
  });

  it("shares the month for every day of the initialisation month", () => {
    expect(seasonalOutlookMonths("2026-11-30T18:00:00.000Z")).toEqual(MONTHS);
  });

  it("rolls December into January", () => {
    expect(seasonalOutlookMonths("2026-12-15T00:00:00.000Z")?.slice(0, 2)).toEqual([
      "2027-01-01",
      "2027-02-01",
    ]);
  });

  it("refuses an instant that is not UTC", () => {
    expect(seasonalOutlookMonths("2026-11-01T00:00:00+07:00")).toBeNull();
  });
});

describe("assembleSeasonalOutlook — the ensemble mean", () => {
  it("averages the 50 member totals per month", () => {
    const derivation = ok(assemble());

    expect(derivation.months.map((month) => month.month)).toEqual(MONTHS);
    // sum(0..49) / 50 = 1225 / 50
    for (const month of derivation.months) expect(month.valueMm).toBe(24.5);
    expect(
      derivation.months.every((month) => month.spreadUnavailableReason === SPREAD_REASON_SEASONAL),
    ).toBe(true);
  });

  it("carries exactly one seasonal forecast ref and a sha256 derivation hash", () => {
    const derivation = ok(assemble());

    expect(derivation.derivationVersion).toBe(SEASONAL_OUTLOOK_DERIVATION_VERSION);
    expect(derivation.inputRefs).toEqual([
      {
        kind: "forecast",
        role: "seasonal",
        purpose: "input",
        forecastRunIds: [FORECAST_RUN_ID],
        ingestionRunIds: [INGESTION_RUN_ID],
        recordSetHash: derivation.recordSetHash,
      },
    ]);
    expect(derivation.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("does not mutate the caller's member array", () => {
    const rows = members();
    const before = rows.map((row) => `${row.month}|${row.memberIndex}`);
    ok(assemble({ members: rows }));
    expect(rows.map((row) => `${row.month}|${row.memberIndex}`)).toEqual(before);
  });
});

describe("assembleSeasonalOutlook — the record-set hash", () => {
  const preimage = () => {
    const parsed = seasonalRecordSetPayloadSchema.safeParse({
      artifact: "seasonal_outlook_population",
      forecastRunId: FORECAST_RUN_ID,
      ingestionRunId: INGESTION_RUN_ID,
      cellKey: CELL_KEY,
      memberCountByMonth: MONTHS.map((month) => ({
        month,
        memberCount: SEASONAL_REQUIRED_MEMBER_COUNT,
      })),
      members: [
        ...MONTHS.flatMap((month) =>
          Array.from({ length: SEASONAL_REQUIRED_MEMBER_COUNT }, (_unused, index) => ({
            month,
            memberIndex: index,
            valueMm: index,
          })),
        ),
      ],
    });
    if (!parsed.success) throw new Error(JSON.stringify(parsed.error.issues));
    return parsed.data;
  };

  it("is the hash of the consumed population", () => {
    expect(ok(assemble()).recordSetHash).toBe(hashSeasonalRecordSet(preimage()));
  });

  it("is order-independent, because the producer sorts", () => {
    const forward = ok(assemble()).recordSetHash;
    const reversed = ok(assemble({ members: members().reverse() })).recordSetHash;
    expect(reversed).toBe(forward);
  });

  it("changes when one consumed value changes", () => {
    const base = ok(assemble()).recordSetHash;
    const shifted = ok(
      assemble({
        members: members((index) => (index === 7 ? 6.5 : index)),
      }),
    ).recordSetHash;
    expect(shifted).not.toBe(base);
  });

  it("changes when the run identity changes", () => {
    const base = ok(assemble()).recordSetHash;
    const other = ok(
      assemble({ ingestionRunId: "0192f0aa-0000-7000-8000-0000000000f3" }),
    ).recordSetHash;
    expect(other).not.toBe(base);
  });

  it("changes when the member count changes, even at the same mean", () => {
    // Not a legal population (49 members), so this asserts the refusal instead:
    // the count is part of the identity, so there is no hash for a short set.
    const short = members().filter((row) => row.memberIndex !== 49);
    const outcome = assemble({ members: short });
    expect(outcome.ok).toBe(false);
    expect(outcome.ok === false && outcome.kind).toBe("incomplete_population");
  });
});

describe("assembleSeasonalOutlook — all or nothing", () => {
  it("refuses 49 members rather than averaging over the remainder", () => {
    const outcome = assemble({ members: members().filter((row) => row.memberIndex !== 12) });
    expect(outcome.ok === false && outcome.kind).toBe("incomplete_population");
    expect(outcome.ok === false && /carries 49 members/.test(outcome.message)).toBe(true);
  });

  it("refuses a duplicated member index", () => {
    const rows = members();
    rows.push({ month: "2026-12-01", memberIndex: 0, valueMm: 99 });
    const outcome = assemble({ members: rows });
    expect(outcome.ok === false && outcome.kind).toBe("incomplete_population");
  });

  it("refuses an index outside 0..49", () => {
    const rows = members().filter((row) => !(row.month === "2026-12-01" && row.memberIndex === 0));
    rows.push({ month: "2026-12-01", memberIndex: 50, valueMm: 1 });
    const outcome = assemble({ members: rows });
    expect(outcome.ok === false && outcome.kind).toBe("invalid_input");
  });

  it("refuses a missing month of the run window", () => {
    const outcome = assemble({ members: members().filter((row) => row.month !== "2027-03-01") });
    expect(outcome.ok === false && outcome.kind).toBe("incomplete_population");
    expect(outcome.ok === false && /2027-03-01/.test(outcome.message)).toBe(true);
  });

  it("refuses a month outside the run window", () => {
    const outcome = assemble({
      members: [...members(), { month: "2027-06-01", memberIndex: 0, valueMm: 1 }],
    });
    expect(outcome.ok === false && outcome.kind).toBe("invalid_input");
  });

  it("refuses a null, negative, or non-finite total", () => {
    for (const value of [null, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const rows = members();
      rows[3] = { ...(rows[3] as SeasonalMemberTotal), valueMm: value as number };
      const outcome = assemble({ members: rows });
      expect(outcome.ok === false && outcome.kind).toBe("invalid_input");
    }
  });

  it("refuses an empty population and an unusable initialisation instant", () => {
    expect(assemble({ members: [] }).ok).toBe(false);
    expect(assemble({ initializedAt: "2026-11-01" }).ok).toBe(false);
  });
});
