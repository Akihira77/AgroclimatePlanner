import { describe, expect, it } from "vitest";
import { canonicalJson } from "../src/canonical.js";
import { hashDerivationDescriptor, hashFieldSnapshot, sha256Hex } from "../src/hash.js";
import type {
  DataInputRef,
  DerivationDescriptor,
  FieldSnapshotPayload,
} from "../src/provenance.js";

const payload: FieldSnapshotPayload = {
  fieldId: "field-1",
  geometryHash: "geom-hash-1",
  areaHa: 1.4,
  elevationM: 12,
  soilType: "clay",
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
      servedLat: -6.32,
      servedLon: 106.68,
      distanceKm: 1.2,
    },
    {
      provider: "ecmwf",
      model: "ecmwf_seas5",
      cellKey: "cell-b",
      servedLat: -6.22,
      servedLon: 106.78,
      distanceKm: 2.9,
    },
  ],
  observationsUsed: [
    {
      observationId: "obs-2",
      kind: "rain_gauge",
      value: 12.4,
      unit: "mm",
      observedAt: "2026-11-17T00:00:00Z",
    },
    {
      observationId: "obs-1",
      kind: "rain_gauge",
      value: 3.1,
      unit: "mm",
      observedAt: "2026-11-16T00:00:00Z",
    },
  ],
};

function forecastRef(
  forecastRunIds: [string, ...string[]],
  ingestionRunIds: [string, ...string[]] = ["ing-1"],
  recordSetHash = "rs-forecast",
): DataInputRef {
  return {
    kind: "forecast",
    role: "seasonal",
    purpose: "input",
    forecastRunIds,
    ingestionRunIds,
    recordSetHash,
  };
}

function baselineRef(
  cellKeys: [string, ...string[]],
  baselineVersion = "ERA5:1991-2020:v1",
): DataInputRef {
  return {
    kind: "baseline",
    role: "climatology",
    purpose: "input",
    baselineVersion,
    baselineHash: "bh-1",
    cellKeys,
  };
}

function datasetRef(datasetVersion = "ERA5:0.25deg:v1"): DataInputRef {
  return {
    kind: "dataset",
    role: "reanalysis",
    purpose: "input",
    datasetVersion,
    recordSetHash: "rs-dataset",
  };
}

function plantingWindow(
  overrides: {
    inputRefs?: DataInputRef[];
    fieldSnapshotHash?: string;
    profileVersionId?: string;
    engineVersion?: string;
    derivationVersion?: string;
  } = {},
): DerivationDescriptor {
  return {
    artifact: "planting_window",
    inputRefs: overrides.inputRefs ?? [forecastRef(["run-a"])],
    fieldSnapshotHash: overrides.fieldSnapshotHash ?? "snap-1",
    profileVersionId: overrides.profileVersionId ?? "padi-v1",
    engineVersion: overrides.engineVersion ?? "1.0.0",
    derivationVersion: overrides.derivationVersion ?? "1",
  };
}

function suitabilityRun(
  overrides: {
    inputRefs?: DataInputRef[];
    fieldSnapshotHash?: string;
    profileVersionId?: string;
    engineVersion?: string;
  } = {},
): DerivationDescriptor {
  return {
    artifact: "suitability_run",
    inputRefs: overrides.inputRefs ?? [forecastRef(["run-a"])],
    fieldSnapshotHash: overrides.fieldSnapshotHash ?? "snap-1",
    profileVersionId: overrides.profileVersionId ?? "padi-v1",
    engineVersion: overrides.engineVersion ?? "1.0.0",
    derivationVersion: "1",
  };
}

function aiBriefing(
  overrides: { sourceArtifactHashes?: string[]; promptVersion?: string; modelId?: string } = {},
): DerivationDescriptor {
  return {
    artifact: "ai_briefing",
    inputRefs: [forecastRef(["run-a"])],
    fieldSnapshotHash: "snap-1",
    sourceArtifactHashes: overrides.sourceArtifactHashes ?? ["hash-a"],
    promptVersion: overrides.promptVersion ?? "briefing-v1",
    modelId: overrides.modelId ?? "model-x",
    derivationVersion: "1",
  };
}

const snapshotHash = (overrides: Partial<FieldSnapshotPayload> = {}): string =>
  hashFieldSnapshot({ ...payload, ...overrides } as FieldSnapshotPayload);

