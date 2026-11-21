# Phase 3.2 — S7 Local Argon2id Benchmark Results

| Field | Value |
|---|---|
| Status | **BENCHMARK COMPLETED — PARAMETER RECOMMENDED (local/personal scope)** |
| Executed | 2026-11-21, 03:37–03:39 UTC (10:37–10:39 +07:00), `master` @ `a0d6bcd` + dependency commit-pending |
| Scope | Argon2id measurement on the development host, parameter evaluation for local/personal use |
| Not asserted | production readiness, container memory safety, concurrency-4 safety |
| Predecessor | `docs/review/phase-3.2-s7-production-resource-audit.md` (unchanged) |

All numbers in this document are measurements produced by
`apps/api/scripts/benchmark-argon2.mjs` on the host described in §2. Nothing is estimated.
Fields that could not be measured are marked `Unknown`.

## 1. Executive Summary

- Six parameter combinations were measured sequentially, 100 samples per stage, four
  isolated stages each: sequential hash, sequential verify, concurrent hash, concurrent
  verify.
- Zero failures across all six runs; the cross-parameter verification passed in all six.
- The cgroup memory limit is unknown on this host (`memory.max = max` at every ancestor),
  so every run was concurrency 1 with `--allow-unbounded-memory` and is marked
  `suitableForResourceEvaluation: false`. **No concurrency data was collected; the
  "concurrent" columns are single-operation numbers and are not contention evidence.**
- Measured pool cost matches `memoryCost`: process peak RSS rose by 13.8, 20.7, 21.3, 48.0,
  65.7 and 66.4 MiB above a ≈ 52 MiB baseline for 12/19/19/46/64/64 MiB configurations.
  **Parallelism did not change the footprint**, measured at p=1, p=2 and p=4 on 64 MiB.
- Recommendation for local/personal use: **m=65536 KiB, t=3, p=4** (the RFC 9106 second
  recommended option), measured at **25.1 ms p50 / 27.4 ms p95** hash and **118.2 MiB**
  process peak RSS. Fallbacks and thresholds in §10.
- IG-6's parameter table in `phase-3.2-s7-owner-decisions.md` is **not** edited here. The
  recommendation needs an owner decision to be adopted.

## 2. Benchmark Environment

| Item | Value | Source |
|---|---|---|
| Host | WSL2 VM on Windows, kernel `6.6.87.2-microsoft-standard-WSL2` | `uname -srm` |
| Distribution | Ubuntu 24.04.5 LTS | `/etc/os-release` |
| CPU | Intel Core i5-14450HX, 12 logical CPUs | `nproc`, `/proc/cpuinfo` |
| Architecture | `x64` | `process.arch` |
| Node.js | `v24.14.0` | `node -v` |
| Node executable | `/home/akihira17/.local/share/mise/installs/node/24.14.0/bin/node` | `process.execPath` |
| pnpm | `12.18.0` | `pnpm -v` |
| Container | none — the benchmark ran as a host process | no `/.dockerenv`; cgroup path under `tmux-spawn-*.scope` |
| cgroup version | v2, mount `/sys/fs/cgroup` | `/proc/self/cgroup`, `/proc/self/mountinfo` |

Measured at 03:37:15 UTC, immediately before the first run:

| Metric | Value |
|---|---|
| `MemTotal` | 12,248,264 kB (11.68 GiB) |
| `MemAvailable` | 4,099,952 kB (3.91 GiB) |
| `SwapTotal` | 12,582,912 kB (12.0 GiB) |
| cgroup `memory.max` (all ancestors) | `max` — **no finite limit** |
| cgroup `memory.current` | 2,065,584,128 B (1.92 GiB, whole `tmux` scope) |
| cgroup `memory.events` | `low 0`, `high 0`, `max 0`, `oom 0`, `oom_kill 0`, `oom_group_kill 0` |
| cgroup `cpu.max` | absent at the process scope; `max 100000` (no quota) at ancestors |
| `cpuset.cpus.effective` | `0-11` |

The host is shared with unrelated services: four `postgis` development containers and
several third-party containers were running. That inflates cgroup scope memory and can
perturb latency slightly; it does not change the process-level figures.

## 3. Resource Availability

