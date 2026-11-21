#!/usr/bin/env node
/**
 * Argon2id parameter benchmark (S7 / IG-6).
 *
 * Prepared, not executed. Reading latency on a development host does not select
 * production parameters, and this script refuses to treat `memory.max = max` as a
 * memory budget.
 *
 * Method and interpretation: docs/review/phase-3.2-s7-argon2-benchmark-plan.md
 * Library (approved, not installed): @node-rs/argon2@2.2.2
 *
 * Usage:
 *   node apps/api/scripts/benchmark-argon2.mjs --self-test
 *   node apps/api/scripts/benchmark-argon2.mjs [options]
 *
 * Options:
 *   --samples <n>        measured samples per phase (default 100, minimum 100)
 *   --concurrency <n>    concurrent operations, 1 or 4 (default 4)
 *   --warmup <n>         discarded iterations (default 10)
 *   --memory <KiB>       memoryCost (default 19456)
 *   --time <n>           timeCost / iterations (default 2)
 *   --parallelism <n>    threads (default 1)
 *   --output <bytes>     outputLen (default 32)
 *   --salt <bytes>       salt length (default 16)
 *   --allow-unbounded-memory  proceed when the cgroup limit is unknown
 *   --json               print only the JSON report
 *   --self-test          check percentile/budget maths, no hashing
 *
 * Exit codes: 0 ok, 2 prerequisite missing, 3 memory guard, 4 operation failures.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

const DEFAULT_SAMPLES = 100;
const MIN_SAMPLES = 100;
const KiB = 1024;

function parseArgs(argv) {
  const opts = {
    samples: DEFAULT_SAMPLES,
    concurrency: 4,
    warmup: 10,
    memoryCost: 19456,
    timeCost: 2,
    parallelism: 1,
    outputLength: 32,
    saltLength: 16,
    allowUnboundedMemory: false,
    json: false,
    selfTest: false,
  };
  const numeric = {
    "--samples": "samples",
    "--concurrency": "concurrency",
    "--warmup": "warmup",
    "--memory": "memoryCost",
    "--time": "timeCost",
    "--parallelism": "parallelism",
    "--output": "outputLength",
    "--salt": "saltLength",
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg in numeric) {
      const raw = argv[i + 1];
      const value = Number(raw);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${arg} expects a positive integer, got ${JSON.stringify(raw)}`);
      }
      opts[numeric[arg]] = value;
      i += 1;
    } else if (arg === "--allow-unbounded-memory") {
      opts.allowUnboundedMemory = true;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--self-test") {
      opts.selfTest = true;
    } else if (arg === "--help" || arg === "-h") {
      opts.help = true;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  return opts;
}

/** Nearest-rank percentile. `p` in (0, 1]. Returns null for an empty list. */
function percentile(values, p) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil(sorted.length * p);
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1];
}

function summarise(values) {
  if (values.length === 0) {
    return { count: 0, min: null, p50: null, p95: null, max: null, mean: null };
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    min: round(percentile(values, 0)),
    p50: round(percentile(values, 0.5)),
    p95: round(percentile(values, 0.95)),
    max: round(Math.max(...values)),
    mean: round(total / values.length),
  };
}

const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

function readProcStatus() {
  if (!existsSync("/proc/self/status")) return {};
  const status = {};
  for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
    const match = /^(VmRSS|VmHWM):\s+(\d+)\s+kB/.exec(line);
    if (match) status[match[1]] = Number(match[2]) * KiB;
  }
  return status;
}

/**
 * cgroup v2 files for *this* process, not the host root. `memory.max` may be
 * literal `max`, which is an absent budget rather than an infinite one.
 */
function readCgroupMemory() {
  const result = {
    version: null,
    path: null,
    limitBytes: null,
    limitRaw: null,
    cpuMaxRaw: null,
    currentBytes: null,
    peakBytes: null,
    error: null,
  };
  try {
    const line = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((entry) => entry.startsWith("0::"));
    if (!line) {
      result.version = 1;
      result.error = "no cgroup v2 entry in /proc/self/cgroup";
      return result;
    }
    result.version = 2;
    result.path = line.slice(3);
    const dir = `/sys/fs/cgroup${result.path}`;
    const read = (name) => {
      const file = `${dir}/${name}`;
      return existsSync(file) ? readFileSync(file, "utf8").trim() : null;
    };
    result.limitRaw = read("memory.max");
    result.limitBytes =
      result.limitRaw && result.limitRaw !== "max" ? Number(result.limitRaw) : null;
    result.cpuMaxRaw = read("cpu.max");
    const current = read("memory.current");
    result.currentBytes = current === null ? null : Number(current);
    const peak = read("memory.peak");
    result.peakBytes = peak === null ? null : Number(peak);
  } catch (error) {
    result.error = error instanceof Error ? error.message : String(error);
  }
  return result;
}

