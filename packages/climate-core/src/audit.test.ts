import { describe, expect, it } from "vitest";

import {
  auditClimate,
  auditRunRefs,
  reconcileCoverage,
  recordKey,
  type StoredRecordRef,
} from "./audit.js";

const record = (cellKey: string, variable: string, validAt: string): StoredRecordRef => ({
  cellKey,
  variable,
  validAt,
});

const artifact = (overrides: Partial<Parameters<typeof auditRunRefs>[0]["artifacts"][number]>) => ({
  artifact: "monthly_outlook",
  artifactId: "artifact-1",
  forecastRunIds: ["run-1"],
  ingestionRunIds: ["ing-1"],
  ...overrides,
});

describe("auditRunRefs — an orphan reference is reported, never repaired", () => {
  it("finds nothing when every claimed run exists", () => {
    expect(
      auditRunRefs({
        artifacts: [artifact({})],
        knownForecastRunIds: new Set(["run-1"]),
        knownIngestionRunIds: new Set(["ing-1"]),
      }),
    ).toEqual([]);
  });

  it("names the artifact and the id that does not exist", () => {
    const findings = auditRunRefs({
      artifacts: [artifact({ artifactId: "outlook-42", forecastRunIds: ["run-1", "run-404"] })],
      knownForecastRunIds: new Set(["run-1"]),
      knownIngestionRunIds: new Set(["ing-1"]),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      code: "dangling_forecast_run",
      artifactId: "outlook-42",
      key: "run-404",
    });
  });

  it("reports an orphan ingestion run separately from an orphan forecast run", () => {
    const findings = auditRunRefs({
      artifacts: [artifact({ forecastRunIds: ["run-404"], ingestionRunIds: ["ing-404"] })],
      knownForecastRunIds: new Set<string>(),
      knownIngestionRunIds: new Set<string>(),
    });

    expect(findings.map((finding) => finding.code)).toEqual([
      "dangling_forecast_run",
      "dangling_ingestion_run",
    ]);
  });

  it("reports every artifact that carries the same orphan", () => {
    const findings = auditRunRefs({
      artifacts: [
        artifact({ artifactId: "a-1", forecastRunIds: ["run-404"] }),
        artifact({ artifactId: "a-2", forecastRunIds: ["run-404"] }),
      ],
      knownForecastRunIds: new Set<string>(),
      knownIngestionRunIds: new Set(["ing-1"]),
    });

    expect(findings.map((finding) => finding.artifactId)).toEqual(["a-1", "a-2"]);
  });
});

describe("reconcileCoverage — expected versus stored", () => {
  const expected = [
    record("cell-a", "precipitation_sum", "2026-11-01T00:00:00.000Z"),
    record("cell-a", "precipitation_sum", "2026-11-02T00:00:00.000Z"),
  ];

  it("reconciles when every expected record is present", () => {
    const result = reconcileCoverage({ expected, present: expected });

    expect(result).toMatchObject({ expected: 2, present: 2, unexpected: 0 });
    expect(result.findings).toEqual([]);
  });

  it("reports a day the provider never delivered", () => {
    const result = reconcileCoverage({ expected, present: [expected[0] as StoredRecordRef] });

    expect(result.findings).toEqual([
      {
        code: "missing_record",
        key: "cell-a|precipitation_sum|2026-11-02T00:00:00.000Z",
        detail: "expected record was never stored",
      },
    ]);
  });

  it("counts a duplicated record once and reports the repetition", () => {
    const result = reconcileCoverage({
      expected,
      present: [
        expected[0] as StoredRecordRef,
        expected[0] as StoredRecordRef,
        expected[1] as StoredRecordRef,
      ],
    });

    expect(result).toMatchObject({ expected: 2, present: 2 });
    expect(result.findings.map((finding) => finding.code)).toEqual(["duplicate_record"]);
  });

  it("separates an extra stored record from a missing one", () => {
    const extra = record("cell-b", "precipitation_sum", "2026-11-01T00:00:00.000Z");
    const result = reconcileCoverage({ expected, present: [...expected, extra] });

    expect(result.unexpected).toBe(1);
    expect(result.findings.map((finding) => finding.code)).toEqual(["unexpected_record"]);
  });

  it("keys on cell, variable and instant together", () => {
    const otherVariable = record("cell-a", "temperature_2m_mean", "2026-11-01T00:00:00.000Z");
    const result = reconcileCoverage({
      expected,
      present: [expected[0] as StoredRecordRef, otherVariable],
    });

    expect(result.findings.map((finding) => finding.key)).toEqual([
      "cell-a|temperature_2m_mean|2026-11-01T00:00:00.000Z",
      "cell-a|precipitation_sum|2026-11-02T00:00:00.000Z",
    ]);
  });
});

describe("auditClimate — one report, one verdict", () => {
  it("reconciles only when neither check finds anything", () => {
    const expected = [record("cell-a", "precipitation_sum", "2026-11-01T00:00:00.000Z")];

    const clean = auditClimate({
      artifacts: [artifact({})],
      knownForecastRunIds: new Set(["run-1"]),
      knownIngestionRunIds: new Set(["ing-1"]),
      expected,
      present: expected,
    });
    expect(clean.reconciles).toBe(true);

    const dangling = auditClimate({
      artifacts: [artifact({ forecastRunIds: ["run-404"] })],
      knownForecastRunIds: new Set(["run-1"]),
      knownIngestionRunIds: new Set(["ing-1"]),
      expected,
      present: expected,
    });
    expect(dangling.reconciles).toBe(false);

    const short = auditClimate({
      artifacts: [artifact({})],
      knownForecastRunIds: new Set(["run-1"]),
      knownIngestionRunIds: new Set(["ing-1"]),
      expected,
      present: [],
    });
    expect(short.reconciles).toBe(false);
  });

  it("leaves the input rows untouched", () => {
    const expected = [record("cell-a", "precipitation_sum", "2026-11-01T00:00:00.000Z")];
    const present = [...expected];
    const snapshot = structuredClone(present);

    auditClimate({
      artifacts: [artifact({ forecastRunIds: ["run-404"] })],
      knownForecastRunIds: new Set<string>(),
      knownIngestionRunIds: new Set<string>(),
      expected,
      present,
    });

    expect(present).toEqual(snapshot);
  });
});

describe("recordKey", () => {
  it("is stable and unambiguous for one record", () => {
    expect(recordKey(record("cell-a", "precipitation_sum", "2026-11-01T00:00:00.000Z"))).toBe(
      "cell-a|precipitation_sum|2026-11-01T00:00:00.000Z",
    );
  });
});