| Boundary | Value | Note |
|---|---|---|
| Host RAM (Windows view) | `Unknown` | not read; WSL2 reports only the VM view |
| WSL2 VM RAM | 12,248,264 kB total, 4,099,952 kB available | `/proc/meminfo` |
| WSL2 swap | 12,582,912 kB | `/proc/meminfo` |
| Process cgroup memory limit | `Unknown` — `max` at every level | not a hard limit |
| Process cgroup memory use | 1.92 GiB scope-wide | includes unrelated processes |
| Effective CPU quota | `Unknown` — no `cpu.max` quota | all 12 CPUs usable |
| Effective CPU set | `0-11` | full host |
| Process RSS ceiling | `unlimited` (`/proc/self/limits`) | no rlimit pressure |

Process cgroup memory and host memory are different quantities. The 3.91 GiB available is
an observation, not a ceiling; `memory.max = max` means the kernel enforces no limit.

## 4. Dependency Version

| Item | Value |
|---|---|
| Package | `@node-rs/argon2` |
| Version | `2.2.2` (exact, no range) |
| Manifest | `apps/api/package.json` `dependencies` |
| Installed by | `pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2 --save-exact` |
| Lockfile | `pnpm-lock.yaml` updated with `@node-rs/argon2@2.2.2` and its platform optional packages |
| Transitive dependencies | none at runtime; one platform binary (`@node-rs/argon2-linux-x64-gnu`) |
| Install scripts | none |
| Other manifest changes | none |

Approval basis: `ARGON2ID-LIB` approved 2026-11-20
(`phase-3.2-s7-dependency-options.md` §2). No other dependency was added or upgraded.

## 5. Benchmark Methodology

Harness: `apps/api/scripts/benchmark-argon2.mjs` @ `a0d6bcd`, **unmodified in this task**.

- Four stages, executed in order and never overlapped: `sequential-hash` →
  `sequential-verify` → `concurrent-hash` → `concurrent-verify`. Verify stages consume
  digests produced by the preceding hash stage, so a verify never overlaps a hash.
- 10 warm-up iterations per candidate, discarded.
- 100 measured samples per stage (`--samples 100`, the harness minimum).
- `--concurrency 1 --allow-unbounded-memory` for every candidate: the effective cgroup
  memory limit is unknown, so the guard refuses concurrency > 1 and permits only a
  latency-only, single-pool run.
- Fresh random 16-byte salt per hash; synthetic passwords (`s7-bench-<n>-<random>`).
- Every produced digest was verified against the password that produced it; a mismatch
  would have thrown and been counted as a failure.
- Argon2id only, 32-byte output.
- Runs executed one at a time, in the order shown in §6, to avoid cross-candidate
  contention.

Guard verdict for all six runs: `latency-only`, `suitableForResourceEvaluation: false`,
`suitableForLatencyAnalysis: true`, `complete: true`.

## 6. Candidate Parameters

| # | Label | memoryCost | timeCost | parallelism | Rationale |
|---|---|---:|---:|---:|---|
| 1 | `m19456-t2-p1` | 19456 KiB (19 MiB) | 2 | 1 | IG-6 provisional row; OWASP first recommended option |
| 2 | `m47104-t1-p1` | 47104 KiB (46 MiB) | 1 | 1 | OWASP second recommended option |
| 3 | `m12288-t3-p1` | 12288 KiB (12 MiB) | 3 | 1 | OWASP third recommended option |
| 4 | `m19456-t2-p2` | 19456 KiB (19 MiB) | 2 | 2 | parallelism probe at the provisional memory cost |
| 5 | `m65536-t3-p1` | 65536 KiB (64 MiB) | 3 | 1 | RFC 9106 second recommended option, single-threaded |
| 6 | `m65536-t3-p4` | 65536 KiB (64 MiB) | 3 | 4 | RFC 9106 second recommended option, four lanes |

Candidates 2–6 were added for a technical reason, not by preference: 1, 2 and 3 are the
three parameter sets that current guidance treats as equivalent minimum-strength options,
and 4 and 6 isolate the effect of `parallelism`, which the task asks to evaluate. No
candidate weakens memory cost below the 19 MiB guidance floor except #3, which is included
as the documented low-memory alternative.

## 7. Measurement Results

Latency in milliseconds. `n = 100` per stage, all six runs.

| # | Label | seq hash p50 | seq hash p95 | seq hash max | seq hash mean | seq verify p50 | seq verify p95 | seq verify max | seq verify mean |
|---|---|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | `m19456-t2-p1` | 15.66 | 16.97 | 17.98 | 15.74 | 15.33 | 16.45 | 17.78 | 15.43 |
| 2 | `m47104-t1-p1` | 23.98 | 26.44 | 31.35 | 24.32 | 23.96 | 25.28 | 42.00 | 24.18 |
| 3 | `m12288-t3-p1` | 12.47 | 13.48 | 14.65 | 12.51 | 12.17 | 13.02 | 13.73 | 12.24 |
| 4 | `m19456-t2-p2` | 10.03 | 11.77 | 18.84 | 10.26 | 9.83 | 11.08 | 13.29 | 9.94 |
| 5 | `m65536-t3-p1` | 80.30 | 89.97 | 111.29 | 81.64 | 78.10 | 82.31 | 120.81 | 79.27 |
| 6 | `m65536-t3-p4` | 25.14 | 27.39 | 28.75 | 25.30 | 25.18 | 28.73 | 42.77 | 25.68 |

