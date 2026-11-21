import { describe, expect, it } from "vitest";
import {
  LEAD_MONTHS,
  adapterResultSchema,
  calendarMonthOf,
  coveragePercentOf,
  forecastRunIdentitySchema,
  forecastRunSchema,
  ingestionRunIdentitySchema,
  ingestionRunSchema,
  ingestionVersionOf,
  monthlyOutlookHorizonSchema,
  monthlyOutlookSchema,
  outlookMonthSchema,
  permittedMonthlyDataClasses,
} from "../src/climate.js";
import { evaluationBasisSchema, weatherValueSchema } from "../src/index.js";
import { derivationProvenanceSchema } from "../src/provenance.js";

const HASH = "a".repeat(64);
const RUN_A = "0192f0aa-0000-7000-8000-000000000001";
const RUN_B = "0192f0aa-0000-7000-8000-000000000002";

const forecastValue = {
  dataClass: "weather_forecast",
  evaluationBasis: "daily",
  dataAvailability: "available",
  amount: 12.4,
  unit: "mm",
  spatialResolutionKm: 9,
  servedValueIsInterpolated: true,
  freshness: {
    kind: "source",
    dataAvailability: "available",
    initializedAt: "2026-11-18T00:00:00Z",
  },
  attribution: "BMKG",
  source: {
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    forecastRunId: RUN_A,
    ingestionRunId: RUN_B,
    initializedAt: "2026-11-18T00:00:00Z",
  },
};

describe("evaluationBasis", () => {
  it("accepts a single value carrying a concrete basis", () => {
    expect(weatherValueSchema.safeParse(forecastValue).success).toBe(true);
  });

  it("rejects mixed on a single value", () => {
    const result = weatherValueSchema.safeParse({ ...forecastValue, evaluationBasis: "mixed" });
    expect(result.success).toBe(false);
  });

  it("keeps mixed legal at container level", () => {
    expect(evaluationBasisSchema.safeParse("mixed").success).toBe(true);
  });
});

describe("ForecastRun", () => {
  const identity = {
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    product: "forecast",
    initializedAt: "2026-11-18T00:00:00Z",
  };
  const row = {
    ...identity,
    id: RUN_A,
    horizonEnd: "2026-11-25T00:00:00Z",
    receivedAt: "2026-11-18T00:10:00Z",
    createdAt: "2026-11-18T00:10:00Z",
  };

  it("accepts a natural identity with no id and no version", () => {
    expect(forecastRunIdentitySchema.safeParse(identity).success).toBe(true);
    expect(forecastRunIdentitySchema.safeParse({ ...identity, modelVersion: "v2" }).success).toBe(
      false,
    );
  });

  it("accepts a persisted row with a v7 id", () => {
    expect(forecastRunSchema.safeParse(row).success).toBe(true);
  });

  it("rejects a horizon that ends before it starts", () => {
    const result = forecastRunSchema.safeParse({ ...row, horizonEnd: identity.initializedAt });
    expect(result.success).toBe(false);
  });

  it("rejects a v4 identifier", () => {
    const result = forecastRunSchema.safeParse({
      ...row,
      id: "0192f0aa-0000-4000-8000-000000000001",
    });
    expect(result.success).toBe(false);
  });
});

