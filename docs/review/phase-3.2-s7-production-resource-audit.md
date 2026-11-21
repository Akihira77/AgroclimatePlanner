# Phase 3.2 — S7 Production Deployment and Runtime Resource Audit

| Field | Value |
|---|---|
| Status | **READ-ONLY AUDIT COMPLETE — EVIDENCE INSUFFICIENT FOR A BENCHMARK** |
| Audited | 2026-11-21, `master` @ `a0d6bcd` |
| Scope | Deployment architecture actually present in the repository, the runtime resources that apply to `apps/api`, and Argon2id benchmark readiness |
| Not in scope | running the benchmark, installing dependencies, editing manifests, changing deployment configuration, production changes |
| Verdict | **NOT READY — MISSING RESOURCE EVIDENCE** (§11) |

Evidence labels used throughout:

- **Implemented** — the artifact exists in the repository or the running system and was inspected.
- **Documented** — asserted only in prose; no artifact backs it.
- **Missing** — searched for and not found.
- **Unverified** — could not be established read-only with the access available.

Every figure below is either read from a named file or marked `Unknown`. No number is an
estimate.

## 1. Executive Summary

- The repository contains **no** API deployment artifact: no `Dockerfile`, no CI workflow,
  no Kubernetes/Helm/systemd unit, no reverse-proxy configuration, no deploy script. The
  only Compose file runs PostgreSQL for development and says so in its first line.
- The architecture document describes a single-node Compose production stack (`web`, `api`,
  `worker`, `postgres`, `redis`, `caddy`). That file was searched for and does not exist.
  It is **Documented**, not **Implemented**.
- No production host, credential, or deployment target is referenced in the repository, so
  **production runtime access was unavailable**. No attempt was made to discover
  credentials or hosts, per the task rules.
- Consequently the effective memory limit, CPU quota, replica count, and baseline RSS of the
  production API are all `Unknown`. There is nothing to compute IG-6's "peak RSS ≤ 25% of the
  container memory limit" against.
- The development host is characterised fully (§8), but it is **not** production evidence:
  it is a WSL2 laptop with `memory.max = max` at every cgroup level and no CPU quota.
- Argon2id parameters stay provisional. The harness must not be run for resource evaluation
  until a finite limit exists.

## 2. Repository Deployment Findings

Search performed over the whole tree (excluding `node_modules`), for `Dockerfile*`,
`docker-compose*.{yml,yaml}`, `compose*.yml`, `*.service`, `Chart.yaml`,
`kustomization.yaml`, `*.k8s.yaml`, `Caddyfile`, `nginx.conf`, `fly.toml`, `render.yaml`,
`vercel.json`, `app.yaml`, `Procfile`, and the directories `.github`, `.circleci`, `infra`,
`deploy`, `deployment`, `k8s`, `helm`, `terraform`, `ansible`.

| Artifact | Status | Evidence |
|---|---|---|
| `Dockerfile` / image build for any app | **Missing** | `find` returned no match; `git ls-files` has no such path |
| Docker Compose for API/worker/web | **Missing** | only `docker-compose.yml`, which defines `db` alone |
| Compose override / prod override | **Missing** | no `docker-compose.*.yml` variant exists |
| Kubernetes manifests / Helm charts | **Missing** | no `Chart.yaml`, `kustomization.yaml`, manifest directory |
| systemd unit for the API | **Missing** | no `*.service` in the tree; nothing under `/etc/systemd/system` was installed by this repo |
| CI/CD workflow | **Missing** | no `.github/`, no `.gitlab-ci.yml`, no `.circleci` |
| Deploy script | **Missing** | root scripts are build/typecheck/lint/test/dev and `db:*` only |
| Reverse proxy config (`caddy`, `nginx`) | **Missing** | named in architecture prose, absent as configuration |
| Redis/BullMQ deployment | **Missing** | `bullmq` appears in the worker's plan; no service definition exists |
| PostgreSQL deployment for production | **Documented** | `docker-compose.yml:1` — "Production runs on a managed instance"; no managed-instance configuration exists |
| Environment templates | **Implemented** | `.env.example` present; `.env` present and **not read** (secret-bearing) |

Root `package.json` scripts confirm there is no deployment path: `build`, `typecheck`,
`lint`, `test`, `dev`, and database helpers. The API is started by
`apps/api/package.json` `"start": "node dist/main.js"` — a bare process with no supervisor,
no restart policy, and no resource limits declared anywhere.

