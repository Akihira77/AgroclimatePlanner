import {
  monthlyOutlookHorizonSchema,
  hashBaselineNormals,
  hashDerivationDescriptor,
} from "@agroclimate/contracts";
import { describe, expect, it } from "vitest";

import {
  CLIMATOLOGY_OUTLOOK_DERIVATION_VERSION,
  SPREAD_REASON_CLIMATOLOGY,
  SPREAD_REASON_NO_VALUE,
  assembleClimatologyOutlook,
  type StoredBaselineNormal,
} from "./aggregate.js";

/**
 * Fixtures are hand-computable: twelve monthly normals, one value each. Nothing
 * calls a provider, a clock or a database.
 */

const BASELINE_VERSION = "ERA5:1991-2020:v1";
const FIRST_MONTH = "2026-08-01";

function normal(index: number, valueMm = 100 + index): StoredBaselineNormal {
  return {
    month: `1991-${String(index + 1).padStart(2, "0")}-01`,
    valueMm,
    sampleYears: 30,
  };
}

function normals(): StoredBaselineNormal[] {
  return Array.from({ length: 12 }, (_unused, index) => normal(index));
}

function assemble(overrides: Partial<Parameters<typeof assembleClimatologyOutlook>[0]> = {}) {
  return assembleClimatologyOutlook({
    firstMonth: FIRST_MONTH,
    cellKey: "-6.25,106.75",
    baselineVersion: BASELINE_VERSION,
    baselineDataset: "era5",
    normals: normals(),
    ...overrides,
  });
}

function ok(outcome: ReturnType<typeof assemble>) {
  if (!outcome.ok)
    throw new Error(`expected success, received ${outcome.kind}: ${outcome.message}`);
  return outcome.value;
}

describe("assembleClimatologyOutlook — the twelve-month horizon", () => {
  it("produces exactly twelve entries in lead-month order", () => {
    const horizon = ok(assemble()).horizon;

    expect(horizon.months).toHaveLength(12);
    horizon.months.forEach((month, index) => {
      expect(month.leadMonth).toBe(index + 1);
    });
  });

  it("maps lead months to calendar months and rolls December into January", () => {
    const horizon = ok(assemble({ firstMonth: "2026-08-01" })).horizon;

    expect(horizon.firstMonth).toBe("2026-08-01");
    expect(horizon.months[0]?.month).toBe("2026-08-01");
    expect(horizon.months[4]?.month).toBe("2026-12-01");
    expect(horizon.months[5]?.month).toBe("2027-01-01");
    expect(horizon.months[11]?.month).toBe("2027-07-01");
  });

  it("produces a horizon the response contract accepts", () => {
    const horizon = ok(assemble()).horizon;
    expect(() => monthlyOutlookHorizonSchema.parse(horizon)).not.toThrow();
  });
});

describe("assembleClimatologyOutlook — class boundaries", () => {
  it("fills lead months 7–12 with climatology and the baseline that produced them", () => {
    const horizon = ok(assemble()).horizon;

    for (const month of horizon.months.slice(6)) {
      expect(month.dataClass).toBe("climatology");
      expect(month.evaluationBasis).toBe("climatology");
      expect(month.missingReason).toBe("beyond_horizon");
      expect(month.baselineVersion).toBe(BASELINE_VERSION);
      expect(month.anomalyKind).toBeNull();
      expect(month.ensembleSpreadMm).toBeNull();
      expect(month.spreadUnavailableReason).toBe(SPREAD_REASON_CLIMATOLOGY);
    }
  });

  it("values lead 7–12 from the normal of the same calendar month-of-year", () => {
    const horizon = ok(assemble()).horizon;

    // Lead 7 of 2026-08 is 2027-02, so the February normal (index 1) is used.
    expect(horizon.months[6]?.month).toBe("2027-02-01");
    expect(horizon.months[6]?.valueMm).toBe(101);
    // Lead 8 of 2026-08 is 2027-03, the March normal (index 2).
    expect(horizon.months[7]?.month).toBe("2027-03-01");
    expect(horizon.months[7]?.valueMm).toBe(102);
    // Lead 12 of 2026-08 is 2027-07, the July normal (index 6).
    expect(horizon.months[11]?.month).toBe("2027-07-01");
    expect(horizon.months[11]?.valueMm).toBe(106);
  });

  it("never fills lead months 1–6 with climatology", () => {
    const horizon = ok(assemble()).horizon;

    for (const month of horizon.months.slice(0, 6)) {
      expect(month.dataClass).toBeNull();
      expect(month.valueMm).toBeNull();
      expect(month.missingReason).toBe("pending");
      expect(month.evaluationBasis).toBe("monthly");
      expect(month.baselineVersion).toBeNull();
      expect(month.spreadUnavailableReason).toBe(SPREAD_REASON_NO_VALUE);
    }
  });
});