describe("IngestionRun", () => {
  const versions = {
    adapterVersion: "open-meteo-forecast@1.0.0",
    normalizerVersion: "normalize-forecast@1.0.0",
    targetSelectorHash: HASH,
  };
  const ingestionVersion = ingestionVersionOf(versions);
  const row = {
    id: RUN_B,
    forecastRunId: RUN_A,
    ...versions,
    ingestionVersion,
    status: "succeeded",
    attempt: 1,
    startedAt: "2026-11-18T00:05:00Z",
    finishedAt: "2026-11-18T00:06:00Z",
    recordCount: 336,
    coveragePercent: 100,
    error: null,
    rawPayloadRef: null,
    createdAt: "2026-11-18T00:05:00Z",
  };

  it("derives the version deterministically from three strings", () => {
    expect(ingestionVersion).toMatch(/^[0-9a-f]{64}$/);
    expect(ingestionVersionOf(versions)).toBe(ingestionVersion);
    expect(
      ingestionVersionOf({ ...versions, normalizerVersion: "normalize-forecast@1.0.1" }),
    ).not.toBe(ingestionVersion);
  });

  it("keeps attempt out of identity", () => {
    expect(
      ingestionRunIdentitySchema.safeParse({ forecastRunId: RUN_A, ingestionVersion }).success,
    ).toBe(true);
    expect(
      ingestionRunIdentitySchema.safeParse({ forecastRunId: RUN_A, ingestionVersion, attempt: 3 })
        .success,
    ).toBe(false);
  });

  it("accepts a terminal row whose version matches its inputs", () => {
    expect(ingestionRunSchema.safeParse(row).success).toBe(true);
  });

  it("rejects a version that does not match the inputs it claims", () => {
    const result = ingestionRunSchema.safeParse({ ...row, normalizerVersion: "normalize@9" });
    expect(result.success).toBe(false);
  });

  it("ties finishedAt to a terminal status", () => {
    expect(ingestionRunSchema.safeParse({ ...row, finishedAt: null }).success).toBe(false);
    expect(
      ingestionRunSchema.safeParse({ ...row, status: "running", finishedAt: null }).success,
    ).toBe(true);
  });

  it("counts attempts from one", () => {
    expect(ingestionRunSchema.safeParse({ ...row, attempt: 0 }).success).toBe(false);
    expect(ingestionRunSchema.safeParse({ ...row, attempt: 4 }).success).toBe(true);
  });
});

describe("AdapterResult", () => {
  const meta = {
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    product: "forecast",
    initializedAt: "2026-11-18T00:00:00Z",
    horizonEnd: "2026-11-25T00:00:00Z",
    attribution: "Open-Meteo",
    sourceUrl: "https://example.test/forecast",
    adapterVersion: "open-meteo-forecast@1.0.0",
  };
  const observation = {
    variable: "precipitation",
    dataClass: "weather_forecast",
    amount: 12.4,
    unit: "mm",
    validAt: "2026-11-19T00:00:00Z",
    requestedLat: -6.2,
    requestedLon: 106.8,
    servedLat: -6.25,
    servedLon: 106.75,
    servedValueIsInterpolated: false,
    ensembleMember: null,
    missingReason: null,
  };
  const coverage = { requestedCells: 4, answeredCells: 4, coveragePercent: 100 };

  it("expresses a complete response", () => {
    const result = adapterResultSchema.safeParse({
      kind: "complete",
      meta,
      receivedAt: "2026-11-18T00:10:00Z",
      rawPayloadRef: null,
      sourceUrl: meta.sourceUrl,
      observations: [observation],
      coverage,
    });
    expect(result.success).toBe(true);
  });

  it("expresses a partial response and requires coverage below 100", () => {
    expect(
      adapterResultSchema.safeParse({
        kind: "partial",
        meta,
        receivedAt: "2026-11-18T00:10:00Z",
        rawPayloadRef: null,
        sourceUrl: meta.sourceUrl,
        observations: [observation],
        coverage: { requestedCells: 4, answeredCells: 2, coveragePercent: 50 },
      }).success,
    ).toBe(true);
    expect(
      adapterResultSchema.safeParse({
        kind: "partial",
        meta,
        receivedAt: "2026-11-18T00:10:00Z",
        rawPayloadRef: null,
        sourceUrl: meta.sourceUrl,
        observations: [observation],
        coverage,
      }).success,
    ).toBe(false);
  });

  it("classifies each failure class separately", () => {
    for (const kind of ["transport", "request_invalid", "provider_changed"] as const) {
      expect(
        adapterResultSchema.safeParse({
          kind,
          receivedAt: "2026-11-18T00:10:00Z",
          message: "failed",
        }).success,
      ).toBe(true);
    }
    expect(
      adapterResultSchema.safeParse({
        kind: "rate_limited",
        receivedAt: "2026-11-18T00:10:00Z",
        message: "429",
        retryAfterSeconds: 60,
      }).success,
    ).toBe(true);
  });

  it("refuses an unclassified result", () => {
    expect(
      adapterResultSchema.safeParse({
        kind: "error",
        receivedAt: "2026-11-18T00:10:00Z",
        message: "failed",
      }).success,
    ).toBe(false);
  });

  it("refuses more answered cells than requested", () => {
    expect(
      adapterResultSchema.safeParse({
        kind: "complete",
        meta,
        receivedAt: "2026-11-18T00:10:00Z",
        rawPayloadRef: null,
        sourceUrl: meta.sourceUrl,
        observations: [],
        coverage: { requestedCells: 1, answeredCells: 2, coveragePercent: 200 },
      }).success,
    ).toBe(false);
  });
});