Documentation claims, for the record:

- `docs/architecture/system-architecture.md:237` — "Docker Compose for dev and single-node
  prod: `web`, `api`, `worker`, `postgres` (PostGIS), `redis`, `caddy` (TLS + reverse
  proxy). Horizontal scaling of `worker` by replica count; `api` stateless behind the
  proxy." **Documented, contradicted by the tree.**
- `docs/architecture/system-architecture.md:7` — "three deployables and a shared package
  graph. One Postgres, one Redis, one object store". **Documented.**

## 3. Actual Production Deployment Architecture

**Unknown.** Nothing in the repository describes or configures a live production
environment, and no deployment access was available.

What can be stated with evidence:

| Question | Answer | Basis |
|---|---|---|
| Is a production deployment configured in this repository? | No | §2 search |
| Is a production host named in the repository? | No | no host, domain, or SSH target in tracked files |
| Are deploy credentials present in the repository? | No | no tracked key/secret file; `.env` untracked and unread |
| Is the API currently running on this host? | No | `pgrep -af "dist/main.js"` matched only an unrelated project (`super-tool`) |
| Is any API container running on this host? | No | `docker ps` lists four `postgis` containers and unrelated third-party services, no Agroclimate API |
| Production replicas | `Unknown` | nothing to inspect |
| Managed PostgreSQL instance | `Unknown` | claimed in `docker-compose.yml:1`, no configuration or endpoint |

The architecture document is therefore a **plan**, not a description of running
infrastructure. It must not be used as evidence that the API runs in Compose with those
six services.

## 4. API Runtime Details

Production: **Unavailable** (§3).

Development host, which is the only runtime observable here. It is recorded to make the
development-versus-production contrast explicit, not as a production surrogate:

| Item | Value | Source | Type |
|---|---|---|---|
| Node.js version | `v24.14.0` | `node -v` | Implemented |
| Node.js executable | `/home/akihira17/.local/share/mise/installs/node/24.14.0/bin/node` | `process.execPath` | Implemented |
| Architecture | `x64` | `process.arch` | Implemented |
| OS | Ubuntu 24.04.5 LTS | `/etc/os-release` | Implemented |
| Kernel | `6.6.87.2-microsoft-standard-WSL2` | `uname -srm` | Implemented |
| Host form factor | WSL2 virtual machine on a laptop | kernel string | Implemented |
| Container runtime | none for this process | no `/.dockerenv`, no `/run/.containerenv` | Implemented |
| Process manager | none | no supervisor unit or PID 1 manager for this process | Implemented |
| API process (Agroclimate) | not running | `pgrep` showed only an unrelated `super-tool` process | Implemented |

Host facts: `Intel(R) Core(TM) i5-14450HX`, 12 logical CPUs (`nproc`), `MemTotal`
12,248,264 kB (≈ 11.7 GiB), `MemAvailable` 4,378,168 kB at inspection, `SwapTotal`
12,582,912 kB (`/proc/meminfo`).

## 5. Effective Memory Constraints

### 5.1 Production

| Item | Value |
|---|---|
| Effective memory limit for `apps/api` | **Unknown** |
| `memory.current` / `memory.peak` for the API cgroup | **Unknown** |
| `memory.events` / OOM history | **Unknown** |
| Memory reservation, swap limit | **Unknown** |
| Replica count driving aggregate pressure | **Unknown** |

No container, unit, or manifest exists to carry a limit, so there is no finite number to
read and none was inferred.

### 5.2 Development host (cgroup v2, for contrast only)

Resolution method, matching what the harness does: `0::` entry in `/proc/self/cgroup` gives
the process path; `/proc/self/mountinfo` gives the `cgroup2` mount at `/sys/fs/cgroup`; the
path is rebased on the mount and every ancestor is inspected.

