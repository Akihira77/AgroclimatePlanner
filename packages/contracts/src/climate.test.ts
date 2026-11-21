import { describe, expect, it } from "vitest";
import {
  adapterResultSchema,
  forecastRunIdentitySchema,
  forecastRunSchema,
  ingestionRunIdentitySchema,
  ingestionRunSchema,
  ingestionVersionOf,
  monthlyOutlookSchema,
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
  it("maps lead months to the binding bands", () => {
    expect(permittedMonthlyDataClasses(0)).toEqual(["weather_forecast", "subseasonal_forecast"]);
    expect(permittedMonthlyDataClasses(2)).toEqual(["seasonal_forecast"]);
    expect(permittedMonthlyDataClasses(7)).toEqual(["seasonal_forecast"]);
    expect(permittedMonthlyDataClasses(8)).toEqual(["climatology"]);
    expect(permittedMonthlyDataClasses(12)).toEqual(["climatology"]);
    expect(permittedMonthlyDataClasses(13)).toEqual([]);
    expect(permittedMonthlyDataClasses(-1)).toEqual([]);
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
      missingReason: "ingest_failed",
      baselineVersion: "ERA5:1991-2020:v1",
    };
    expect(monthlyOutlookSchema.safeParse(failed).success).toBe(false);
    const noBaseline = {
      ...base,
      leadMonth: 9,
      dataClass: "climatology",
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