describe("reproducibility versus provenance", () => {
  const inputRef = {
    kind: "forecast",
    role: "short_range",
    purpose: "input",
    forecastRunIds: [RUN_A],
    ingestionRunIds: [RUN_B],
    recordSetHash: HASH,
  };
  const provenance = {
    inputRefs: [inputRef],
    inputSnapshotHash: HASH,
    derivationVersion: "monthly-outlook@1.0.0",
    computedAt: "2026-11-18T01:00:00Z",
    reproducibility: { reproducible: false, reason: "raw_payload_not_retained" },
  };

  it("accepts an unreproducible artifact that still has provenance", () => {
    expect(derivationProvenanceSchema.safeParse(provenance).success).toBe(true);
  });

  it("requires a reason when the payload was not retained", () => {
    expect(
      derivationProvenanceSchema.safeParse({
        ...provenance,
        reproducibility: { reproducible: false },
      }).success,
    ).toBe(false);
  });

  it("refuses a reason when the artifact is reproducible", () => {
    expect(
      derivationProvenanceSchema.safeParse({
        ...provenance,
        reproducibility: { reproducible: true, reason: "raw_payload_not_retained" },
      }).success,
    ).toBe(false);
  });

  it("rejects missing provenance on inputRefs, not as an unreproducible artifact", () => {
    const result = derivationProvenanceSchema.safeParse({ ...provenance, inputRefs: [] });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("inputRefs");
    expect(result.error?.issues.map((issue) => issue.path.join("."))).not.toContain(
      "reproducibility",
    );
  });
});