Concurrent stages, run at concurrency 1. These are single-operation numbers, not
contention data:

| # | Label | conc hash p50 | conc hash p95 | conc hash max | conc verify p50 | conc verify p95 | conc verify max |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `m19456-t2-p1` | 15.55 | 16.50 | 17.11 | 15.71 | 18.96 | 22.18 |
| 2 | `m47104-t1-p1` | 24.06 | 26.56 | 38.40 | 23.59 | 25.73 | 49.02 |
| 3 | `m12288-t3-p1` | 12.76 | 14.02 | 14.34 | 12.60 | 13.63 | 16.04 |
| 4 | `m19456-t2-p2` | 9.79 | 10.84 | 11.85 | 9.87 | 12.05 | 12.52 |
| 5 | `m65536-t3-p1` | 78.60 | 83.53 | 88.30 | 78.19 | 82.03 | 91.29 |
| 6 | `m65536-t3-p4` | 25.36 | 27.70 | 49.18 | 26.22 | 31.06 | 34.13 |

Run metadata:

| # | Label | Started (UTC) | Wall time | Failures | Cross-parameter verify | `complete` |
|---|---|---|---:|---:|---|---|
| 1 | `m19456-t2-p1` | 03:37:21 | 6.68 s | 0 | `true` | `true` |
| 2 | `m47104-t1-p1` | 03:37:40 | 10.29 s | 0 | `true` | `true` |
| 3 | `m12288-t3-p1` | 03:37:50 | 9.66 s | 0 | `true` | `true` |
| 4 | `m19456-t2-p2` | 03:37:54 | 4.29 s | 0 | `true` | `true` |
| 5 | `m65536-t3-p1` | 03:38:34 | 36.58 s | 0 | `true` | `true` |
| 6 | `m65536-t3-p4` | 03:39:44 | 10.92 s | 0 | `true` | `true` |

No candidate failed. No verification returned false. Every stage recorded exactly 100
latency samples.

## 8. Memory Analysis

Process figures are the benchmark process: `VmRSS` before/after and the kernel high-water
mark `VmHWM` (`peakRssBytes`), which equals `process.resourceUsage().maxRSS` in every run.
cgroup figures are scope-wide for the shared `tmux` cgroup and include unrelated services —
they are **not** benchmark-only memory.

| # | Label | Baseline RSS | After RSS | Peak RSS (VmHWM) | Δ peak − baseline | cgroup current (after) | cgroup peak (scope-wide) |
|---|---|---:|---:|---:|---:|---:|---:|
| 1 | `m19456-t2-p1` | 54,620,160 B (52.09 MiB) | 56,410,112 B | 76,333,056 B (72.80 MiB) | +20.71 MiB | 1,991,569,408 B | 2,284,896,256 B |
| 2 | `m47104-t1-p1` | 54,415,360 B (51.89 MiB) | 56,549,376 B | 104,783,872 B (99.93 MiB) | +48.04 MiB | 2,002,972,672 B | 2,284,896,256 B |
| 3 | `m12288-t3-p1` | 54,337,536 B (51.82 MiB) | 56,258,560 B | 68,841,472 B (65.65 MiB) | +13.83 MiB | 2,002,059,264 B | 2,284,896,256 B |
| 4 | `m19456-t2-p2` | 54,267,904 B (51.75 MiB) | 56,668,160 B | 76,591,104 B (73.04 MiB) | +21.29 MiB | 2,001,129,472 B | 2,284,896,256 B |
| 5 | `m65536-t3-p1` | 54,185,984 B (51.68 MiB) | 55,947,264 B | 123,056,128 B (117.35 MiB) | +65.67 MiB | 1,983,344,640 B | 2,284,896,256 B |
| 6 | `m65536-t3-p4` | 54,276,096 B (51.76 MiB) | 55,943,168 B | 123,895,808 B (118.16 MiB) | +66.39 MiB | 1,990,795,264 B | 2,284,896,256 B |

Observations supported by these rows:

