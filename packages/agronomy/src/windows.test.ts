import type { Constraint, EvidenceSegment, GrowthStage } from "@agroclimate/contracts";
import { describe, expect, it } from "vitest";

import { SuitabilityInputError } from "./suitability.js";
import { WindowGenerationError, WindowPartitionError, generatePlantingWindows } from "./windows.js";

const padiStages: readonly GrowthStage[] = [
  {
    id: "stage-veg",
    name: "Vegetatif",
    startDayOffset: 0,
    endDayOffset: 49,
    isCritical: false,
    requirementProfile: null,
  },
  {
    id: "stage-repro",
    name: "Reproduktif",
    startDayOffset: 50,
    endDayOffset: 84,
    isCritical: true,
    requirementProfile: "Fase kritis kebutuhan air",
  },
  {
    id: "stage-ripen",
    name: "Pemasakan",
    startDayOffset: 85,
    endDayOffset: 114,
    isCritical: false,
    requirementProfile: null,
  },
];

const padiConstraints: readonly Constraint[] = [
  {
    id: "c-water-hard",
    dimension: "water",
    severity: "hard",
    grade: "A",
    comparator: "min",
    thresholdLower: 100,
    thresholdUpper: null,
    thresholdCount: null,
    unit: "mm",
    growthStageId: "stage-repro",
  },
  {
    id: "c-climate-soft",
    dimension: "climate",
    severity: "soft",
    grade: "B",
    comparator: "range",
    thresholdLower: 22,
    thresholdUpper: 32,
    thresholdCount: null,
    unit: "degC",
    growthStageId: null,
  },
];

const kedelaiStages: readonly GrowthStage[] = [
  {
    id: "kedelai-veg",
    name: "Vegetatif",
    startDayOffset: 0,
    endDayOffset: 34,
    isCritical: false,
    requirementProfile: null,
  },
  {
    id: "kedelai-flower",
    name: "Pembungaan",
    startDayOffset: 35,
    endDayOffset: 54,
    isCritical: true,
    requirementProfile: null,
  },
  {
    id: "kedelai-pod",
    name: "Pengisian Polong",
    startDayOffset: 55,
    endDayOffset: 84,
    isCritical: false,
    requirementProfile: null,
  },
];

const kedelaiConstraints: readonly Constraint[] = [
  {
    id: "c-kedelai-soil-ph",
    dimension: "soil",
    severity: "soft",
    grade: "A",
    comparator: "range",
    thresholdLower: 5.5,
    thresholdUpper: 7.0,
    thresholdCount: null,
    unit: "pH",
    growthStageId: null,
  },
  {
    id: "c-kedelai-temp",
    dimension: "climate",
    severity: "soft",
    grade: "A",
    comparator: "range",
    thresholdLower: 23,
    thresholdUpper: 30,
    thresholdCount: null,
    unit: "degC",
    growthStageId: "kedelai-flower",
  },
];

function makeSegment(
  startDate: string,
  endDate: string,
  options: {
    basis?: EvidenceSegment["evaluationBasis"];
    evidenceClass?: EvidenceSegment["evidenceClass"];
    coveragePercent?: number;
  } = {},
): EvidenceSegment {
  const basis = options.basis ?? "monthly";
  const evidenceClass =
    options.evidenceClass ??
    (basis === "climatology"
      ? "climatology"
      : basis === "daily"
        ? "weather_forecast"
        : "seasonal_forecast");

  return {
    startDate,
    endDate,
    evaluationBasis: basis,
    evidenceClass,
    coveragePercent: options.coveragePercent ?? 100,
    provenance:
      evidenceClass === "climatology"
        ? { kind: "climatology", baselineVersion: "ERA5:1991-2020:v1" }
        : {
            kind: "forecast",
            forecastRunIds: ["run-1"],
            ingestionRunIds: ["ing-1"],
            initializedAt: "2026-11-28T00:00:00Z",
          },
  };
}