function memoryGuard(opts, cgroup, baselineRss) {
  const perOperation = opts.memoryCost * KiB * opts.parallelism;
  const estimatedPeak = baselineRss + perOperation * opts.concurrency * 1.25;
  const limit = cgroup.limitBytes;
  const check = {
    baselineRssBytes: baselineRss,
    perOperationBytes: perOperation,
    concurrency: opts.concurrency,
    estimatedPeakBytes: Math.round(estimatedPeak),
    limitBytes: limit,
    limitRaw: cgroup.limitRaw,
    criterion: "peak RSS <= 25% of the container memory limit (IG-6)",
    verdict: "ok",
    reason: null,
  };
  if (limit === null) {
    check.verdict = opts.allowUnboundedMemory ? "latency-only" : "refused";
    check.reason =
      "container memory limit is unknown (memory.max is `max` or absent); latency can be " +
      "measured, but IG-6's RSS criterion cannot be evaluated";
    return check;
  }
  if (estimatedPeak > limit * 0.25) {
    check.verdict = "refused";
    check.reason =
      `estimated peak ${Math.round(estimatedPeak / 1024 / 1024)} MiB exceeds 25% of the ` +
      `${Math.round(limit / 1024 / 1024)} MiB limit; reduce --memory/--concurrency or raise the limit`;
    return check;
  }
  return check;
}

function assertSelfTest() {
  const checks = [];
  const expect = (name, actual, expected) => {
    const ok = JSON.stringify(actual) === JSON.stringify(expected);
    checks.push({ name, ok, actual, expected });
  };
  expect(
    "p50 of 1..100",
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.5,
    ),
    50,
  );
  expect(
    "p95 of 1..100",
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      0.95,
    ),
    95,
  );
  expect(
    "p95 of 20 is second highest, not a tail estimate",
    percentile(
      Array.from({ length: 20 }, (_, i) => i + 1),
      0.95,
    ),
    19,
  );
  expect(
    "max of 1..100",
    percentile(
      Array.from({ length: 100 }, (_, i) => i + 1),
      1,
    ),
    100,
  );
  expect("empty list", summarise([]), {
    count: 0,
    min: null,
    p50: null,
    p95: null,
    max: null,
    mean: null,
  });
  expect("summary count", summarise([1, 2, 3, 4]).count, 4);

  const bounded = memoryGuard(
    { memoryCost: 19456, parallelism: 1, concurrency: 4, allowUnboundedMemory: false },
    { limitBytes: 1024 * 1024 * 1024, limitRaw: String(1024 * 1024 * 1024) },
    60 * 1024 * 1024,
  );
  expect("1 GiB budget accepts concurrency 4", bounded.verdict, "ok");

  const half = memoryGuard(
    { memoryCost: 19456, parallelism: 1, concurrency: 4, allowUnboundedMemory: false },
    { limitBytes: 512 * 1024 * 1024, limitRaw: String(512 * 1024 * 1024) },
    60 * 1024 * 1024,
  );
  expect("512 MiB budget refuses concurrency 4 under the 25% criterion", half.verdict, "refused");

  const unbounded = memoryGuard(
    { memoryCost: 19456, parallelism: 1, concurrency: 4, allowUnboundedMemory: false },
    { limitBytes: null, limitRaw: "max" },
    60 * 1024 * 1024,
  );
  expect("unknown limit refuses by default", unbounded.verdict, "refused");

  const overridden = memoryGuard(
    { memoryCost: 19456, parallelism: 1, concurrency: 4, allowUnboundedMemory: true },
    { limitBytes: null, limitRaw: "max" },
    60 * 1024 * 1024,
  );
  expect("unknown limit with override is latency-only", overridden.verdict, "latency-only");

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}`);
    if (!check.ok)
      console.log(
        `     actual=${JSON.stringify(check.actual)} expected=${JSON.stringify(check.expected)}`,
      );
  }
  if (failed.length > 0) {
    console.error(`self-test failed: ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`self-test ok: ${checks.length} checks`);
}