describe("MonthlyOutlook", () => {
  it("maps lead months 1–12 to the binding bands", () => {
    expect(permittedMonthlyDataClasses(1)).toEqual([
      "weather_forecast",
      "subseasonal_forecast",
      "seasonal_forecast",
    ]);
    expect(permittedMonthlyDataClasses(2)).toEqual([
      "weather_forecast",
      "subseasonal_forecast",
      "seasonal_forecast",
    ]);
    expect(permittedMonthlyDataClasses(3)).toEqual(["seasonal_forecast"]);
    expect(permittedMonthlyDataClasses(7)).toEqual(["seasonal_forecast"]);
    expect(permittedMonthlyDataClasses(8)).toEqual(["climatology"]);
    expect(permittedMonthlyDataClasses(12)).toEqual(["climatology"]);
    expect(permittedMonthlyDataClasses(0)).toEqual([]);
    expect(permittedMonthlyDataClasses(13)).toEqual([]);
    expect(permittedMonthlyDataClasses(-1)).toEqual([]);
  });

  it("covers every month from 1 to 12 exactly once", () => {
    for (let leadMonth = 1; leadMonth <= 12; leadMonth += 1) {
      expect(permittedMonthlyDataClasses(leadMonth).length).toBeGreaterThan(0);
    }
  });

  const base = {
    id: RUN_A,
    outlookCellId: RUN_B,
    variable: "precipitation",
    month: "2026-12-01",
    leadMonth: 3,
    dataClass: "seasonal_forecast",
    evaluationBasis: "monthly",
    valueMm: 244.2,
    missingReason: null,
    baselineVersion: null,
    anomalyKind: null,
    ensembleSpreadMm: 31.5,
    spreadUnavailableReason: null,
    derivationVersion: "monthly-outlook@1.0.0",
    inputRefs: [
      {
        kind: "forecast",
        role: "seasonal",
        purpose: "input",
        forecastRunIds: [RUN_A],
        ingestionRunIds: [RUN_B],
        recordSetHash: HASH,
      },
    ],
    inputSnapshotHash: HASH,
    computedAt: "2026-11-18T01:00:00Z",
    status: "active",
    supersededById: null,
  };

  it("accepts a real forecast month", () => {
    expect(monthlyOutlookSchema.safeParse(base).success).toBe(true);
  });

  it("accepts a pending month with no value and no class", () => {
    const pending = {
      ...base,
      dataClass: null,
      valueMm: null,
      missingReason: "pending",
      ensembleSpreadMm: null,
      spreadUnavailableReason: "not_requested",
    };
    expect(monthlyOutlookSchema.safeParse(pending).success).toBe(true);
  });

  it("rejects a pending month that carries a value", () => {
    const result = monthlyOutlookSchema.safeParse({ ...base, missingReason: "pending" });
    expect(result.success).toBe(false);
  });

  it("rejects a month with no value and no reason", () => {
    const result = monthlyOutlookSchema.safeParse({
      ...base,
      dataClass: null,
      valueMm: null,
      missingReason: null,
      ensembleSpreadMm: null,
      spreadUnavailableReason: "not_requested",
    });
    expect(result.success).toBe(false);
  });

  it("accepts a climatology month labelled beyond_horizon", () => {
    const climatology = {
      ...base,
      leadMonth: 9,
      dataClass: "climatology",
      evaluationBasis: "climatology",
      missingReason: "beyond_horizon",
      baselineVersion: "ERA5:1991-2020:v1",
      anomalyKind: null,
    };
    expect(monthlyOutlookSchema.safeParse(climatology).success).toBe(true);
  });

  it("rejects climatology with a failure reason, and without a baseline", () => {
    const failed = {
      ...base,
      leadMonth: 9,
      dataClass: "climatology",
      evaluationBasis: "climatology",
      missingReason: "ingest_failed",
      baselineVersion: "ERA5:1991-2020:v1",
    };
    expect(monthlyOutlookSchema.safeParse(failed).success).toBe(false);
    const noBaseline = {
      ...base,
      leadMonth: 9,
      dataClass: "climatology",
      evaluationBasis: "climatology",
      missingReason: "beyond_horizon",
      baselineVersion: null,
    };
    expect(monthlyOutlookSchema.safeParse(noBaseline).success).toBe(false);
  });

  it("does not let a missing forecast become climatology in an earlier month", () => {
    const promoted = {
      ...base,
      leadMonth: 3,
      dataClass: "climatology",
      evaluationBasis: "climatology",
      missingReason: "beyond_horizon",
      baselineVersion: "ERA5:1991-2020:v1",
    };
    expect(monthlyOutlookSchema.safeParse(promoted).success).toBe(false);
  });

  it("rejects a seasonal value in the climatology band", () => {
    expect(monthlyOutlookSchema.safeParse({ ...base, leadMonth: 8 }).success).toBe(false);
  });

  it("ties spread presence to its reason", () => {
    expect(monthlyOutlookSchema.safeParse({ ...base, ensembleSpreadMm: null }).success).toBe(false);
    expect(
      monthlyOutlookSchema.safeParse({
        ...base,
        ensembleSpreadMm: null,
        spreadUnavailableReason: "members_expired",
      }).success,
    ).toBe(true);
  });
});