describe("generatePlantingWindows", () => {
  it("returns empty array when no candidates are provided and rulebook is non-empty", () => {
    expect(
      generatePlantingWindows({
        constraints: padiConstraints,
        stages: padiStages,
        durationDays: 115,
        candidates: [],
      }),
    ).toEqual([]);
  });

  it("ranks suitable > conditional > insufficient_data > unsuitable deterministically", () => {
    const windows = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 115,
      candidates: [
        {
          startDate: "2026-12-01", // unsuitable (hard gate fails)
          observations: new Map([
            ["c-water-hard", 50],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2026-12-01", "2027-03-25")],
          missingRanges: [],
        },
        {
          startDate: "2026-12-08", // insufficient_data (hard gate unknown)
          observations: new Map([
            ["c-water-hard", null],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2026-12-08", "2027-04-01")],
          missingRanges: [],
        },
        {
          startDate: "2026-12-15", // conditional (climatology on critical stage)
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "climatology",
          evidenceSegments: [makeSegment("2026-12-15", "2027-04-08", { basis: "climatology" })],
          missingRanges: [],
        },
        {
          startDate: "2026-12-22", // suitable
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2026-12-22", "2027-04-15")],
          missingRanges: [],
        },
      ],
    });

    expect(windows.map((w) => [w.rank, w.windowStart, w.assessment.verdict])).toEqual([
      [1, "2026-12-22", "suitable"],
      [2, "2026-12-15", "conditional"],
      [3, "2026-12-08", "insufficient_data"],
      [4, "2026-12-01", "unsuitable"],
    ]);
    expect(windows[0]?.windowEnd).toBe("2027-04-15");
    expect(windows[0]?.evaluationBasis).toBe("monthly");
    expect(windows[0]?.weakestEvidenceClass).toBe("seasonal_forecast");
    expect(windows[0]?.criticalStages).toHaveLength(1);
    expect(windows[0]?.criticalStages[0]?.startDate).toBe("2027-02-10");
  });

  it("is invariant to candidate input ordering (deterministic repeatability)", () => {
    const baseCandidates = [
      {
        startDate: "2026-12-01",
        observations: new Map<string, number | null>([
          ["c-water-hard", 120],
          ["c-climate-soft", 27],
        ]),
        primaryBasis: "monthly" as const,
        evidenceSegments: [makeSegment("2026-12-01", "2026-12-10")],
        missingRanges: [],
      },
      {
        startDate: "2026-12-05",
        observations: new Map<string, number | null>([
          ["c-water-hard", 120],
          ["c-climate-soft", 35], // soft violation -> conditional
        ]),
        primaryBasis: "monthly" as const,
        evidenceSegments: [makeSegment("2026-12-05", "2026-12-14")],
        missingRanges: [],
      },
      {
        startDate: "2026-12-10",
        observations: new Map<string, number | null>([
          ["c-water-hard", 80], // hard violation -> unsuitable
          ["c-climate-soft", 27],
        ]),
        primaryBasis: "monthly" as const,
        evidenceSegments: [makeSegment("2026-12-10", "2026-12-19")],
        missingRanges: [],
      },
    ];

    const forward = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: baseCandidates,
    });
    const reversed = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [...baseCandidates].reverse(),
    });

    expect(reversed).toEqual(forward);
  });

  it("breaks ties deterministically by basis, weakestEvidenceClass, and then earlier startDate", () => {
    const windows = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [
        {
          startDate: "2026-12-10",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2026-12-10", "2026-12-19", { basis: "monthly" })],
          missingRanges: [],
        },
        {
          startDate: "2026-12-05",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2026-12-05", "2026-12-14", { basis: "monthly" })],
          missingRanges: [],
        },
        {
          startDate: "2026-12-15",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "daily",
          evidenceSegments: [
            makeSegment("2026-12-15", "2026-12-24", {
              basis: "daily",
              evidenceClass: "subseasonal_forecast",
            }),
          ],
          missingRanges: [],
        },
        {
          startDate: "2026-12-20",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "daily",
          evidenceSegments: [
            makeSegment("2026-12-20", "2026-12-29", {
              basis: "daily",
              evidenceClass: "weather_forecast",
            }),
          ],
          missingRanges: [],
        },
      ],
    });

    expect(windows.map((w) => w.windowStart)).toEqual([
      "2026-12-20", // daily + weather_forecast beats daily + subseasonal_forecast
      "2026-12-15",
      "2026-12-05", // earlier date wins tie between identical monthly windows
      "2026-12-10",
    ]);
  });

  it("derives mixedEvidence strictly from distinct evidenceClasses and derives evaluationBasis from segments", () => {
    const twoClassesOneBasis = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [
        {
          startDate: "2026-12-01",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "daily",
          evidenceSegments: [
            makeSegment("2026-12-01", "2026-12-05", {
              basis: "daily",
              evidenceClass: "weather_forecast",
            }),
            makeSegment("2026-12-06", "2026-12-10", {
              basis: "daily",
              evidenceClass: "subseasonal_forecast",
            }),
          ],
          missingRanges: [],
        },
      ],
    });

    expect(twoClassesOneBasis[0]?.evaluationBasis).toBe("daily");
    expect(twoClassesOneBasis[0]?.mixedEvidence).toBe(true);
    expect(twoClassesOneBasis[0]?.weakestEvidenceClass).toBe("subseasonal_forecast");

    const oneClassWithMissing = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [
        {
          startDate: "2026-12-01",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "daily",
          evidenceSegments: [
            makeSegment("2026-12-01", "2026-12-05", {
              basis: "daily",
              evidenceClass: "weather_forecast",
            }),
          ],
          missingRanges: [
            {
              startDate: "2026-12-06",
              endDate: "2026-12-10",
              reason: "beyond_horizon",
            },
          ],
        },
      ],
    });

    expect(oneClassWithMissing[0]?.evaluationBasis).toBe("daily");
    expect(oneClassWithMissing[0]?.mixedEvidence).toBe(false);
    expect(oneClassWithMissing[0]?.weakestEvidenceClass).toBe("weather_forecast");

    const mixedBases = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [
        {
          startDate: "2026-12-01",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [
            makeSegment("2026-12-01", "2026-12-05", {
              basis: "daily",
              evidenceClass: "weather_forecast",
            }),
            makeSegment("2026-12-06", "2026-12-10", {
              basis: "monthly",
              evidenceClass: "seasonal_forecast",
            }),
          ],
          missingRanges: [],
        },
      ],
    });

    expect(mixedBases[0]?.evaluationBasis).toBe("mixed");
    expect(mixedBases[0]?.mixedEvidence).toBe(true);
    expect(mixedBases[0]?.weakestEvidenceClass).toBe("seasonal_forecast");
  });

  it("sorts evidenceSegments and missingRanges chronologically without mutating caller arrays", () => {
    const segLate = makeSegment("2026-12-06", "2026-12-10", {
      basis: "monthly",
      evidenceClass: "seasonal_forecast",
    });
    const segEarly = makeSegment("2026-12-01", "2026-12-05", {
      basis: "daily",
      evidenceClass: "weather_forecast",
    });
    const inputSegments = [segLate, segEarly];

    const windows = generatePlantingWindows({
      constraints: padiConstraints,
      stages: padiStages,
      durationDays: 10,
      candidates: [
        {
          startDate: "2026-12-01",
          observations: new Map([
            ["c-water-hard", 120],
            ["c-climate-soft", 27],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: inputSegments,
          missingRanges: [],
        },
      ],
    });

    expect(windows[0]?.evidenceSegments.map((s) => s.startDate)).toEqual([
      "2026-12-01",
      "2026-12-06",
    ]);
    expect(inputSegments.map((s) => s.startDate)).toEqual(["2026-12-06", "2026-12-01"]);
  });

  it("handles seeded-crop scenario without water rule (kedelai) and preserves overlapping windows", () => {
    const windows = generatePlantingWindows({
      constraints: kedelaiConstraints,
      stages: kedelaiStages,
      durationDays: 85,
      candidates: [
        {
          // Overlaps with next candidate; climatology on critical stage -> conditional
          startDate: "2027-01-01",
          observations: new Map([
            ["c-kedelai-soil-ph", 6.2],
            ["c-kedelai-temp", 26],
          ]),
          primaryBasis: "climatology",
          evidenceSegments: [
            makeSegment("2027-01-01", "2027-03-26", {
              basis: "climatology",
              evidenceClass: "climatology",
            }),
          ],
          missingRanges: [],
        },
        {
          // Overlaps; seasonal forecast -> suitable, with water: not_applicable
          startDate: "2027-01-15",
          observations: new Map([
            ["c-kedelai-soil-ph", 6.2],
            ["c-kedelai-temp", 26],
          ]),
          primaryBasis: "monthly",
          evidenceSegments: [makeSegment("2027-01-15", "2027-04-09", { basis: "monthly" })],
          missingRanges: [],
        },
      ],
    });

    expect(windows).toHaveLength(2);
    expect(windows[0]?.windowStart).toBe("2027-01-15");
    expect(windows[0]?.assessment.verdict).toBe("suitable");
    expect(
      windows[0]?.assessment.dimensionCoverage.find((d) => d.dimension === "water")?.state,
    ).toBe("not_applicable");
    expect(windows[1]?.windowStart).toBe("2027-01-01");
    expect(windows[1]?.assessment.verdict).toBe("conditional");
  });

  it("refuses an all-missing window with no evidence segments", () => {
    let caught: unknown;
    try {
      generatePlantingWindows({
        constraints: padiConstraints,
        stages: padiStages,
        durationDays: 10,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: new Map([
              ["c-water-hard", 120],
              ["c-climate-soft", 27],
            ]),
            primaryBasis: "daily",
            evidenceSegments: [],
            missingRanges: [
              {
                startDate: "2026-12-01",
                endDate: "2026-12-10",
                reason: "beyond_horizon",
              },
            ],
          },
        ],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WindowGenerationError);
    expect((caught as WindowGenerationError).code).toBe("no_evidence_segments");
  });

  it("refuses primaryBasis finer than critical-stage evidence", () => {
    let caught: unknown;
    try {
      generatePlantingWindows({
        constraints: padiConstraints,
        stages: padiStages,
        durationDays: 115,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: new Map([
              ["c-water-hard", 120],
              ["c-climate-soft", 27],
            ]),
            // Critical stage (day 50..84) sits in climatology segment, so daily is dishonest
            primaryBasis: "daily",
            evidenceSegments: [
              makeSegment("2026-12-01", "2027-01-15", {
                basis: "daily",
                evidenceClass: "weather_forecast",
              }),
              makeSegment("2027-01-16", "2027-03-25", {
                basis: "climatology",
                evidenceClass: "climatology",
              }),
            ],
            missingRanges: [],
          },
        ],
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(WindowGenerationError);
    expect((caught as WindowGenerationError).code).toBe("inconsistent_primary_basis");
  });

  it("refuses an invalid EvidenceSegment partition", () => {
    expect(() =>
      generatePlantingWindows({
        constraints: padiConstraints,
        stages: padiStages,
        durationDays: 10,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: new Map([
              ["c-water-hard", 120],
              ["c-climate-soft", 27],
            ]),
            primaryBasis: "daily",
            // Ends 2026-12-08 instead of 2026-12-10 (gap/span violation)
            evidenceSegments: [makeSegment("2026-12-01", "2026-12-08", { basis: "daily" })],
            missingRanges: [],
          },
        ],
      }),
    ).toThrow(WindowPartitionError);
  });

  it("refuses invalid durationDays, invalid startDate, and duplicate candidate startDates", () => {
    for (const badDuration of [0, -5, 1.5, Number.NaN]) {
      expect(() =>
        generatePlantingWindows({
          constraints: padiConstraints,
          stages: padiStages,
          durationDays: badDuration,
          candidates: [],
        }),
      ).toThrow(WindowGenerationError);
    }

    for (const badDate of ["2026-02-30", "not-a-date"]) {
      let caught: unknown;
      try {
        generatePlantingWindows({
          constraints: padiConstraints,
          stages: padiStages,
          durationDays: 10,
          candidates: [
            {
              startDate: badDate,
              observations: new Map([["c-water-hard", 120]]),
              primaryBasis: "daily",
              evidenceSegments: [makeSegment("2026-12-01", "2026-12-10", { basis: "daily" })],
              missingRanges: [],
            },
          ],
        });
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(WindowGenerationError);
      expect((caught as WindowGenerationError).code).toBe("invalid_start_date");
    }

    expect(() =>
      generatePlantingWindows({
        constraints: padiConstraints,
        stages: padiStages,
        durationDays: 10,
        candidates: [
          {
            startDate: "2026-12-01",
            observations: new Map([["c-water-hard", 120]]),
            primaryBasis: "daily",
            evidenceSegments: [makeSegment("2026-12-01", "2026-12-10", { basis: "daily" })],
            missingRanges: [],
          },
          {
            startDate: "2026-12-01",
            observations: new Map([["c-water-hard", 120]]),
            primaryBasis: "daily",
            evidenceSegments: [makeSegment("2026-12-01", "2026-12-10", { basis: "daily" })],
            missingRanges: [],
          },
        ],
      }),
    ).toThrow(WindowGenerationError);
  });

  it("refuses empty rulebook even when candidates is empty", () => {
    expect(() =>
      generatePlantingWindows({
        constraints: [],
        stages: padiStages,
        durationDays: 10,
        candidates: [],
      }),
    ).toThrow(SuitabilityInputError);
  });
});