| Level (relative to mount) | `memory.max` | `memory.current` | `memory.peak` | `memory.swap.max` | `cpu.max` | `cpuset.cpus.effective` |
|---|---|---|---|---|---|---|
| `…/tmux-spawn-706952a3-….scope` (process) | `max` | 1,654,919,168 B | 2,152,828,928 B | `max` | file absent | absent |
| `…/app-tmux.slice` | `max` | 2,161,491,968 B | 2,701,721,600 B | `max` | `max 100000` | `0-11` |
| `…/app.slice` | `max` | 2,325,262,336 B | 2,811,195,392 B | `max` | `max 100000` | `0-11` |
| `user@1000.service` | `max` | 2,335,440,896 B | 2,820,501,504 B | `max` | `max 100000` | `0-11` |
| `user-1000.slice` | `max` | 2,371,801,088 B | 2,870,337,536 B | `max` | `max 100000` | `0-11` |
| `user.slice` | `max` | 2,378,039,296 B | 2,876,116,992 B | `max` | `max 100000` | `0-11` |
| mount root | file absent | absent | absent | absent | file absent | `0-11` |

`memory.events` at the process cgroup: `low 0`, `high 0`, `max 0`, `oom 0`, `oom_kill 0`,
`oom_group_kill 0`.

Interpretation: **no finite memory limit exists at any level**, so the effective limit is
`Unknown` — correctly, since `max` means "no budget declared here", not "infinite budget".
The figures in this table belong to the agent's `tmux` scope and include unrelated
processes; they are not an API baseline and are not deployment evidence.

## 6. Effective CPU Constraints

| Item | Production | Development host |
|---|---|---|
| Host logical CPUs | `Unknown` | 12 (`nproc`; `cpuset.cpus.effective` = `0-11`) |
| Effective CPU quota / period | `Unknown` | `Unknown` — every ancestor reports `max 100000` (no quota); process cgroup has no `cpu.max` |
| Effective CPU set | `Unknown` | `0-11`, not narrower than the host |
| Ancestor CPU constraints | `Unknown` | none finite |
| Effective CPU capacity available to the API | `Unknown` | up to 12 logical CPUs, unbounded by quota |

Argon2 cost is CPU-bound, so a latency measured with 12 unbounded logical CPUs is not a
lower bound for a throttled container. The development host cannot stand in for the
production allocation.

## 7. Other Resource Constraints

| Constraint | Production | Development host | Source |
|---|---|---|---|
| `Max open files` | `Unknown` | 1,048,576 | `/proc/self/limits` |
| `Max processes` | `Unknown` | 47,805 | `/proc/self/limits` |
| `Max locked memory` | `Unknown` | 67,108,864 B (64 MiB) | `/proc/self/limits` |
| `Max resident set` | `Unknown` | `unlimited` | `/proc/self/limits` |
| `Max address space` | `Unknown` | `unlimited` | `/proc/self/limits` |
| Stack size | `Unknown` | 8,192 KiB | `ulimit -s` |
| Container memory reservation | `Unknown` | none | no container |
| Swap limit | `Unknown` | `memory.swap.max = max` | cgroup file |
| systemd `MemoryMax` / `CPUQuota` / `AllowedCPUs` | `Unknown` | none set for this scope | cgroup files above |
| Kubernetes requests/limits | `Unknown` | n/a | no manifests |
| Orchestrator constraints | `Unknown` | n/a | none |

Absent configuration is reported as `Unknown`, not as "no limit". A managed platform can
impose limits that leave no trace in the repository.

## 8. Development vs Production Comparison

| Dimension | Development (observed) | Production (evidence) |
|---|---|---|
| Runtime | Node `v24.14.0`, `x64`, glibc | `Unknown` |
| Container | none, host process | `Unknown` |
| Memory limit | none (`max` at all levels) | `Unknown` |
| Memory headroom | host-wide, shared with unrelated processes | `Unknown` |
| CPU allocation | 12 logical CPUs, no quota | `Unknown` |
| Replicas | 1 process, not running | `Unknown` |
| Reverse proxy | none | `Documented` (`caddy`), `Missing` |
| PostgreSQL | local container `postgis/postgis:18-3.6` | `Documented` managed instance, `Unknown` |
| Baseline RSS of the API | not measured; API not running | `Unknown` |

The two columns are not comparable. Only the runtime *constraint* (Node `>=24.14.0`) is
shared, and only because it is declared in `package.json`.

## 9. Argon2id Benchmark Readiness

Harness reviewed as-is: `apps/api/scripts/benchmark-argon2.mjs` @ `a0d6bcd`. **Not modified
in this task.**

