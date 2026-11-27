import { describe, expect, it } from "vitest";

import { canonicalJson } from "../src/canonical.js";
import {
  ingestionJobIdentityOf,
  ingestionVersionOf,
  targetSelectorHashOf,
} from "../src/climate.js";
import {
  ingestionJobPayloadSchema,
  jobKindSchema,
  jobSchema,
  jobStatusSchema,
} from "../src/job.js";

const RUN = "0192f0aa-0000-7000-8000-000000000001";
const HASH = "a".repeat(64);

const baseJob = {
  id: RUN,
  kind: "ingest.forecast" as const,
  idempotencyKey: "ingest:ingest.forecast:" + RUN + ":" + HASH,
  payload: {},
  status: "queued" as const,
  attempt: 0,
  maxAttempts: 5,
  runAt: "2026-11-22T00:00:00.000Z",
  leaseToken: null,
  leaseExpiresAt: null,
  ingestionRunId: null,
  lastError: null,
  finishedAt: null,
  createdAt: "2026-11-22T00:00:00.000Z",
  updatedAt: "2026-11-22T00:00:00.000Z",
};

describe("jobStatusSchema", () => {
  it("has exactly the five approved statuses and no failed", () => {
    expect(jobStatusSchema.options).toEqual([
      "queued",
      "running",
      "succeeded",
      "dead",
      "cancelled",
    ]);
    expect(jobStatusSchema.safeParse("failed").success).toBe(false);
  });
});

describe("jobKindSchema", () => {
  it("matches the database CHECK list", () => {
    expect(jobKindSchema.options).toEqual([
      "ingest.forecast",
      "ingest.climate",
      "aggregate",
      "recompute.windows",
      "verify",
      "maintenance",
    ]);
  });
});

describe("jobSchema", () => {
  it("accepts a queued job with no lease", () => {
    expect(jobSchema.parse(baseJob).status).toBe("queued");
  });

  it("refuses a running job without a lease token", () => {
    const parsed = jobSchema.safeParse({ ...baseJob, status: "running" });
    expect(parsed.success).toBe(false);
  });

  it("refuses a lease token on a non-running job", () => {
    const parsed = jobSchema.safeParse({
      ...baseJob,
      leaseToken: RUN,
      leaseExpiresAt: baseJob.runAt,
    });
    expect(parsed.success).toBe(false);
  });

  it("requires finished_at exactly at a terminal status", () => {
    expect(jobSchema.safeParse({ ...baseJob, status: "succeeded" }).success).toBe(false);
    expect(
      jobSchema.safeParse({ ...baseJob, status: "succeeded", finishedAt: baseJob.runAt }).success,
    ).toBe(true);
    expect(
      jobSchema.safeParse({ ...baseJob, status: "dead", finishedAt: baseJob.runAt }).success,
    ).toBe(true);
    expect(
      jobSchema.safeParse({ ...baseJob, status: "cancelled", finishedAt: baseJob.runAt }).success,
    ).toBe(true);
    expect(jobSchema.safeParse({ ...baseJob, status: "cancelled" }).success).toBe(false);
    expect(jobSchema.safeParse({ ...baseJob, finishedAt: baseJob.runAt }).success).toBe(false);
  });

  it("refuses attempt above maxAttempts", () => {
    const parsed = jobSchema.safeParse({ ...baseJob, attempt: 6, maxAttempts: 5 });
    expect(parsed.success).toBe(false);
  });
});

describe("ingestionJobPayloadSchema", () => {
  it("round-trips the four fields the handler needs", () => {
    const payload = {
      forecastRunId: RUN,
      adapterVersion: "bmkg@1.0.0",
      normalizerVersion: "normalize@1.0.0",
      targetSelectorHash: HASH,
    };
    expect(ingestionJobPayloadSchema.parse(payload)).toEqual(payload);
  });

  it("carries no ingestionVersion: the handler recomputes it", () => {
    const payload = {
      forecastRunId: RUN,
      adapterVersion: "bmkg@1.0.0",
      normalizerVersion: "normalize@1.0.0",
      targetSelectorHash: HASH,
      ingestionVersion: HASH,
    };
    expect(ingestionJobPayloadSchema.safeParse(payload).success).toBe(false);
  });
});

describe("targetSelectorHashOf", () => {
  it("is a function of the set, not of emission order", () => {
    const a = targetSelectorHashOf({
      cells: [
        { cellKey: "0.00,0.00", variable: "precipitation" },
        { cellKey: "0.00,0.00", variable: "temperature" },
      ],
    });
    const b = targetSelectorHashOf({
      cells: [
        { cellKey: "0.00,0.00", variable: "temperature" },
        { cellKey: "0.00,0.00", variable: "precipitation" },
      ],
    });
    expect(b).toBe(a);
  });

  it("keeps the cell/variable pairing: two parallel arrays would not", () => {
    const swapped = targetSelectorHashOf({
      cells: [
        { cellKey: "0.00,0.00", variable: "precipitation" },
        { cellKey: "0.10,0.10", variable: "temperature" },
      ],
    });
    const paired = targetSelectorHashOf({
      cells: [
        { cellKey: "0.00,0.00", variable: "temperature" },
        { cellKey: "0.10,0.10", variable: "precipitation" },
      ],
    });
    expect(swapped).not.toBe(paired);
  });

  it("is the SHA-256 of the canonical JSON", () => {
    const cells = [{ cellKey: "0.00,0.00", variable: "temperature" }];
    expect(targetSelectorHashOf({ cells })).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalJson({ cells })).toBe(
      '{"cells":[{"cellKey":"0.00,0.00","variable":"temperature"}]}',
    );
  });

  it("dedupes an exactly repeated pair", () => {
    const once = targetSelectorHashOf({ cells: [{ cellKey: "1,1", variable: "temperature" }] });
    const twice = targetSelectorHashOf({
      cells: [
        { cellKey: "1,1", variable: "temperature" },
        { cellKey: "1,1", variable: "temperature" },
      ],
    });
    expect(twice).toBe(once);
  });
});

describe("ingestionJobIdentityOf", () => {
  const input = {
    queue: "ingest.forecast",
    forecastRunId: RUN,
    adapterVersion: "bmkg@1.0.0",
    normalizerVersion: "normalize@1.0.0",
    targetSelectorHash: HASH,
  };

  it("builds ingest:{queue}:{forecastRunId}:{ingestionVersion}", () => {
    const { ingestionVersion, idempotencyKey } = ingestionJobIdentityOf(input);
    expect(ingestionVersion).toBe(
      ingestionVersionOf({
        adapterVersion: input.adapterVersion,
        normalizerVersion: input.normalizerVersion,
        targetSelectorHash: input.targetSelectorHash,
      }),
    );
    expect(idempotencyKey).toBe(`ingest:ingest.forecast:${RUN}:${ingestionVersion}`);
  });

  it("distinguishes two runs that share every version input", () => {
    const other = ingestionJobIdentityOf({ ...input, forecastRunId: RUN.replace(/1$/, "2") });
    expect(other.idempotencyKey).not.toBe(ingestionJobIdentityOf(input).idempotencyKey);
  });

  it("distinguishes a normalizer bump, which targetSelectorHash alone would not", () => {
    const bumped = ingestionJobIdentityOf({ ...input, normalizerVersion: "normalize@1.0.1" });
    expect(bumped.ingestionVersion).not.toBe(ingestionJobIdentityOf(input).ingestionVersion);
  });
});