describe("assembleClimatologyOutlook — baseline gaps", () => {
  it("reports a missing normal as insufficient_history and does not persist that month", () => {
    const withoutMarch = normals().filter((entry) => entry.month !== "1991-03-01");
    const value = ok(assemble({ normals: withoutMarch }));

    const march = value.horizon.months[7];
    expect(march?.month).toBe("2027-03-01");
    expect(march?.dataClass).toBeNull();
    expect(march?.valueMm).toBeNull();
    expect(march?.missingReason).toBe("insufficient_history");
    expect(value.derivation?.months).toHaveLength(5);
    expect(value.derivation?.months.map((month) => month.month)).not.toContain("2027-03-01");
  });

  it("returns no derivation at all when the baseline holds no normal for the cell", () => {
    const value = ok(assemble({ normals: [] }));

    expect(value.derivation).toBeNull();
    for (const month of value.horizon.months.slice(6)) {
      expect(month.missingReason).toBe("insufficient_history");
      expect(month.dataClass).toBeNull();
    }
  });

  it("refuses a normal whose sample count is unknown, because the hash would be invented", () => {
    const withGap = normals();
    withGap[0] = { ...(withGap[0] as StoredBaselineNormal), sampleYears: null };

    const outcome = assemble({ normals: withGap });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("insufficient_provenance");
  });
});

describe("assembleClimatologyOutlook — provenance", () => {
  it("carries one baseline ref and a hash derived from the consumed normals", () => {
    const derivation = ok(assemble()).derivation;
    if (derivation === null) throw new Error("expected a derivation");

    expect(derivation.derivationVersion).toBe(CLIMATOLOGY_OUTLOOK_DERIVATION_VERSION);
    expect(derivation.inputRefs).toHaveLength(1);
    expect(derivation.inputRefs[0]).toMatchObject({
      kind: "baseline",
      role: "climatology",
      purpose: "input",
      baselineVersion: BASELINE_VERSION,
      cellKeys: ["-6.25,106.75"],
    });
    expect(derivation.baselineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(derivation.inputSnapshotHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes the baseline and the descriptor with the shared canonical implementation", () => {
    const derivation = ok(assemble()).derivation;
    if (derivation === null) throw new Error("expected a derivation");

    const expectedBaselineHash = hashBaselineNormals({
      baselineVersion: BASELINE_VERSION,
      baselineDataset: "era5",
      monthlyNormals: normals().map((entry) => ({
        cellKey: "-6.25,106.75",
        month: entry.month,
        valueMm: entry.valueMm,
        sampleYears: entry.sampleYears as number,
      })),
    });
    expect(derivation.baselineHash).toBe(expectedBaselineHash);

    const expectedSnapshotHash = hashDerivationDescriptor({
      artifact: "monthly_outlook",
      inputRefs: [...derivation.inputRefs],
      derivationVersion: derivation.derivationVersion,
    });
    expect(derivation.inputSnapshotHash).toBe(expectedSnapshotHash);
  });

  it("is deterministic for equivalent input sets, including a reordered normal list", () => {
    const first = ok(assemble()).derivation;
    const second = ok(assemble({ normals: [...normals()].reverse() })).derivation;

    expect(second?.baselineHash).toBe(first?.baselineHash);
    expect(second?.inputSnapshotHash).toBe(first?.inputSnapshotHash);
    expect(second?.months).toEqual(first?.months);
  });

  it("changes the snapshot hash when the baseline version changes", () => {
    const first = ok(assemble()).derivation;
    const second = ok(assemble({ baselineVersion: "ERA5:1991-2020:v2" })).derivation;

    expect(second?.inputSnapshotHash).not.toBe(first?.inputSnapshotHash);
    // The hash preimage names the version, so a different baseline cannot share
    // a hash with another one even when every number is identical.
    expect(second?.baselineHash).not.toBe(first?.baselineHash);
  });
});

describe("assembleClimatologyOutlook — refusals", () => {
  it("rejects a firstMonth that is not the first day of a month", () => {
    const outcome = assemble({ firstMonth: "2026-08-15" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
  });

  it("rejects a non-existent calendar month", () => {
    const outcome = assemble({ firstMonth: "2026-13-01" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
  });

  it("rejects two normals for the same month-of-year", () => {
    const outcome = assemble({ normals: [...normals(), normal(0, 5)] });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
  });

  it("rejects a normal that is not first-of-month", () => {
    const malformed = normals();
    malformed[3] = { ...(malformed[3] as StoredBaselineNormal), month: "1991-04-15" };
    const outcome = assemble({ normals: malformed });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
  });

  it("rejects a negative or non-finite normal", () => {
    const negative = assemble({ normals: [normal(0, -1), ...normals().slice(1)] });
    const infinite = assemble({
      normals: [normal(0, Number.POSITIVE_INFINITY), ...normals().slice(1)],
    });

    expect(negative.ok).toBe(false);
    expect(infinite.ok).toBe(false);
  });

  it("rejects an empty cell key", () => {
    const outcome = assemble({ cellKey: "" });
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.kind).toBe("invalid_input");
  });
});