describe("AdapterResult coverage invariants — F-04", () => {
  const meta = {
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    product: "forecast",
    initializedAt: "2026-11-18T00:00:00Z",
    horizonEnd: "2026-11-25T00:00:00Z",
    attribution: "Open-Meteo",
    sourceUrl: "https://example.test/forecast",
    adapterVersion: "open-meteo-forecast@1.0.0",
  };
  const result = (
    kind: "complete" | "partial",
    requestedCells: number,
    answeredCells: number,
    coveragePercent: number,
  ) => ({
    kind,
    meta,
    receivedAt: "2026-11-18T00:10:00Z",
    rawPayloadRef: null,
    sourceUrl: meta.sourceUrl,
    observations: [],
    coverage: { requestedCells, answeredCells, coveragePercent },
  });

  it("rounds to basis points, half away from zero", () => {
    expect(coveragePercentOf(3, 1)).toBe(33.33);
    expect(coveragePercentOf(3, 2)).toBe(66.67);
    expect(coveragePercentOf(4, 2)).toBe(50);
    // 10 000 / 32 = 312.5 basis points → 313 → 3.13.
    expect(coveragePercentOf(32, 1)).toBe(3.13);
    expect(coveragePercentOf(4, 4)).toBe(100);
  });

  it("refuses to compute a percentage from a zero-cell request", () => {
    expect(() => coveragePercentOf(0, 0)).toThrow(RangeError);
    expect(() => coveragePercentOf(4, -1)).toThrow(RangeError);
  });

  it("accepts a complete result at 100%", () => {
    expect(adapterResultSchema.safeParse(result("complete", 4, 4, 100)).success).toBe(true);
  });

  it("rejects a complete result that left a cell unanswered", () => {
    expect(adapterResultSchema.safeParse(result("complete", 4, 2, 50)).success).toBe(false);
  });

  it("rejects a complete result whose percentage disagrees with its counts", () => {
    expect(adapterResultSchema.safeParse(result("complete", 4, 4, 99)).success).toBe(false);
  });

  it("accepts a partial result with unanswered cells", () => {
    expect(adapterResultSchema.safeParse(result("partial", 4, 2, 50)).success).toBe(true);
  });

  it("rejects a partial result that answered every cell", () => {
    expect(adapterResultSchema.safeParse(result("partial", 4, 4, 100)).success).toBe(false);
  });

  it("rejects more answered cells than requested", () => {
    expect(adapterResultSchema.safeParse(result("partial", 1, 2, 200)).success).toBe(false);
  });

  it("rejects a zero-cell request", () => {
    expect(adapterResultSchema.safeParse(result("complete", 0, 0, 100)).success).toBe(false);
  });

  it("accepts the rounding boundary and rejects the raw fraction", () => {
    expect(adapterResultSchema.safeParse(result("partial", 32, 1, 3.13)).success).toBe(true);
    expect(adapterResultSchema.safeParse(result("partial", 32, 1, 3.125)).success).toBe(false);
  });

  it("rejects a percentage that no counts could produce", () => {
    expect(adapterResultSchema.safeParse(result("partial", 4, 2, 50.01)).success).toBe(false);
  });

  it("rounds one unanswered cell out of 20 001 to exactly 100", () => {
    expect(coveragePercentOf(20_001, 20_000)).toBe(100);
  });

  it("accepts a partial result whose rounded coverage is 100", () => {
    const partial = result("partial", 20_001, 20_000, 100);
    expect(partial.coverage.answeredCells).toBeLessThan(partial.coverage.requestedCells);
    expect(adapterResultSchema.safeParse(partial).success).toBe(true);
  });

  it("does not accept that same answer as complete", () => {
    expect(adapterResultSchema.safeParse(result("complete", 20_001, 20_000, 100)).success).toBe(
      false,
    );
  });

  it("accepts a large partial answer with one cell missing", () => {
    expect(adapterResultSchema.safeParse(result("partial", 1_000_000, 999_999, 100)).success).toBe(
      true,
    );
  });

  it("rejects a partial result whose percentage disagrees with its counts", () => {
    expect(adapterResultSchema.safeParse(result("partial", 4, 2, 49.99)).success).toBe(false);
  });

  it("keeps a failure result from carrying coverage at all", () => {
    const failed = {
      kind: "transport",
      receivedAt: "2026-11-18T00:10:00Z",
      message: "connection reset",
      coverage: { requestedCells: 4, answeredCells: 0, coveragePercent: 0 },
    };
    expect(adapterResultSchema.safeParse(failed).success).toBe(false);
  });
});

