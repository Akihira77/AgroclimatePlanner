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
 * The four measurement stages run one at a time, so a hash never overlaps with a
 * verify: sequential hash, sequential verify, concurrent hash, concurrent verify.
 * The concurrent verify stage reads digests produced by the concurrent hash stage,
 * which has already finished by the time verification starts.
 *
 * Usage:
 *   node apps/api/scripts/benchmark-argon2.mjs --self-test
 *   node apps/api/scripts/benchmark-argon2.mjs [options]
 *
 * Options:
 *   --samples <n>        measured samples per stage (default 100, minimum 100)
 *   --concurrency <n>    concurrent operations, 1 or 4 (default 4)
 *   --warmup <n>         discarded iterations (default 10)
 *   --memory <KiB>       memoryCost (default 19456)
 *   --time <n>           timeCost / iterations (default 2)
 *   --parallelism <n>    threads (default 1)
 *   --output <bytes>     outputLen (default 32)
 *   --salt <bytes>       salt length (default 16)
 *   --allow-unbounded-memory
 *                        permit a concurrency-1 latency-only run when the effective
 *                        container memory limit is unknown. It never permits
 *                        concurrency > 1: an unknown limit cannot bound the pools.
 *   --json               print only the JSON report
 *   --self-test          run the harness self-tests, no hashing, no library import
 *
 * Exit codes: 0 ok, 1 bad arguments, 2 prerequisite missing, 3 memory guard,
 * 4 operation failures.
 */

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { cpus } from "node:os";
import { performance } from "node:perf_hooks";

const DEFAULT_SAMPLES = 100;
const MIN_SAMPLES = 100;
const KiB = 1024;
const MiB = 1024 * KiB;
const SAFETY_FACTOR = 1.25;
const BUDGET_RATIO = 0.25;
const CGROUP2_FSTYPE = "cgroup2";

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

const round = (value) => (value === null ? null : Math.round(value * 100) / 100);

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

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function readProcStatus() {
  if (!existsSync("/proc/self/status")) return {};
  const status = {};
  for (const line of readFileSync("/proc/self/status", "utf8").split("\n")) {
    const match = /^(VmRSS|VmHWM):\s+(\d+)\s+kB/.exec(line);
    if (match) status[match[1]] = Number(match[2]) * KiB;
  }
  return status;
}

/** Locates the cgroup v2 mount and its root, ignoring cgroup v1 mounts. */
function findCgroup2Mount(mountInfo) {
  for (const line of String(mountInfo ?? "").split("\n")) {
    if (line === "") continue;
    const separator = line.indexOf(" - ");
    if (separator === -1) continue;
    const prefix = line.slice(0, separator).split(" ");
    const suffix = line.slice(separator + 3).split(" ");
    if (suffix[0] !== CGROUP2_FSTYPE) continue;
    return { mountPoint: prefix[4], root: prefix[3] };
  }
  return null;
}

/**
 * `root` is the cgroup subtree mounted at `mountPoint`, so a path reported by
 * /proc/self/cgroup is already relative to the cgroup namespace root. When it does
 * not sit under `root`, the mount is not the process's own view and the result is
 * reported unresolved instead of being guessed.
 */
function joinCgroupPath(mountPoint, root, processPath) {
  if (root === "/" || root === "") return `${mountPoint}${processPath === "/" ? "" : processPath}`;
  if (processPath === root) return mountPoint;
  if (processPath.startsWith(`${root}/`)) return `${mountPoint}${processPath.slice(root.length)}`;
  return null;
}

/** Deepest-first list of cgroup directories from the process cgroup up to the mount. */
function ancestorDirectories(mountPoint, processDir) {
  const directories = [];
  let directory = processDir;
  while (directory.startsWith(mountPoint)) {
    directories.push(directory);
    if (directory === mountPoint) break;
    const cut = directory.lastIndexOf("/");
    if (cut <= 0) break;
    directory = directory.slice(0, cut);
  }
  return directories;
}

const parseMemoryMax = (raw) => {
  if (raw === null || raw === "" || raw === "max") return null;
  const bytes = Number(raw);
  return Number.isFinite(bytes) && bytes > 0 ? bytes : null;
};