describe("known-answer SHA-256", () => {
  // Digests from coreutils `sha256sum`, not from this implementation.
  it("matches the NIST vector for 'abc'", () => {
    expect(sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("matches the empty-string vector", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("hashes the canonical bytes of a known document", () => {
    expect(sha256Hex('{"a":1}')).toBe(
      "015abd7f5cc57a2dd94b7590f04ad8084273905ee33ec5cebeae62276a97f862",
    );
  });
});

describe("canonical JSON of a descriptor", () => {
  it("emits the expected bytes", () => {
    expect(
      canonicalJson({
        derivationVersion: "1",
        artifact: "monthly_outlook",
        inputRefs: [baselineRef(["cell-a"])],
      }),
    ).toBe(
      '{"artifact":"monthly_outlook","derivationVersion":"1","inputRefs":[{"baselineHash":"bh-1","baselineVersion":"ERA5:1991-2020:v1","cellKeys":["cell-a"],"kind":"baseline","purpose":"input","role":"climatology"}]}',
    );
  });
});

describe("object key permutation", () => {
  it("produces identical hash for shuffled key insertion order", () => {
    const reversed = Object.fromEntries(
      Object.entries(payload).reverse(),
    ) as unknown as FieldSnapshotPayload;
    expect(canonicalJson(reversed)).toBe(canonicalJson(payload));
    expect(hashFieldSnapshot(reversed)).toBe(hashFieldSnapshot(payload));
  });

  it("produces identical hash for shuffled descriptor keys", () => {
    const descriptor = plantingWindow();
    const reversed = Object.fromEntries(
      Object.entries(descriptor).reverse(),
    ) as unknown as DerivationDescriptor;
    expect(hashDerivationDescriptor(reversed)).toBe(hashDerivationDescriptor(descriptor));
  });
});

describe("array permutation", () => {
  it("ignores the order of resolvedCells", () => {
    expect(snapshotHash({ resolvedCells: [...payload.resolvedCells].reverse() })).toBe(
      hashFieldSnapshot(payload),
    );
  });

  it("ignores the order of observationsUsed", () => {
    expect(snapshotHash({ observationsUsed: [...payload.observationsUsed].reverse() })).toBe(
      hashFieldSnapshot(payload),
    );
  });

  it("ignores the order of inputRefs", () => {
    const refs = [forecastRef(["run-a"]), baselineRef(["cell-a"]), datasetRef()];
    expect(hashDerivationDescriptor(plantingWindow({ inputRefs: [...refs].reverse() }))).toBe(
      hashDerivationDescriptor(plantingWindow({ inputRefs: refs })),
    );
  });
});

describe("nested array permutation", () => {
  it("ignores forecastRunIds order", () => {
    const ordered = plantingWindow({ inputRefs: [forecastRef(["run-a", "run-b"])] });
    const shuffled = plantingWindow({ inputRefs: [forecastRef(["run-b", "run-a"])] });
    expect(shuffled).not.toEqual(ordered);
    expect(hashDerivationDescriptor(shuffled)).toBe(hashDerivationDescriptor(ordered));
  });

  it("ignores ingestionRunIds order", () => {
    const ordered = plantingWindow({
      inputRefs: [forecastRef(["run-a"], ["ing-1", "ing-2"])],
    });
    const shuffled = plantingWindow({
      inputRefs: [forecastRef(["run-a"], ["ing-2", "ing-1"])],
    });
    expect(hashDerivationDescriptor(shuffled)).toBe(hashDerivationDescriptor(ordered));
  });

  it("ignores cellKeys order", () => {
    const ordered = plantingWindow({ inputRefs: [baselineRef(["cell-a", "cell-b"])] });
    const shuffled = plantingWindow({ inputRefs: [baselineRef(["cell-b", "cell-a"])] });
    expect(hashDerivationDescriptor(shuffled)).toBe(hashDerivationDescriptor(ordered));
  });

  it("ignores observationIds order", () => {
    const ref = (observationIds: [string, ...string[]]): DataInputRef => ({
      kind: "observation",
      role: "field_observation",
      purpose: "input",
      observationIds,
      recordSetHash: "rs-obs",
    });
    expect(hashDerivationDescriptor(plantingWindow({ inputRefs: [ref(["obs-b", "obs-a"])] }))).toBe(
      hashDerivationDescriptor(plantingWindow({ inputRefs: [ref(["obs-a", "obs-b"])] })),
    );
  });
});

describe("combined permutation", () => {
  it("produces identical hash with every nested array shuffled at once", () => {
    const build = (
      cells: FieldSnapshotPayload["resolvedCells"],
      observations: FieldSnapshotPayload["observationsUsed"],
    ): FieldSnapshotPayload => ({
      ...payload,
      resolvedCells: cells,
      observationsUsed: observations,
    });

    const forward = hashFieldSnapshot(
      build(
        [payload.resolvedCells[0]!, payload.resolvedCells[1]!],
        [payload.observationsUsed[0]!, payload.observationsUsed[1]!],
      ),
    );
    const backward = hashFieldSnapshot(
      build(
        [payload.resolvedCells[1]!, payload.resolvedCells[0]!],
        [payload.observationsUsed[1]!, payload.observationsUsed[0]!],
      ),
    );
    expect(backward).toBe(forward);

    const descriptorForward = hashDerivationDescriptor(
      plantingWindow({
        inputRefs: [
          forecastRef(["run-b", "run-a"], ["ing-2", "ing-1"]),
          baselineRef(["cell-b", "cell-a"]),
        ],
      }),
    );
    const descriptorBackward = hashDerivationDescriptor(
      plantingWindow({
        inputRefs: [
          baselineRef(["cell-a", "cell-b"]),
          forecastRef(["run-a", "run-b"], ["ing-1", "ing-2"]),
        ],
      }),
    );
    expect(descriptorBackward).toBe(descriptorForward);
  });
});

describe("meaningful input changes", () => {
  const base = snapshotHash();
  it.each<[string, Partial<FieldSnapshotPayload>]>([
    ["fieldId", { fieldId: "field-2" }],
    ["geometryHash", { geometryHash: "geom-hash-2" }],
    ["areaHa", { areaHa: 1.5 }],
    ["elevationM", { elevationM: 13 }],
    ["soilType", { soilType: "sandy" }],
    ["soilPh", { soilPh: 6.2 }],
    ["drainageClass", { drainageClass: "poor" }],
    ["irrigationAvailable", { irrigationAvailable: true }],
    ["irrigationSource", { irrigationSource: "well" }],
    ["extractionPolicy", { extractionPolicy: "area_weighted" as const }],
    ["null becomes a value", { soilType: null }],
  ])("changes the snapshot hash when %s changes", (_label, overrides) => {
    expect(snapshotHash(overrides)).not.toBe(base);
  });

  it.each<[string, Parameters<typeof plantingWindow>[0]]>([
    ["profileVersionId", { profileVersionId: "padi-v2" }],
    ["engineVersion", { engineVersion: "1.0.1" }],
    ["derivationVersion", { derivationVersion: "2" }],
    ["fieldSnapshotHash", { fieldSnapshotHash: "snap-2" }],
    ["forecast run id", { inputRefs: [forecastRef(["run-b"])] }],
    ["dataset version", { inputRefs: [datasetRef("ERA5:0.25deg:v2")] }],
    ["baseline version", { inputRefs: [baselineRef(["cell-a"], "ERA5:1981-2010:v1")] }],
  ])("changes the descriptor hash when %s changes", (_label, overrides) => {
    const changed = plantingWindow(overrides);
    expect(hashDerivationDescriptor(changed)).not.toBe(hashDerivationDescriptor(plantingWindow()));
  });

  it("distinguishes a suitability run from a planting window with identical inputs", () => {
    expect(hashDerivationDescriptor(suitabilityRun())).not.toBe(
      hashDerivationDescriptor(plantingWindow()),
    );
  });

  it.each<[string, Parameters<typeof aiBriefing>[0]]>([
    ["sourceArtifactHashes", { sourceArtifactHashes: ["hash-b"] }],
    ["promptVersion", { promptVersion: "briefing-v2" }],
    ["modelId", { modelId: "model-y" }],
  ])("changes the briefing hash when %s changes", (_label, overrides) => {
    expect(hashDerivationDescriptor(aiBriefing(overrides))).not.toBe(
      hashDerivationDescriptor(aiBriefing()),
    );
  });
});

describe("deduplication", () => {
  it("treats identical duplicates as one entry", () => {
    expect(
      snapshotHash({ resolvedCells: [payload.resolvedCells[0]!, payload.resolvedCells[0]!] }),
    ).toBe(snapshotHash({ resolvedCells: [payload.resolvedCells[0]!] }));
  });

  it("refuses conflicting duplicates", () => {
    expect(() =>
      snapshotHash({
        observationsUsed: [
          payload.observationsUsed[0]!,
          { ...payload.observationsUsed[0]!, value: 99 },
        ],
      }),
    ).toThrow(/conflicting content/);
  });

  it("retains every inputRefs entry, duplicates included", () => {
    const ref = forecastRef(["run-a"]);
    const duplicated = plantingWindow({ inputRefs: [ref, { ...ref }] });
    expect(() => hashDerivationDescriptor(duplicated)).not.toThrow();
    expect(hashDerivationDescriptor(duplicated)).not.toBe(
      hashDerivationDescriptor(plantingWindow({ inputRefs: [ref] })),
    );
  });
});

describe("timestamp representation", () => {
  it("keeps two representations of the same instant distinct", () => {
    const withSeconds = snapshotHash();
    const withMillis = snapshotHash({
      observationsUsed: [
        { ...payload.observationsUsed[0]!, observedAt: "2026-11-17T00:00:00.000Z" },
        payload.observationsUsed[1]!,
      ],
    });
    expect(withMillis).not.toBe(withSeconds);
  });
});

describe("field snapshot preimage", () => {
  it("rejects a payload carrying its own hash", () => {
    expect(() =>
      hashFieldSnapshot({ ...payload, fieldSnapshotHash: "x" } as unknown as FieldSnapshotPayload),
    ).toThrow(/preimage/);
  });

  it("hashes the payload, not the persisted row", () => {
    const hash = hashFieldSnapshot(payload);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).toBe(sha256Hex(canonicalJson(payload)));
  });
});
