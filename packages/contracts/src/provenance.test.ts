import { describe, expect, it } from "vitest";
import {
  derivationDescriptorSchema,
  dataInputRefSchema,
  fieldSnapshotPayloadSchema,
  fieldSnapshotSchema,
} from "../src/provenance.js";

const forecastRef = {
  kind: "forecast",
  role: "seasonal",
  purpose: "input",
  forecastRunIds: ["0192f0aa-0000-7000-8000-000000000001"],
  ingestionRunIds: ["0192f0aa-0000-7000-8000-000000000002"],
  recordSetHash: "a".repeat(64),
} as const;

const baselineRef = {
  kind: "baseline",
  role: "climatology",
  purpose: "input",
  baselineVersion: "ERA5:1991-2020:v1",
  baselineHash: "b".repeat(64),
  cellKeys: ["cell-a"],
} as const;

const snapshotPayload = {
  fieldId: "0192f0aa-0000-7000-8000-000000000003",
  geometryHash: "c".repeat(64),
  areaHa: 1.4,
  elevationM: 12,
  soilType: null,
  soilPh: 6.1,
  drainageClass: "moderate",
  irrigationAvailable: false,
  irrigationSource: null,
  extractionPolicy: "centroid",
  resolvedCells: [
    {
      provider: "open-meteo",
      model: "ecmwf_ifs025",
      cellKey: "cell-a",
      servedLat: -6.323185,
      servedLon: 106.68874,
      distanceKm: 2.4,
    },
  ],
  observationsUsed: [],
} as const;

describe("DataInputRef", () => {
  it("accepts a forecast ref", () => {
    expect(dataInputRefSchema.safeParse(forecastRef).success).toBe(true);
  });

  it("accepts a baseline ref", () => {
    expect(dataInputRefSchema.safeParse(baselineRef).success).toBe(true);
  });

  it("rejects a baseline ref carrying run ids", () => {
    expect(dataInputRefSchema.safeParse({ ...baselineRef, forecastRunIds: ["x"] }).success).toBe(
      false,
    );
  });

  it("rejects an empty run id array", () => {
    expect(dataInputRefSchema.safeParse({ ...forecastRef, forecastRunIds: [] }).success).toBe(
      false,
    );
  });

  it("rejects an unknown kind", () => {
    expect(dataInputRefSchema.safeParse({ ...forecastRef, kind: "model" }).success).toBe(false);
  });

  it("rejects verification truth smuggled in as a role", () => {
    expect(
      dataInputRefSchema.safeParse({ ...forecastRef, role: "verification_truth" }).success,
    ).toBe(false);
  });
});

describe("DerivationDescriptor", () => {
  const hashes = {
    fieldSnapshotHash: "d".repeat(64),
    profileVersionId: "crop-padi-v1",
    engineVersion: "0.1.0",
    derivationVersion: "1",
  };

  const variants = [
    { artifact: "monthly_outlook", inputRefs: [forecastRef, baselineRef], derivationVersion: "1" },
    { artifact: "suitability_run", inputRefs: [forecastRef], ...hashes },
    { artifact: "planting_window", inputRefs: [forecastRef], ...hashes },
    {
      artifact: "ai_briefing",
      inputRefs: [forecastRef],
      fieldSnapshotHash: hashes.fieldSnapshotHash,
      sourceArtifactHashes: ["e".repeat(64)],
      promptVersion: "briefing-v1",
      modelId: "model-x",
      derivationVersion: "1",
    },
  ] as const;

  it.each(variants)("accepts the $artifact variant", (variant) => {
    expect(derivationDescriptorSchema.safeParse(variant).success).toBe(true);
  });

  it("rejects an unknown artifact discriminator", () => {
    expect(
      derivationDescriptorSchema.safeParse({ ...variants[1], artifact: "window" }).success,
    ).toBe(false);
  });

  it("rejects a planting_window missing engineVersion", () => {
    const { engineVersion: _omitted, ...partial } = variants[2];
    expect(derivationDescriptorSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a monthly_outlook carrying field state", () => {
    expect(
      derivationDescriptorSchema.safeParse({ ...variants[0], fieldSnapshotHash: "f".repeat(64) })
        .success,
    ).toBe(false);
  });

  it("does not let one artifact be read as another", () => {
    const parsed = derivationDescriptorSchema.parse(variants[1]);
    expect(parsed.artifact).toBe("suitability_run");
  });
});

describe("FieldSnapshot", () => {
  it("accepts the payload without a hash", () => {
    expect(fieldSnapshotPayloadSchema.safeParse(snapshotPayload).success).toBe(true);
  });

  it("rejects the payload carrying its own hash", () => {
    expect(
      fieldSnapshotPayloadSchema.safeParse({
        ...snapshotPayload,
        fieldSnapshotHash: "1".repeat(64),
      }).success,
    ).toBe(false);
  });

  it("accepts the persisted snapshot with the hash", () => {
    expect(
      fieldSnapshotSchema.safeParse({ ...snapshotPayload, fieldSnapshotHash: "1".repeat(64) })
        .success,
    ).toBe(true);
  });

  it("keeps null distinct from a default", () => {
    const parsed = fieldSnapshotPayloadSchema.parse(snapshotPayload);
    expect(parsed.soilType).toBeNull();
    expect(parsed.soilPh).toBe(6.1);
  });

  it("payload type carries no hash field at runtime", () => {
    const parsed = fieldSnapshotPayloadSchema.parse(snapshotPayload);
    expect("fieldSnapshotHash" in parsed).toBe(false);
    expect(parsed.areaHa).toBe(1.4);
  });
});