1. **Peak delta tracks `memoryCost`**, plus roughly 1.8–2.7 MiB of allocator overhead:
   12 MiB → 13.83 MiB, 19 MiB → 20.71 MiB, 46 MiB → 48.04 MiB, 64 MiB → 65.67 MiB.
2. **`parallelism` does not multiply the footprint on this implementation.** 19 MiB at p=1
   (+20.71 MiB) and p=2 (+21.29 MiB) are indistinguishable; 64 MiB at p=1 (+65.67 MiB) and
   p=4 (+66.35 MiB) are indistinguishable. `memoryCost` behaves as the total pool, with
   lanes sharing it.
3. **The harness guard is conservative for p > 1.** It estimates
   `baseline + memoryCost × parallelism × concurrency × 1.25`, i.e. 104 MB for 19 MiB/p=2 and
   390 MB for 64 MiB/p=4, while measured peaks were 76.6 MB and 123.9 MB. The guard was not
   changed — the over-estimate errs toward safety.
4. **Baseline RSS is stable** at 51.68–52.09 MiB across six separate processes, so the
   delta column is meaningful at this granularity.
5. cgroup `memory.peak` is constant at 2,284,896,256 B because it is a monotonic scope-wide
   counter that already contained earlier peaks from unrelated work.

## 9. Parameter Comparison

| # | Label | Pool | Hash p95 | Verify p95 | Peak RSS | Security position | Guard estimate | Min limit for 25% rule |
|---|---|---:|---:|---:|---:|---|---:|---:|
| 3 | `m12288-t3-p1` | 12 MiB | 13.48 ms | 13.02 ms | 65.65 MiB | Below the 19 MiB guidance floor; t=3 compensates partially | 70,066,176 B | ≈ 267 MiB |
| 1 | `m19456-t2-p1` | 19 MiB | 16.97 ms | 16.45 ms | 72.80 MiB | OWASP first option, the current provisional row | 79,523,840 B | ≈ 303 MiB |
| 4 | `m19456-t2-p2` | 19 MiB | 11.77 ms | 11.08 ms | 73.04 MiB | Same hardness as #1, half the wall time | 104,075,264 B | ≈ 397 MiB |
| 2 | `m47104-t1-p1` | 46 MiB | 26.44 ms | 25.28 ms | 99.93 MiB | OWASP second option; t=1 leaves less time margin | 114,708,480 B | ≈ 438 MiB |
| 6 | `m65536-t3-p4` | 64 MiB | 27.39 ms | 28.73 ms | 118.16 MiB | RFC 9106 second option; 3.2× faster than p=1 at identical memory | 389,820,416 B | ≈ 1.45 GiB |
| 5 | `m65536-t3-p1` | 64 MiB | 89.97 ms | 82.31 ms | 117.35 MiB | RFC 9106 second option, single-threaded | 138,072,064 B | ≈ 527 MiB |

Reading the table:

- Memory hardness and time hardness are independent axes. #2 buys 46 MiB of memory but only
  one iteration; #5 and #6 buy 64 MiB **and** three iterations at 24–90 ms. For a password
  store expected to live for years, iterations matter, so #2 is dominated.
- #3 is the lowest-memory candidate (12 MiB). It is included for completeness and is not
  recommended: it sits below the 19 MiB floor that current guidance starts from.
- #4 shows that `parallelism` is free in memory here and halves latency at 19 MiB; #6 shows
  the same at 64 MiB with a larger absolute gain.
- The 25 % column is arithmetic on the guard's own estimate, not a measured container limit.
  No container limit exists on this host, so none of these rows is a memory-safety proof.

## 10. Recommended Configuration

### Preferred

| Parameter | Value |
|---|---|
| Algorithm | Argon2id |
| `memoryCost` | **65536 KiB (64 MiB)** |
| `timeCost` | **3** |
| `parallelism` | **4** |
| `outputLen` | 32 bytes |
| `salt` | 16 bytes, random per hash |