| Requirement | Required evidence | Available now | Status |
|---|---|---|---|
| Memory limit | Effective finite memory limit for the API | none exists | **Missing** |
| CPU capacity | Effective quota / cpuset | production unknown; dev unbounded | **Missing** |
| Runtime | Actual Node version and architecture | dev `v24.14.0` `x64`; production unknown | **Partial (dev only)** |
| Deployment topology | API replicas and relevant sidecars | no manifest, no replicas known | **Missing** |
| Concurrency | Maximum safe concurrency | cannot be derived without a limit | **Missing** |
| Memory headroom | Capacity after baseline workload | baseline RSS unmeasured; API not running | **Missing** |
| Runtime representativeness | Benchmark environment matches production | dev host is a WSL2 laptop with no cgroup limits | **Missing** |

Existing guard, unchanged: `estimatedPeak = baselineRss + memoryCost × parallelism ×
concurrency × 1.25`, refused when it exceeds 25% of the limit, with the limit unknown →
concurrency > 1 refused outright and concurrency 1 permitted only as `latency-only` under
`--allow-unbounded-memory`.

Consequence of the missing evidence, using the harness's own arithmetic and a **notional**
80 MiB baseline: `80 + 19 × 1 × 4 × 1.25 = 175 MiB`, which needs a container limit of at
least 700 MiB. That 80 MiB is illustrative, not a measurement — the real baseline must come
from the API image.

### Recommendations

- **Can the benchmark run now?** Only as a development-host latency exercise: the library is
  absent (exit `2`), and with the limit unknown the guard refuses concurrency 4 (exit `3`).
  It cannot produce resource evidence.
- **Is concurrency 1 safe for a first measurement?** Safe *as a process* on any host — one
  Argon2 pool cannot exhaust memory — but only via `--concurrency 1
  --allow-unbounded-memory`, which marks the run `latency-only` and
  `suitableForResourceEvaluation: false`. Its numbers cannot close IG-6.
- **Can concurrency 4 be tested safely?** No. Not on this host and not on any host whose
  container limit is unproven. Four 19 MiB pools at once are bounded only by a declared
  limit, and none is declared. The current guard correctly refuses this.
- **Is a staging environment needed?** Yes. A staging deployment carrying the same image,
  memory limit, CPU quota, and sidecars is the minimum for a representative run. Without a
  finite limit there is no target to measure against.
- **What still blocks the test?** A finite memory limit, an effective CPU quota or cpuset, a
  built API image, confirmation of the Node runtime inside it, and the installed
  `@node-rs/argon2@2.2.2`. Installing that dependency remains an owner action.

## 10. Missing Information and Blockers

1. **API image or process definition** — nothing runs and nothing is built into a deployable
   artifact. Without it there is no baseline RSS, no sidecar set, and no limit.
2. **Finite container memory limit** — the single hard blocker for IG-6's RSS criterion.
3. **CPU quota or cpuset** — without it, latency is not transferable and concurrency cannot
   be justified.
4. **Node runtime of the deployed image** — `engines.node >= 24.14.0` is a declaration, not
   proof. `Unknown` whether the production image honours it.
5. **Replica count and sidecars sharing the cgroup** — aggregate memory pressure is
   unknowable without them.
6. **Managed PostgreSQL endpoint and pool size** — affects API RSS indirectly; unverified.
7. **Dependency installation** — `@node-rs/argon2@2.2.2` is not in any manifest; the harness
   exits `2` until it is.

Runtime consistency note: the `Node 22` cells in `system-architecture.md` were already
corrected to `Node.js (engines >=24.14.0)` in `a0d6bcd`, because the workspace `engines`
cannot be satisfied by Node 22. That correction states the constraint only; it does not
claim the production image runs Node 24. No further documentation change is made here, and
the production runtime remains `Unknown`.

## 11. Recommended Next Steps

In order, each read-only or owner-authorised:

1. **Owner decision on the deployment shape.** Either create the API image and Compose
   service the architecture describes, or record the real hosting platform. The audit
   cannot invent it.
2. **Declare a memory limit** for that container (or read it from the platform), then
   confirm it with the ancestor walk in §5.2 applied inside the deployment.
3. **Declare or read the CPU quota**, and confirm `cpuset.cpus.effective`.
4. **Owner installs the dependency**:
   `pnpm --filter @agroclimate/api add @node-rs/argon2@2.2.2`.