function syntheticPassword(index) {
  // Synthetic only. Never a real credential, never written anywhere.
  return `s7-bench-${index}-${randomBytes(6).toString("hex")}`;
}

async function measure({ hash, verify }, password, options) {
  const hashStart = performance.now();
  const digest = await hash(password, options);
  const hashMs = performance.now() - hashStart;

  const verifyStart = performance.now();
  const matches = await verify(digest, password);
  const verifyMs = performance.now() - verifyStart;

  return { hashMs, verifyMs, matches };
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }

  if (opts.help) {
    console.log("See the header of this file for usage.");
    process.exit(0);
  }
  if (opts.selfTest) {
    assertSelfTest();
    process.exit(0);
  }
  if (opts.samples < MIN_SAMPLES) {
    console.error(
      `--samples must be at least ${MIN_SAMPLES}; fewer makes p95 a restatement of the maximum`,
    );
    process.exit(1);
  }
  if (![1, 4].includes(opts.concurrency)) {
    console.error("--concurrency must be 1 or 4; other values are not part of the approved plan");
    process.exit(1);
  }

  let argon2;
  try {
    argon2 = await import("@node-rs/argon2");
  } catch {
    console.error(
      "@node-rs/argon2 is not installed. The dependency is approved but not added to any manifest.\n" +
        "Prerequisite (owner action, not run by this script): pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2\n" +
        "See docs/review/phase-3.2-s7-argon2-benchmark-plan.md",
    );
    process.exit(2);
  }

  const cgroup = readCgroupMemory();
  const baseline = readProcStatus();
  const guard = memoryGuard(opts, cgroup, baseline.VmRSS ?? 0);

  if (guard.verdict === "refused") {
    console.error(`memory guard refused the run: ${guard.reason}`);
    console.error(`cgroup limit: ${guard.limitRaw ?? "unknown"}`);
    console.error(
      "A latency-only run is possible with --allow-unbounded-memory, but its RSS numbers cannot satisfy IG-6.",
    );
    process.exit(3);
  }

  const baseOptions = {
    algorithm: argon2.Algorithm?.Argon2id ?? 2,
    memoryCost: opts.memoryCost,
    timeCost: opts.timeCost,
    parallelism: opts.parallelism,
    outputLen: opts.outputLength,
  };
  // Fresh random salt per hash, as production will do; a fixed salt would measure
  // the same cost but would not resemble real usage.
  const optionsFor = () => ({ ...baseOptions, salt: randomBytes(opts.saltLength) });

  const errors = [];
  const guardErrors = (stage, index, error) => {
    errors.push({ stage, index, message: error instanceof Error ? error.message : String(error) });
  };

  // Warm-up: populate the allocator and the N-API binding, then discard.
  for (let i = 0; i < opts.warmup; i += 1) {
    try {
      await measure(argon2, syntheticPassword(i), optionsFor());
    } catch (error) {
      guardErrors("warmup", i, error);
    }
  }

  const sequential = { hashMs: [], verifyMs: [] };
  for (let i = 0; i < opts.samples; i += 1) {
    const password = syntheticPassword(i);
    try {
      const sample = await measure(argon2, password, optionsFor());
      if (!sample.matches) throw new Error("verify returned false for a digest it just produced");
      sequential.hashMs.push(sample.hashMs);
      sequential.verifyMs.push(sample.verifyMs);
    } catch (error) {
      guardErrors("sequential", i, error);
    }
  }

  const concurrent = { hashMs: [], verifyMs: [] };
  const batches = Math.ceil(opts.samples / opts.concurrency);
  for (let batch = 0; batch < batches; batch += 1) {
    const indexes = Array.from(
      { length: Math.min(opts.concurrency, opts.samples - batch * opts.concurrency) },
      (_, offset) => batch * opts.concurrency + offset,
    );
    const results = await Promise.allSettled(
      indexes.map((index) => measure(argon2, syntheticPassword(index), optionsFor())),
    );
    results.forEach((result, position) => {
      const index = indexes[position];
      if (result.status === "fulfilled") {
        if (!result.value.matches) {
          guardErrors(
            "concurrent",
            index,
            new Error("verify returned false for a digest it just produced"),
          );
          return;
        }
        concurrent.hashMs.push(result.value.hashMs);
        concurrent.verifyMs.push(result.value.verifyMs);
      } else {
        guardErrors("concurrent", index, result.reason);
      }
    });
  }

  // Verification reads the parameters encoded in the stored hash, not the config.
  let crossParameterVerification;
  try {
    const legacyDigest = await argon2.hash("s7-bench-legacy", {
      ...baseOptions,
      memoryCost: 4096,
      salt: randomBytes(opts.saltLength),
    });
    crossParameterVerification = await argon2.verify(legacyDigest, "s7-bench-legacy");
  } catch (error) {
    crossParameterVerification = false;
    guardErrors("cross-parameter", -1, error);
  }

  const after = readProcStatus();
  const cgroupAfter = readCgroupMemory();

  const report = {
    generatedAt: new Date().toISOString(),
    library: "argon2id",
    params: {
      memoryCostKiB: opts.memoryCost,
      timeCost: opts.timeCost,
      parallelism: opts.parallelism,
      outputLength: opts.outputLength,
      saltLength: opts.saltLength,
    },
    workload: {
      measuredSamples: opts.samples,
      warmupIterations: opts.warmup,
      concurrency: opts.concurrency,
      phases: ["sequential", "concurrent"],
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuCount: cpus().length,
      cgroup: {
        version: cgroup.version,
        path: cgroup.path,
        limitRaw: cgroup.limitRaw,
        limitBytes: cgroup.limitBytes,
        cpuMaxRaw: cgroup.cpuMaxRaw,
        error: cgroup.error,
      },
    },
    memory: {
      baselineRssBytes: baseline.VmRSS ?? null,
      afterRssBytes: after.VmRSS ?? null,
      peakRssBytes: after.VmHWM ?? null,
      resourceMaxRssBytes: process.resourceUsage().maxRSS * KiB,
      cgroupCurrentBytes: cgroupAfter.currentBytes,
      cgroupPeakBytes: cgroupAfter.peakBytes,
      note: "peakRssBytes is the kernel high-water mark (VmHWM), not a current snapshot; resourceMaxRssBytes is process.resourceUsage().maxRSS (KiB on Linux); cgroup peak is scope-wide, not benchmark-only",
    },
    guard,
    latencyMs: {
      sequential: { hash: summarise(sequential.hashMs), verify: summarise(sequential.verifyMs) },
      concurrent: { hash: summarise(concurrent.hashMs), verify: summarise(concurrent.verifyMs) },
    },
    crossParameterVerification,
    failures: { count: errors.length, byStage: countByStage(errors), samples: errors.slice(0, 10) },
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
    console.log(JSON.stringify(report, null, 2));
  }

  if (errors.length > 0) process.exit(4);
}