Measured on this host (candidate #6): hash p50 **25.14 ms**, p95 **27.39 ms**, max 28.75 ms;
verify p50 25.18 ms, p95 28.73 ms, max 42.77 ms; process peak RSS **118.16 MiB** over a
51.76 MiB baseline; 0 failures; cross-parameter verification `true`.

Why this one: it is the RFC 9106 second recommended option, so it is not a locally invented
set; it is three iterations over 64 MiB, comfortably above every guidance floor in §6; it
fits the 250 ms verify budget by an order of magnitude; and its 118 MiB peak is irrelevant
on a host with 11.68 GiB. `p=4` costs no measurable memory (118.16 vs 117.35 MiB) and cuts
hash p95 from 89.97 ms to 27.39 ms on this 12-CPU host.

### Fallbacks, in order

1. **`m=65536, t=3, p=1`** — same hardness, single-threaded. Use when the runtime is limited
   to fewer than four usable CPUs, or when the guard must fit a container limit below
   ≈ 1.45 GiB. Measured: hash p95 89.97 ms, peak 117.35 MiB. Latency is still well inside
   the 250 ms criterion.
2. **`m=19456, t=2, p=1`** — the OWASP first option and the current provisional row. Use only
   if a future deployment is memory-constrained enough that a 64 MiB pool is unacceptable
   (guard threshold ≈ 303 MiB for concurrency 1). Measured: hash p95 16.97 ms, peak 72.80 MiB.

### Things this evidence does not decide

- **Concurrency.** Not measured. The measured numbers are single-operation; four simultaneous
  logins at 64 MiB would reserve four pools. The guard's estimate for `p=1`, concurrency 4 is
  138 MB, but no limit exists here to judge 25 % against.
- **Production parameters.** `phase-3.2-s7-production-resource-audit.md` remains in force:
  there is no API image, no deployment, and no container limit. If the app is ever deployed,
  IG-6's rule "final parameters come from the benchmark on the deployment host" still applies
  and this recommendation must be re-validated there.
- **`parallelism` above 4.** Untested. The default libuv thread pool is 4, so `p=4` already
  occupies it; higher values would contend rather than speed up.

### Status of the IG-6 provisional row

Unchanged in `phase-3.2-s7-owner-decisions.md`. Adopting this recommendation is an owner
decision; the table there still records 19456/2/1 as provisional. Nothing in the runtime
reads these values yet, so no code depends on either row.

## 11. Limitations

1. **Latency-only, no resource evaluation.** The effective cgroup memory limit is `max`, so
   the guard admitted only concurrency 1 with `--allow-unbounded-memory`. Every run is
   `suitableForResourceEvaluation: false`. These numbers cannot prove that concurrency 4 is
   memory-safe anywhere.
2. **No concurrency measurement at all.** The `concurrent-*` stages ran at concurrency 1 by
   construction; they duplicate the sequential figures rather than measuring contention. This
   is a guard consequence, not a harness defect.
3. **Shared host.** Unrelated containers and processes shared the cgroup during the runs.
   Process-level RSS is unaffected by them; latency may be slightly pessimistic, and
   cgroup scope figures are not benchmark-only.
4. **WSL2 virtualisation.** Timings come from a virtualised Linux kernel. Bare-metal numbers
   on the same CPU model would differ, probably favourably.
5. **Single host, single session.** No repeat run on a second machine, no day-to-day
   variance study. `n=100` per stage bounds the tail estimate only coarsely.
6. **Guard over-estimates for `p > 1`** (§8 observation 3). Documented, deliberately not
   changed: weakening the guard to make a benchmark pass was out of scope.
7. **No deployment, no production evidence.** Out of scope by instruction; the production
   audit stands unmodified.

## 12. Reproduction Commands

```bash
# dependency (already applied)
pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2 --save-exact

# harness validation
node --check apps/api/scripts/benchmark-argon2.mjs
node apps/api/scripts/benchmark-argon2.mjs --self-test     # 39 checks
node apps/api/scripts/benchmark-argon2.mjs --help

# guard behaviour without a known memory limit
node apps/api/scripts/benchmark-argon2.mjs                 # exit 3, concurrency 4 refused

# measured runs, one at a time
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 19456 --time 2 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 47104 --time 1 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 12288 --time 3 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 19456 --time 2 --parallelism 2
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 65536 --time 3 --parallelism 1
node apps/api/scripts/benchmark-argon2.mjs --samples 100 --concurrency 1 \
  --allow-unbounded-memory --json --memory 65536 --time 3 --parallelism 4
```

Environment snapshot used for §2 and §3:

```bash
date -Is; node -v; nproc; uname -srm
grep -E "^(MemTotal|MemAvailable|SwapTotal)" /proc/meminfo
cat /proc/self/cgroup
grep cgroup2 /proc/self/mountinfo
cg=$(sed -n 's/^0:://p' /proc/self/cgroup)
cat /sys/fs/cgroup$cg/memory.current /sys/fs/cgroup$cg/memory.events
```

Verification of this document's own changes:

```bash
node --check apps/api/scripts/benchmark-argon2.mjs
node apps/api/scripts/benchmark-argon2.mjs --self-test
git diff --check
git status --short
```