5. **Run the harness inside that envelope**, default `--concurrency 4` first; the guard will
   refuse rather than overshoot if the limit is insufficient.
6. **Record the numbers** against IG-6 and only then finalise the parameter row.

Operator commands for a read-only deployment inspection, once a host exists. All are
non-mutating:

```bash
# runtime identity
node -v; node -p "process.execPath"; uname -srm; nproc
cat /proc/self/cgroup
grep cgroup2 /proc/self/mountinfo

# limits for the API process (replace <pid>)
cat /proc/<pid>/cgroup
cat /proc/<pid>/limits

# effective limits, walking the cgroup ancestors
cg=$(sed -n 's/^0:://p' /proc/<pid>/cgroup)
d=/sys/fs/cgroup$cg
while [ -n "$d" ]; do
  printf '%s mem.max=%s mem.cur=%s mem.peak=%s swap.max=%s cpu.max=%s cpuset=%s\n' \
    "$d" "$(cat $d/memory.max 2>/dev/null)" "$(cat $d/memory.current 2>/dev/null)" \
    "$(cat $d/memory.peak 2>/dev/null)" "$(cat $d/memory.swap.max 2>/dev/null)" \
    "$(cat $d/cpu.max 2>/dev/null)" "$(cat $d/cpuset.cpus.effective 2>/dev/null)"
  [ "$d" = /sys/fs/cgroup ] && break
  d=$(dirname "$d")
done
cat /sys/fs/cgroup${cg}/memory.events 2>/dev/null
```

If the platform is Kubernetes instead, the equivalent is
`kubectl get pod <pod> -o jsonpath='{.spec.containers[*].resources}'` and
`kubectl exec <pod> -- cat /sys/fs/cgroup/memory.max`.

## 12. Evidence and Commands

Timestamp: 2026-11-21, host `WSL2 / Ubuntu 24.04.5`, repository `master` @ `a0d6bcd`.

| Command | Purpose | Result |
|---|---|---|
| `git status -sb` | working tree before audit | clean, `master...origin/master` |
| `find` over `Dockerfile*`, compose, k8s, helm, caddy, nginx, systemd, `Procfile` | deployment artifacts | only `./docker-compose.yml` |
| `ls -d .github .gitlab-ci.yml .circleci infra deploy k8s helm terraform ansible` | CI/infra | none exist |
| `git ls-files \| grep -iE "docker\|compose\|\.github\|deploy\|infra\|k8s\|helm\|caddy\|nginx"` | tracked deployment files | `docker-compose.yml` only |
| `cat docker-compose.yml` | development DB only? | confirmed; `db` service alone |
| `node -e` on root and API `package.json` | engines and scripts | `engines.node >= 24.14.0`; no deploy script; API has no `engines` |
| `grep` for deploy/production in `README.md`, `docs/` | documented deployment | `docs/architecture/system-architecture.md:7,237` only |
| `node -v`, `node -p process.execPath/arch/platform` | runtime identity | `v24.14.0`, mise path, `x64`, `linux` |
| `uname -srm`, `/etc/os-release` | OS/kernel | WSL2 kernel, Ubuntu 24.04.5 |
| `cat /proc/self/cgroup`, `grep cgroup /proc/self/mountinfo` | cgroup version and mount | cgroup v2, `/sys/fs/cgroup` |
| ancestor walk over `memory.max`, `memory.current`, `memory.peak`, `memory.swap.max`, `cpu.max`, `cpuset.cpus.effective` | effective limits | all `max`; no quota; cpuset `0-11` |
| `cat <process cgroup>/memory.events` | OOM history | all counters `0` |
| `grep -E "Max open files\|Max processes\|..." /proc/self/limits` | ulimits | table in §7 |
| `nproc`, `/proc/cpuinfo`, `/proc/meminfo` | host capacity | 12 CPUs, i5-14450HX, 11.7 GiB RAM, 12 GiB swap |
| `pgrep -af "dist/main.js\|@agroclimate/api"` | is the API running | no Agroclimate API; an unrelated `super-tool` process |
| `docker ps` | is an API container running | four `postgis` dev containers, no API |

Not performed, by scope: benchmark execution, dependency installation, any write to
manifest, lockfile, schema, migration, deployment configuration, or production system.

No secret, credential, token, key, or environment value is recorded in this document.
`.env` was not opened.