const parseCpuMax = (raw) => {
  if (raw === null || raw === "") return null;
  const [quotaRaw, periodRaw] = raw.split(/\s+/);
  if (!quotaRaw || quotaRaw === "max") return null;
  const quota = Number(quotaRaw);
  const period = Number(periodRaw);
  if (!Number.isFinite(quota) || !Number.isFinite(period) || period <= 0) return null;
  return { quota, period, cpus: quota / period, raw };
};

/**
 * Resolves the effective limits for this process by walking its cgroup v2 ancestors.
 * The effective limit is the tightest finite limit in the hierarchy; `max` means
 * "no budget at this level", not "infinite budget". Reads only; never writes.
 */
function resolveCgroup({ cgroupFile, mountInfo, read }) {
  const result = {
    version: null,
    supported: false,
    processPath: null,
    resolvedPath: null,
    mountPoint: null,
    levels: [],
    limitBytes: null,
    limitRaw: null,
    limitSourcePath: null,
    cpuEffectiveCpus: null,
    cpuQuotaRaw: null,
    cpuSourcePath: null,
    currentBytes: null,
    peakBytes: null,
    error: null,
  };

  const entry = String(cgroupFile ?? "")
    .split("\n")
    .find((line) => line.startsWith("0::"));
  if (!entry) {
    result.version = 1;
    result.error =
      "no cgroup v2 entry in /proc/self/cgroup; cgroup v1 is not supported by this harness";
    return result;
  }
  result.version = 2;
  result.processPath = entry.slice(3);

  const mount = findCgroup2Mount(mountInfo);
  if (!mount) {
    result.error = "no cgroup2 mount in /proc/self/mountinfo; the effective limit is unknown";
    return result;
  }
  result.mountPoint = mount.mountPoint;

  const processDir = joinCgroupPath(mount.mountPoint, mount.root, result.processPath);
  if (processDir === null) {
    result.error =
      `process cgroup ${result.processPath} is outside the mounted subtree ${mount.root}; ` +
      "the effective limit is unknown";
    return result;
  }
  result.resolvedPath = processDir;
  result.supported = true;

  const readText = (path) => {
    try {
      const value = read(path);
      return value === null || value === undefined ? null : String(value).trim();
    } catch {
      return null;
    }
  };

  for (const directory of ancestorDirectories(mount.mountPoint, processDir)) {
    const relative = directory.slice(mount.mountPoint.length) || "/";
    const memoryMaxRaw = readText(`${directory}/memory.max`);
    const cpuMaxRaw = readText(`${directory}/cpu.max`);
    result.levels.push({
      path: relative,
      memoryMaxRaw,
      memoryMaxBytes: parseMemoryMax(memoryMaxRaw),
      cpuMaxRaw,
    });
  }

  let bestCpu = null;
  for (const level of result.levels) {
    if (
      level.memoryMaxBytes !== null &&
      (result.limitBytes === null || level.memoryMaxBytes < result.limitBytes)
    ) {
      result.limitBytes = level.memoryMaxBytes;
      result.limitRaw = level.memoryMaxRaw;
      result.limitSourcePath = level.path;
    }
    const cpu = parseCpuMax(level.cpuMaxRaw);
    if (cpu === null) continue;
    if (bestCpu === null || cpu.cpus < bestCpu) {
      bestCpu = cpu.cpus;
      result.cpuEffectiveCpus = round(cpu.cpus);
      result.cpuQuotaRaw = cpu.raw;
      result.cpuSourcePath = level.path;
    }
  }

  const current = readText(`${processDir}/memory.current`);
  const peak = readText(`${processDir}/memory.peak`);
  result.currentBytes = current === null ? null : Number(current);
  result.peakBytes = peak === null ? null : Number(peak);
  if (!Number.isFinite(result.currentBytes)) result.currentBytes = null;
  if (!Number.isFinite(result.peakBytes)) result.peakBytes = null;

  return result;
}

function readCgroup() {
  const read = (path) => (existsSync(path) ? readFileSync(path, "utf8") : null);
  return resolveCgroup({
    cgroupFile: read("/proc/self/cgroup") ?? "",
    mountInfo: read("/proc/self/mountinfo") ?? "",
    read,
  });
}