function countByStage(errors) {
  const counts = {};
  for (const error of errors) counts[error.stage] = (counts[error.stage] ?? 0) + 1;
  return counts;
}

function printSummary(report) {
  const { latencyMs, memory, environment, guard } = report;
  const line = (label, stats) =>
    `${label.padEnd(22)} n=${String(stats.count).padEnd(4)} p50=${fmt(stats.p50)} ms  p95=${fmt(stats.p95)} ms  max=${fmt(stats.max)} ms`;
  console.error("");
  console.error(
    `node ${environment.node}  ${environment.platform}/${environment.arch}  cpus=${environment.cpuCount}`,
  );
  console.error(
    `cgroup v${environment.cgroup.version ?? "?"}  memory.max=${environment.cgroup.limitRaw ?? "unknown"}  cpu.max=${environment.cgroup.cpuMaxRaw ?? "unknown"}`,
  );
  console.error(`guard: ${guard.verdict}${guard.reason ? ` — ${guard.reason}` : ""}`);
  console.error(line("sequential hash", latencyMs.sequential.hash));
  console.error(line("sequential verify", latencyMs.sequential.verify));
  console.error(line("concurrent hash", latencyMs.concurrent.hash));
  console.error(line("concurrent verify", latencyMs.concurrent.verify));
  console.error(
    `rss baseline=${mib(memory.baselineRssBytes)} peak=${mib(memory.peakRssBytes)} (VmHWM)  cgroup peak=${mib(memory.cgroupPeakBytes)}`,
  );
  console.error(`failures: ${report.failures.count}`);
  console.error("");
}

const fmt = (value) => (value === null ? "n/a" : value.toFixed(1));
const mib = (bytes) => (bytes === null ? "n/a" : `${(bytes / 1024 / 1024).toFixed(1)} MiB`);

await main();