describe("MonthlyOutlook cross-field validation — F-05", () => {
  const ERA5 = "ERA5:1991-2020:v1";
  const month = (overrides: Record<string, unknown> = {}) => ({
    leadMonth: 4,
    month: "2027-02-01",
    dataClass: "seasonal_forecast",
    evaluationBasis: "monthly",
    valueMm: 210,
    missingReason: null,
    baselineVersion: null,
    anomalyKind: null,
    ensembleSpreadMm: 12,
    spreadUnavailableReason: null,
    ...overrides,
  });

  it("accepts a forecast month with a monthly basis", () => {
    expect(outlookMonthSchema.safeParse(month()).success).toBe(true);
  });

  it("rejects a forecast value claiming the climatology basis", () => {
    const result = outlookMonthSchema.safeParse(month({ evaluationBasis: "climatology" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("evaluationBasis");
  });

  it("rejects a climatology value claiming a forecast basis", () => {
    const result = outlookMonthSchema.safeParse(
      month({
        leadMonth: 9,
        dataClass: "climatology",
        evaluationBasis: "monthly",
        missingReason: "beyond_horizon",
        baselineVersion: ERA5,
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("evaluationBasis");
  });

  it("rejects a pending month claiming the climatology basis", () => {
    const result = outlookMonthSchema.safeParse(
      month({
        dataClass: null,
        evaluationBasis: "climatology",
        valueMm: null,
        missingReason: "pending",
        ensembleSpreadMm: null,
        spreadUnavailableReason: "not_requested",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("evaluationBasis");
  });

  it("accepts a pending month with a monthly basis and no value", () => {
    expect(
      outlookMonthSchema.safeParse(
        month({
          dataClass: null,
          valueMm: null,
          missingReason: "pending",
          ensembleSpreadMm: null,
          spreadUnavailableReason: "not_requested",
        }),
      ).success,
    ).toBe(true);
  });

  it("rejects an anomaly on a month with no value", () => {
    const result = outlookMonthSchema.safeParse(
      month({
        dataClass: null,
        valueMm: null,
        missingReason: "ingest_failed",
        anomalyKind: "model_anomaly",
        ensembleSpreadMm: null,
        spreadUnavailableReason: "ingest_failed",
      }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("anomalyKind");
  });

  it("requires a baseline for a baseline_difference anomaly", () => {
    const result = outlookMonthSchema.safeParse(month({ anomalyKind: "baseline_difference" }));
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path.join("."))).toContain("baselineVersion");
    expect(
      outlookMonthSchema.safeParse(
        month({ anomalyKind: "baseline_difference", baselineVersion: ERA5 }),
      ).success,
    ).toBe(true);
  });
});

describe("12-month horizon — F-03", () => {
  const FIRST_MONTH = "2026-11-01";
  const ERA5 = "ERA5:1991-2020:v1";

  // No validation: an invalid lead month must still produce a parseable object so
  // the schema, not the helper, is what rejects it.
  const shiftMonth = (addMonths: number) => {
    const total = 2026 * 12 + 10 + addMonths;
    const year = Math.floor(total / 12);
    const monthOfYear = (total % 12) + 1;
    return `${year}-${String(monthOfYear).padStart(2, "0")}-01`;
  };

  const entryFor = (leadMonth: number) => {
    const dataClass =
      leadMonth <= 2 ? "weather_forecast" : leadMonth <= 7 ? "seasonal_forecast" : "climatology";
    const isClimatology = dataClass === "climatology";
    return {
      leadMonth,
      month: shiftMonth(leadMonth - 1),
      dataClass,
      evaluationBasis: isClimatology ? "climatology" : "monthly",
      valueMm: 120,
      missingReason: isClimatology ? "beyond_horizon" : null,
      baselineVersion: isClimatology ? ERA5 : null,
      anomalyKind: null,
      ensembleSpreadMm: 8,
      spreadUnavailableReason: null,
    };
  };
  const twelve = () => Array.from({ length: 12 }, (_unused, index) => entryFor(index + 1));
  const horizon = (months: readonly unknown[]) => ({ firstMonth: FIRST_MONTH, months });

  it("defines the horizon as exactly lead months 1–12", () => {
    expect(LEAD_MONTHS).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    expect(permittedMonthlyDataClasses(1).length).toBeGreaterThan(0);
    expect(permittedMonthlyDataClasses(12).length).toBeGreaterThan(0);
    expect(permittedMonthlyDataClasses(0)).toEqual([]);
    expect(permittedMonthlyDataClasses(13)).toEqual([]);
  });

  it("accepts lead month 1 and lead month 12, rejects 0 and 13", () => {
    expect(outlookMonthSchema.safeParse(entryFor(1)).success).toBe(true);
    expect(outlookMonthSchema.safeParse(entryFor(12)).success).toBe(true);
    expect(outlookMonthSchema.safeParse(entryFor(0)).success).toBe(false);
    expect(outlookMonthSchema.safeParse(entryFor(13)).success).toBe(false);
  });

  it("rejects a month key that is not the first of its calendar month", () => {
    expect(outlookMonthSchema.safeParse(entryFor(1)).success).toBe(true);
    expect(outlookMonthSchema.safeParse({ ...entryFor(1), month: "2026-11-15" }).success).toBe(
      false,
    );
  });

  it("accepts a complete twelve-month horizon", () => {
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(twelve())).success).toBe(true);
  });

  it("rejects eleven entries and thirteen entries", () => {
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(twelve().slice(0, 11))).success).toBe(
      false,
    );
    expect(
      monthlyOutlookHorizonSchema.safeParse(
        horizon(Array.from({ length: 13 }, (_unused, index) => entryFor(Math.min(index + 1, 12)))),
      ).success,
    ).toBe(false);
  });

  it("rejects a duplicate lead month", () => {
    const months = twelve().map((month, index) =>
      index === 3 ? { ...month, leadMonth: 2 } : month,
    );
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(months)).success).toBe(false);
  });

  it("rejects a missing lead month", () => {
    const months = twelve().map((month, index) =>
      index >= 4
        ? {
            ...month,
            leadMonth: month.leadMonth + 1,
            month: shiftMonth(month.leadMonth),
          }
        : month,
    );
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(months)).success).toBe(false);
  });

  it("rejects out-of-order entries", () => {
    const ordered = twelve();
    const swapped = ordered.map((month, index) =>
      index === 0
        ? (ordered[1] as (typeof ordered)[number])
        : index === 1
          ? (ordered[0] as (typeof ordered)[number])
          : month,
    );
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(swapped)).success).toBe(false);
  });

  it("rejects a month bound to the wrong calendar month", () => {
    const months = twelve().map((month, index) =>
      index === 0 ? { ...month, month: "2027-01-01" } : month,
    );
    expect(monthlyOutlookHorizonSchema.safeParse(horizon(months)).success).toBe(false);
  });

  it("maps lead months across a year rollover", () => {
    expect(calendarMonthOf("2026-11-01", 1)).toBe("2026-11-01");
    expect(calendarMonthOf("2026-11-01", 2)).toBe("2026-12-01");
    expect(calendarMonthOf("2026-11-01", 3)).toBe("2027-01-01");
    expect(calendarMonthOf("2026-11-01", 12)).toBe("2027-10-01");
    expect(calendarMonthOf("2026-12-01", 2)).toBe("2027-01-01");
    expect(calendarMonthOf("2027-02-01", 11)).toBe("2027-12-01");
    expect(calendarMonthOf("2027-02-01", 12)).toBe("2028-01-01");
    expect(() => calendarMonthOf("2026-11-01", 0)).toThrow(RangeError);
    expect(() => calendarMonthOf("2026-11-01", 13)).toThrow(RangeError);
    expect(() => calendarMonthOf("2026-11-15", 1)).toThrow(RangeError);
  });

  it("keeps a failed forecast month pending instead of substituting climatology", () => {
    const months = twelve().map((month, index) =>
      index === 2
        ? {
            ...month,
            dataClass: null,
            evaluationBasis: "monthly",
            valueMm: null,
            missingReason: "ingest_failed",
            baselineVersion: null,
            ensembleSpreadMm: null,
            spreadUnavailableReason: "ingest_failed",
          }
        : month,
    );
    const result = monthlyOutlookHorizonSchema.safeParse(horizon(months));
    expect(result.success).toBe(true);
    expect(result.data?.months[2]?.dataClass).toBeNull();
    expect(result.data?.months[2]?.missingReason).toBe("ingest_failed");
  });
});