/**
 * Conservative budget check. An unknown limit can never authorise concurrency > 1:
 * the flag below only unlocks a single-pool latency run, whose RSS figures cannot
 * establish production memory suitability.
 */
function memoryGuard(opts, cgroup, baselineRss) {
  const perOperation = opts.memoryCost * KiB * opts.parallelism;
  const estimatedPeak = baselineRss + perOperation * opts.concurrency * SAFETY_FACTOR;
  const limit =
    Number.isFinite(cgroup?.limitBytes) && cgroup.limitBytes > 0 ? cgroup.limitBytes : null;
  const check = {
    baselineRssBytes: baselineRss,
    perOperationBytes: perOperation,
    concurrency: opts.concurrency,
    safetyFactor: SAFETY_FACTOR,
    budgetRatio: BUDGET_RATIO,
    estimatedPeakBytes: Math.round(estimatedPeak),
    limitBytes: limit,
    limitRaw: cgroup?.limitRaw ?? null,
    limitSourcePath: cgroup?.limitSourcePath ?? null,
    criterion: "peak RSS <= 25% of the effective container memory limit (IG-6)",
    verdict: "ok",
    suitableForResourceEvaluation: true,
    reason: null,
  };

  if (limit === null) {
    check.suitableForResourceEvaluation = false;
    if (opts.concurrency > 1) {
      check.verdict = "refused";
      check.reason =
        `the effective container memory limit is unknown, so concurrency ${opts.concurrency} ` +
        "cannot be bounded; only --concurrency 1 is permitted without a known limit";
      return check;
    }
    if (!opts.allowUnboundedMemory) {
      check.verdict = "refused";
      check.reason =
        "the effective container memory limit is unknown (memory.max is `max` or absent); " +
        "IG-6's RSS criterion cannot be evaluated";
      return check;
    }
    check.verdict = "latency-only";
    check.reason =
      "the effective container memory limit is unknown; this concurrency-1 run measures latency " +
      "only and cannot establish production memory suitability";
    return check;
  }

  if (estimatedPeak > limit * BUDGET_RATIO) {
    check.verdict = "refused";
    check.suitableForResourceEvaluation = false;
    check.reason =
      `estimated peak ${Math.round(estimatedPeak / MiB)} MiB exceeds 25% of the ` +
      `${Math.round(limit / MiB)} MiB limit; reduce --memory/--concurrency or raise the limit`;
  }
  return check;
}

/**
 * Runs `operation(entry)` over `entries` in batches of `concurrency`, timing every
 * call individually. One stage performs exactly one operation kind, so a stage's
 * latencies are never a mixture of hash and verify.
 */
async function runStage({ stage, entries, concurrency, operation }) {
  const latencies = [];
  const failures = [];
  const results = [];
  const batchCount = Math.ceil(entries.length / concurrency);
  for (let batch = 0; batch < batchCount; batch += 1) {
    const slice = entries.slice(batch * concurrency, (batch + 1) * concurrency);
    const settled = await Promise.allSettled(
      slice.map(async (entry) => {
        const startedAt = performance.now();
        const value = await operation(entry);
        return { latencyMs: performance.now() - startedAt, value };
      }),
    );
    settled.forEach((outcome, offset) => {
      const entry = slice[offset];
      const index = typeof entry?.index === "number" ? entry.index : batch * concurrency + offset;
      if (outcome.status === "fulfilled") {
        latencies.push(outcome.value.latencyMs);
        results.push({ index, entry, value: outcome.value.value });
      } else {
        failures.push({ stage, index, message: describeError(outcome.reason) });
      }
    });
  }
  return { latencies, failures, results };
}

function syntheticPassword(index) {
  // Synthetic only. Never a real credential, never written anywhere.
  return `s7-bench-${index}-${randomBytes(6).toString("hex")}`;
}

async function assertSelfTest() {
  const checks = [];
  const expect = (name, actual, expected) => {
    checks.push({
      name,
      ok: JSON.stringify(actual) === JSON.stringify(expected),
      actual,
      expected,
    });
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

  // Stage isolation: mocks, so no Argon2 import is needed.
  const order = [];
  const hashStage = await runStage({
    stage: "hash-stage",
    entries: Array.from({ length: 4 }, (_, index) => ({ index, password: `p${index}` })),
    concurrency: 4,
    operation: ({ index, password }) => {
      order.push("hash");
      return `digest-${index}-${password}`;
    },
  });
  const verifyStage = await runStage({
    stage: "verify-stage",
    entries: hashStage.results,
    concurrency: 4,
    operation: ({ entry, value }) => {
      order.push("verify");
      return value === `digest-${entry.index}-${entry.password}`;
    },
  });
  expect("hash stage records only hash latencies", hashStage.latencies.length, 4);
  expect("verify stage records only verify latencies", verifyStage.latencies.length, 4);
  expect("hash stage executes before any verify", order.slice(0, 4), [
    "hash",
    "hash",
    "hash",
    "hash",
  ]);
  expect("verify stage executes only after the hashes", order.slice(4), [
    "verify",
    "verify",
    "verify",
    "verify",
  ]);
  expect(
    "verify stage receives the digests the hash stage produced",
    verifyStage.results.every((result) => result.value === true),
    true,
  );

  const hashFailure = await runStage({
    stage: "hash-stage",
    entries: [{ index: 0 }],
    concurrency: 1,
    operation: () => {
      throw new Error("hash exploded");
    },
  });
  expect(
    "hash failure is attributed to the hash stage",
    hashFailure.failures.map((failure) => failure.stage),
    ["hash-stage"],
  );
  const verifyFailure = await runStage({
    stage: "verify-stage",
    entries: [{ index: 0 }],
    concurrency: 1,
    operation: () => {
      throw new Error("verify exploded");
    },
  });
  expect(
    "verify failure is attributed to the verify stage",
    verifyFailure.failures.map((failure) => failure.stage),
    ["verify-stage"],
  );

  // Memory guard.
  const guardOpts = (overrides = {}) => ({
    memoryCost: 19456,
    parallelism: 1,
    concurrency: 4,
    allowUnboundedMemory: false,
    ...overrides,
  });
  const known = (bytes) => ({ limitBytes: bytes, limitRaw: String(bytes), limitSourcePath: "/a" });
  const unknown = { limitBytes: null, limitRaw: "max", limitSourcePath: null };
  const baseline = 80 * MiB;

  expect(
    "unknown limit refuses concurrency 4",
    memoryGuard(guardOpts(), unknown, baseline).verdict,
    "refused",
  );
  expect(
    "--allow-unbounded-memory cannot bypass the concurrency-4 restriction",
    memoryGuard(guardOpts({ allowUnboundedMemory: true }), unknown, baseline).verdict,
    "refused",
  );
  expect(
    "unknown limit refuses concurrency 1 by default",
    memoryGuard(guardOpts({ concurrency: 1 }), unknown, baseline).verdict,
    "refused",
  );
  expect(
    "unknown limit with override permits concurrency 1 as latency-only",
    memoryGuard(guardOpts({ concurrency: 1, allowUnboundedMemory: true }), unknown, baseline)
      .verdict,
    "latency-only",
  );
  expect(
    "a latency-only run cannot evaluate the resource criterion",
    memoryGuard(guardOpts({ concurrency: 1, allowUnboundedMemory: true }), unknown, baseline)
      .suitableForResourceEvaluation,
    false,
  );
  expect(
    "1 GiB accepts concurrency 4",
    memoryGuard(guardOpts(), known(1024 * MiB), baseline).verdict,
    "ok",
  );
  expect(
    "512 MiB refuses concurrency 4 under the 25% criterion",
    memoryGuard(guardOpts(), known(512 * MiB), baseline).verdict,
    "refused",
  );
  expect(
    "700 MiB accepts an estimate of exactly 25%",
    memoryGuard(guardOpts(), known(700 * MiB), baseline).verdict,
    "ok",
  );
  expect(
    "non-finite limit data is treated as unknown",
    memoryGuard(guardOpts(), known(Number.NaN), baseline).verdict,
    "refused",
  );

  // cgroup hierarchy, from fixtures only.
  const MOUNT_INFO =
    "120 111 0:23 / /sys/fs/cgroup rw,nosuid,nodev,noexec,relatime shared:23 - cgroup2 cgroup2 rw";
  const resolveFixture = (files, options = {}) =>
    resolveCgroup({
      cgroupFile: options.cgroupFile ?? "0::/a/b\n",
      mountInfo: options.mountInfo ?? MOUNT_INFO,
      read: (path) => (Object.hasOwn(files, path) ? files[path] : null),
    });

  const finiteChild = resolveFixture({
    "/sys/fs/cgroup/memory.max": "max\n",
    "/sys/fs/cgroup/a/memory.max": "max\n",
    "/sys/fs/cgroup/a/b/memory.max": "1073741824\n",
    "/sys/fs/cgroup/a/b/memory.current": "12345\n",
    "/sys/fs/cgroup/a/b/memory.peak": "99999\n",
  });
  expect("finite child limit is used", finiteChild.limitBytes, 1073741824);
  expect("limit source is the process cgroup", finiteChild.limitSourcePath, "/a/b");
  expect("cgroup current comes from the process cgroup", finiteChild.currentBytes, 12345);
  expect("cgroup peak comes from the process cgroup", finiteChild.peakBytes, 99999);

  const tighterParent = resolveFixture({
    "/sys/fs/cgroup/memory.max": "max\n",
    "/sys/fs/cgroup/a/memory.max": "536870912\n",
    "/sys/fs/cgroup/a/b/memory.max": "2147483648\n",
  });
  expect("a tighter ancestor limit wins", tighterParent.limitBytes, 536870912);
  expect("limit source is the tighter ancestor", tighterParent.limitSourcePath, "/a");

  expect(
    "an unlimited child inherits a finite parent",
    resolveFixture({ "/sys/fs/cgroup/a/memory.max": "1073741824\n" }).limitBytes,
    1073741824,
  );
  expect("missing limit files leave the limit unknown", resolveFixture({}).limitBytes, null);
  expect(
    "multiple unlimited levels leave the limit unknown",
    resolveFixture({
      "/sys/fs/cgroup/memory.max": "max\n",
      "/sys/fs/cgroup/a/memory.max": "max\n",
      "/sys/fs/cgroup/a/b/memory.max": "max\n",
    }).limitBytes,
    null,
  );

  const noMount = resolveFixture(
    {},
    { mountInfo: "120 111 0:23 / /sys/fs/cgroup rw - tmpfs tmpfs rw" },
  );
  expect("an unresolved cgroup mount reports an unknown limit", noMount.limitBytes, null);
  expect("an unresolved cgroup mount is an error, not a guess", typeof noMount.error, "string");

  const legacy = resolveFixture({}, { cgroupFile: "12:cpu:/legacy\n" });
  expect("cgroup v1 is reported as version 1", legacy.version, 1);
  expect("cgroup v1 is not claimed as supported", legacy.supported, false);

  const quota = resolveFixture({
    "/sys/fs/cgroup/cpu.max": "max 100000\n",
    "/sys/fs/cgroup/a/cpu.max": "50000 100000\n",
    "/sys/fs/cgroup/a/b/cpu.max": "max 100000\n",
  });
  expect("the tightest cpu quota wins", quota.cpuEffectiveCpus, 0.5);
  expect("cpu quota source is the tighter ancestor", quota.cpuSourcePath, "/a");

  const rebased = resolveFixture(
    {},
    {
      cgroupFile: "0::/x/y\n",
      mountInfo: "120 111 0:23 /x /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
    },
  );
  expect(
    "the mount root is stripped from the process path",
    rebased.resolvedPath,
    "/sys/fs/cgroup/y",
  );

  const outside = resolveFixture(
    {},
    {
      cgroupFile: "0::/z/y\n",
      mountInfo: "120 111 0:23 /x /sys/fs/cgroup rw - cgroup2 cgroup2 rw",
    },
  );
  expect("a process outside the mount root is not guessed", outside.limitBytes, null);

  const failed = checks.filter((check) => !check.ok);
  for (const check of checks) {
    console.log(`${check.ok ? "ok  " : "FAIL"} ${check.name}`);
    if (!check.ok) {
      console.log(
        `     actual=${JSON.stringify(check.actual)} expected=${JSON.stringify(check.expected)}`,
      );
    }
  }
  if (failed.length > 0) {
    console.error(`self-test failed: ${failed.length}/${checks.length}`);
    process.exit(1);
  }
  console.log(`self-test ok: ${checks.length} checks`);
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(describeError(error));
    process.exit(1);
  }

  if (opts.help) {
    console.log("See the header of this file for usage.");
    process.exit(0);
  }
  if (opts.selfTest) {
    await assertSelfTest();
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

  const cgroup = readCgroup();
  const baseline = readProcStatus();
  const guard = memoryGuard(opts, cgroup, baseline.VmRSS ?? 0);

  if (guard.verdict === "refused") {
    console.error(`memory guard refused the run: ${guard.reason}`);
    console.error(`effective cgroup memory limit: ${guard.limitRaw ?? "unknown"}`);
    if (cgroup.error) console.error(`cgroup detection: ${cgroup.error}`);
    if (opts.concurrency > 1) {
      console.error(
        "Concurrency 4 requires a known container memory limit; --allow-unbounded-memory does not change that.",
      );
    } else {
      console.error(
        "A concurrency-1 latency-only run is possible with --allow-unbounded-memory, but its RSS numbers cannot satisfy IG-6.",
      );
    }
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

  const warmupFailures = [];
  for (let index = 0; index < opts.warmup; index += 1) {
    const password = syntheticPassword(-1 - index);
    try {
      const digest = await argon2.hash(password, optionsFor());
      if (!(await argon2.verify(digest, password))) {
        throw new Error("warm-up digest did not verify against its own password");
      }
    } catch (error) {
      warmupFailures.push({ stage: "warmup", index, message: describeError(error) });
    }
  }

  // Stage 1: sequential hash. Digests are retained for stage 2.
  const sequentialHash = await runStage({
    stage: "sequential-hash",
    entries: Array.from({ length: opts.samples }, (_, index) => ({
      index,
      password: syntheticPassword(index),
    })),
    concurrency: 1,
    operation: ({ password }) => argon2.hash(password, optionsFor()),
  });

  // Stage 2: sequential verify, over the digests stage 1 produced.
  const sequentialVerify = await runStage({
    stage: "sequential-verify",
    entries: sequentialHash.results,
    concurrency: 1,
    operation: async ({ entry, value }) => {
      const matches = await argon2.verify(value, entry.password);
      if (!matches) throw new Error("digest did not verify against the password that produced it");
      return matches;
    },
  });

  // Stage 3: concurrent hash. No verify runs until this stage has fully settled.
  const concurrentHash = await runStage({
    stage: "concurrent-hash",
    entries: Array.from({ length: opts.samples }, (_, index) => ({
      index,
      password: syntheticPassword(opts.samples + index),
    })),
    concurrency: opts.concurrency,
    operation: ({ password }) => argon2.hash(password, optionsFor()),
  });

  // Stage 4: concurrent verify, over the digests stage 3 produced.
  const concurrentVerify = await runStage({
    stage: "concurrent-verify",
    entries: concurrentHash.results,
    concurrency: opts.concurrency,
    operation: async ({ entry, value }) => {
      const matches = await argon2.verify(value, entry.password);
      if (!matches) throw new Error("digest did not verify against the password that produced it");
      return matches;
    },
  });

  // Verification reads the parameters encoded in the stored hash, not the config.
  let crossParameterVerification;
  const crossParameterFailures = [];
  try {
    const legacyDigest = await argon2.hash("s7-bench-legacy", {
      ...baseOptions,
      memoryCost: 4096,
      salt: randomBytes(opts.saltLength),
    });
    crossParameterVerification = await argon2.verify(legacyDigest, "s7-bench-legacy");
  } catch (error) {
    crossParameterVerification = false;
    crossParameterFailures.push({
      stage: "cross-parameter",
      index: -1,
      message: describeError(error),
    });
  }

  const failures = [
    ...warmupFailures,
    ...sequentialHash.failures,
    ...sequentialVerify.failures,
    ...concurrentHash.failures,
    ...concurrentVerify.failures,
    ...crossParameterFailures,
  ];

  const after = readProcStatus();
  const cgroupAfter = readCgroup();

  const report = {
    generatedAt: new Date().toISOString(),
    library: "@node-rs/argon2",
    params: {
      memoryCostKiB: opts.memoryCost,
      timeCost: opts.timeCost,
      parallelism: opts.parallelism,
      outputLength: opts.outputLength,
      saltLength: opts.saltLength,
    },
    workload: {
      requestedSamplesPerStage: opts.samples,
      warmupIterations: opts.warmup,
      concurrency: opts.concurrency,
      stages: ["sequential-hash", "sequential-verify", "concurrent-hash", "concurrent-verify"],
    },
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      hostLogicalCpus: cpus().length,
      cgroup: {
        version: cgroup.version,
        supported: cgroup.supported,
        processPath: cgroup.processPath,
        resolvedPath: cgroup.resolvedPath,
        mountPoint: cgroup.mountPoint,
        effectiveMemoryLimitBytes: cgroup.limitBytes,
        effectiveMemoryLimitRaw: cgroup.limitRaw,
        memoryLimitSourcePath: cgroup.limitSourcePath,
        effectiveCpuCpus: cgroup.cpuEffectiveCpus,
        cpuQuotaRaw: cgroup.cpuQuotaRaw,
        cpuSourcePath: cgroup.cpuSourcePath,
        levels: cgroup.levels,
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
      note: "baselineRssBytes and afterRssBytes are current snapshots; peakRssBytes is the kernel high-water mark (VmHWM), not a current snapshot; resourceMaxRssBytes is process.resourceUsage().maxRSS (KiB on Linux); cgroup figures are scope-wide for the process cgroup, not benchmark-only memory",
    },
    guard,
    latencyMs: {
      sequential: {
        hash: summarise(sequentialHash.latencies),
        verify: summarise(sequentialVerify.latencies),
      },
      concurrent: {
        hash: summarise(concurrentHash.latencies),
        verify: summarise(concurrentVerify.latencies),
      },
    },
    crossParameterVerification,
    failures: {
      count: failures.length,
      byStage: countByStage(failures),
      samples: failures.slice(0, 10),
    },
    verdict: {
      memoryGuard: guard.verdict,
      suitableForLatencyAnalysis: failures.length === 0,
      suitableForResourceEvaluation: guard.suitableForResourceEvaluation && failures.length === 0,
      complete: failures.length === 0,
    },
  };

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    printSummary(report);
    console.log(JSON.stringify(report, null, 2));
  }

  if (failures.length > 0) process.exit(4);
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
  const cgroup = environment.cgroup;
  console.error("");
  console.error(
    `node ${environment.node}  ${environment.platform}/${environment.arch}  host cpus=${environment.hostLogicalCpus}`,
  );
  console.error(
    `cgroup v${cgroup.version ?? "?"}  path=${cgroup.resolvedPath ?? "unresolved"}  ` +
      `memory.max=${cgroup.effectiveMemoryLimitRaw ?? "unknown"}  cpu=${cgroup.effectiveCpuCpus ?? "unknown"}`,
  );
  console.error(`guard: ${guard.verdict}${guard.reason ? ` — ${guard.reason}` : ""}`);
  console.error(line("sequential hash", latencyMs.sequential.hash));
  console.error(line("sequential verify", latencyMs.sequential.verify));
  console.error(line("concurrent hash", latencyMs.concurrent.hash));
  console.error(line("concurrent verify", latencyMs.concurrent.verify));
  console.error(
    `rss current=${mib(memory.afterRssBytes)} peak=${mib(memory.peakRssBytes)} (VmHWM)  cgroup peak=${mib(memory.cgroupPeakBytes)}`,
  );
  console.error(
    `failures: ${report.failures.count}  resource-evaluable: ${report.verdict.suitableForResourceEvaluation}`,
  );
  console.error("");
}

const fmt = (value) => (value === null ? "n/a" : value.toFixed(1));
const mib = (bytes) => (bytes === null ? "n/a" : `${(bytes / MiB).toFixed(1)} MiB`);

await main();