describe("Monthly classification vs daily bands", () => {
  const forecastMonth = (leadMonth: number, dataClass: string) => ({
    leadMonth,
    month: calendarMonthOf("2026-11-01", leadMonth),
    dataClass,
    evaluationBasis: "monthly",
    valueMm: 150,
    missingReason: null,
    baselineVersion: null,
    anomalyKind: null,
    ensembleSpreadMm: 6,
    spreadUnavailableReason: null,
  });

  it("accepts every product class that can cover lead month 1", () => {
    for (const dataClass of ["weather_forecast", "subseasonal_forecast", "seasonal_forecast"]) {
      expect(outlookMonthSchema.safeParse(forecastMonth(1, dataClass)).success).toBe(true);
    }
  });

  it("accepts a seasonal product at lead month 2, which runs past day 45", () => {
    expect(outlookMonthSchema.safeParse(forecastMonth(2, "seasonal_forecast")).success).toBe(true);
  });

  it("accepts a subseasonal product at lead month 2", () => {
    expect(outlookMonthSchema.safeParse(forecastMonth(2, "subseasonal_forecast")).success).toBe(
      true,
    );
  });

  it("rejects short-range classes once the seasonal band starts", () => {
    expect(outlookMonthSchema.safeParse(forecastMonth(3, "weather_forecast")).success).toBe(false);
    expect(outlookMonthSchema.safeParse(forecastMonth(3, "subseasonal_forecast")).success).toBe(
      false,
    );
    expect(outlookMonthSchema.safeParse(forecastMonth(3, "seasonal_forecast")).success).toBe(true);
  });

  it("represents one source product per month, not a blend", () => {
    // The row has a single `dataClass`; a multi-class month is unrepresentable, which
    // is the documented rule (`climate-data-foundation.md` §5.5 rule 4).
    const blended = {
      ...forecastMonth(2, "subseasonal_forecast"),
      dataClasses: ["seasonal_forecast"],
    };
    expect(outlookMonthSchema.safeParse(blended).success).toBe(false);
  });

  it("keeps a partially covered month out of the forecast classes only by refusing a value", () => {
    const partial = {
      ...forecastMonth(2, "subseasonal_forecast"),
      valueMm: null,
      dataClass: null,
      evaluationBasis: "monthly",
      missingReason: "below_coverage_threshold",
      ensembleSpreadMm: null,
      spreadUnavailableReason: "below_coverage_threshold",
    };
    expect(outlookMonthSchema.safeParse(partial).success).toBe(true);
  });
});
