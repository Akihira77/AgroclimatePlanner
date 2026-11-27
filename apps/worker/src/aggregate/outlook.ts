import { targetSelectorHashOf } from "@agroclimate/contracts";
import {
  outlookAggregationJobPayloadSchema,
  seasonalOutlookAggregationJobPayloadSchema,
  type OutlookAggregationJobPayload,
  type SeasonalOutlookAggregationJobPayload,
} from "@agroclimate/contracts";
import {
  assembleClimatologyOutlook,
  assembleSeasonalOutlook,
  seasonalOutlookMonths,
  type SeasonalMemberTotal,
} from "@agroclimate/climate-core";
import {
  configureTransactionTimeouts,
  findOutlookCellId,
  InvariantViolationError,
  LeaseLostError,
  loadClimatologyOutlookSource,
  loadSeasonalForecastRun,
  loadSeasonalMemberPopulation,
  lockForecastFootprint,
  lockJobForSettlement,
  OutlookBaselineNotFoundError,
  OutlookCellNotFoundError,
  persistClimatologyOutlook,
  persistSeasonalOutlook,
  settlePairAsWorker,
  type TenantTransaction,
} from "@agroclimate/database";

import type { ClaimedJob } from "../queue/types.js";
import type { HandlerResult, JobHandler, LogFn } from "../runner.js";

/**
 * `aggregate` — outlook materialisation: climatology (5.7A) and seasonal (5.7D).
 *
 * No provider is called and no `IngestionRun` exists: this handler reads
 * `app.climatology_normals` and writes `app.monthly_outlooks`, all as
 * `app_system`. The `aggregate` kind already exists in `jobs_kind_check`, so no
 * queue, kind or migration is added.
 *
 * What is written is only what has real inputs behind it: the climatology months
 * (lead 7–12) and, from a complete 50-member population, the seasonal months
 * (lead 1–6). A month with no stored row is assembled as `pending` by the read
 * layer and is **not** a row — such a month has no `DataInputRef` to name, and the
 * contract refuses an empty `inputRefs`.
 *
 * The whole read/compare/write/settle sequence is one transaction. A failure
 * rolls back to the previous active row, so a broken recomputation never removes
 * the last valid answer.
 *
 * **Lock order is global, not per cell.** Every cell's footprint is locked in one
 * `lockForecastFootprint` call before the first write; that function sorts and
 * de-duplicates the set it is given. Taking the locks cell by cell would make the
 * order a property of the selector array, and two jobs holding the same cells in
 * opposite order would wait on each other (PostgreSQL `40P01`).
 *
 * Triggering is deliberately absent: nothing in this repository schedules an
 * `aggregate` job yet (there is no scheduler, and Phase 6 owns the fan-out). An
 * operator or a test enqueues it with an explicit `baselineVersion` and
 * `firstMonth`; the payload is the decision, not a clock.
 */

/** Local, small write: the bound is for the transaction, not a provider call. */
export const OUTLOOK_AGGREGATION_TIMEOUTS = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 15_000,
  transactionTimeoutMs: 30_000,
  maxWaitMs: 2_000,
} as const;

/**
 * Lease this job must still hold before it is allowed to open its transaction.
 *
 * The heartbeat cannot extend a lease while this handler works: `renew()` is a
 * plain `UPDATE app.jobs`, and the transaction holds that same row `FOR UPDATE`
 * from `lockJobForSettlement` to commit, so the renewal waits for the whole
 * transaction. When it finally runs its new term is computed from when the
 * statement *started*, so the most it can ever grant is `start + leaseMs` — it
 * cannot stretch the lease to cover a transaction that outlives it. The
 * transaction must therefore fit inside the lease it was handed, and the margin
 * covers the commit plus the gap between this check and the settle's `leaseLive`
 * read. `RUNNER_DEFAULTS.leaseMs` is 60 s, so a freshly claimed job passes.
 */
export const OUTLOOK_LEASE_HEADROOM_MS = OUTLOOK_AGGREGATION_TIMEOUTS.transactionTimeoutMs + 10_000;

const SUPPORTED_VARIABLE = "precipitation";

/**
 * A ceiling on selector size, not a throughput target.
 *
 * `targetSelectorSchema` has no maximum, and this handler does every cell in one
 * transaction: a few dozen statements per cell (12 normals read, 5 months ×
 * read/stage/retire/promote) inside a 30 s client-side bound.
 *
 * This is a **conservative operational limit, not a measured throughput
 * guarantee**. There is no load test behind it: it is a claim that 256 cells is
 * far enough below any plausible cost of that statement count that an oversized
 * selector cannot arrive as a transaction timeout, retried to `dead`, with
 * nothing saying why. Measure before raising it; per-cell fan-out (Phase 6) is
 * the real answer past a few hundred.
 */
export const MAX_OUTLOOK_CELLS_PER_JOB = 256;

export interface OutlookAggregationHandlerOptions {
  readonly now?: (() => Date) | undefined;
}

function terminal(code: string, message: string): HandlerResult {
  return { outcome: "terminal", error: { code, message, retryable: false } };
}

type AggregationPlan =
  | { readonly kind: "climatology"; readonly payload: OutlookAggregationJobPayload }
  | { readonly kind: "seasonal"; readonly payload: SeasonalOutlookAggregationJobPayload }
  | { readonly kind: "invalid" };

interface AggregationWriteCounts {
  readonly inserted: number;
  readonly superseded: number;
  readonly unchanged: number;
  readonly persistedMonths: number;
}

/** The named run is absent, or is not the provider/model/product the job names. */
export class SeasonalRunRefusedError extends Error {
  override readonly name = "SeasonalRunRefusedError";
}

/** The run's member population is not the complete conjunction §8.7C.3 requires. */
export class SeasonalPopulationIncompleteError extends Error {
  override readonly name = "SeasonalPopulationIncompleteError";
}

async function materialiseClimatologyOutlook(
  tx: TenantTransaction,
  job: ClaimedJob,
  payload: OutlookAggregationJobPayload,
  computedAt: Date,
  log: LogFn,
): Promise<AggregationWriteCounts> {
  let inserted = 0;
  let superseded = 0;
  let unchanged = 0;
  let persistedMonths = 0;

  for (const entry of payload.targetSelector.cells) {
    const outlookCellId = await findOutlookCellId(tx, {
      provider: payload.provider,
      model: payload.model,
      cellKey: entry.cellKey,
    });

    const source = await loadClimatologyOutlookSource(tx, {
      baselineVersion: payload.baselineVersion,
      outlookCellId,
    });

    const assembled = assembleClimatologyOutlook({
      firstMonth: payload.firstMonth,
      cellKey: entry.cellKey,
      baselineVersion: payload.baselineVersion,
      baselineDataset: source.baselineDataset,
      normals: source.normals,
    });
    if (!assembled.ok) {
      throw new InvariantViolationError(
        `outlook assembly refused ${entry.cellKey}: ${assembled.message}`,
      );
    }

    const derivation = assembled.value.derivation;
    if (derivation === null) {
      log("outlook_no_baseline", {
        jobId: job.id,
        cellKey: entry.cellKey,
        baselineVersion: payload.baselineVersion,
      });
      continue;
    }

    const written = await persistClimatologyOutlook(
      tx,
      {
        provider: payload.provider,
        model: payload.model,
        cellKey: entry.cellKey,
        variable: SUPPORTED_VARIABLE,
        derivationVersion: derivation.derivationVersion,
        inputRefs: derivation.inputRefs,
        inputSnapshotHash: derivation.inputSnapshotHash,
        computedAt,
        months: derivation.months,
      },
      { footprintLockHeld: true },
    );

    inserted += written.inserted;
    superseded += written.superseded;
    unchanged += written.unchanged;
    persistedMonths += derivation.months.length;

    log("outlook_materialised", {
      jobId: job.id,
      cellKey: entry.cellKey,
      baselineVersion: payload.baselineVersion,
      firstMonth: payload.firstMonth,
      months: derivation.months.length,
      monthsInserted: written.inserted,
      monthsSuperseded: written.superseded,
      monthsUnchanged: written.unchanged,
      inputSnapshotHash: derivation.inputSnapshotHash,
    });
  }

  return { inserted, superseded, unchanged, persistedMonths };
}

/**
 * `aggregate` — seasonal outlook materialisation, Phase 5.7D.
 *
 * The run is the payload's, never a "latest" lookup performed here: a resolution
 * at execution time would materialise a different forecast than the one enqueued.
 * Its initialisation month selects the six months, lead month 1 being the month
 * after initialisation.
 *
 * Every cell is read whole before anything is written. A month with fewer than the
 * 50 indices `0..49`, a null total, a mixed ingestion run, or a missing month of
 * the window throws before the row is staged; the transaction then rolls back, so
 * the previous active answer survives untouched.
 */
async function materialiseSeasonalOutlook(
  tx: TenantTransaction,
  job: ClaimedJob,
  payload: SeasonalOutlookAggregationJobPayload,
  computedAt: Date,
  log: LogFn,
): Promise<AggregationWriteCounts> {
  const run = await loadSeasonalForecastRun(tx, payload.forecastRunId);
  if (run === null) {
    throw new SeasonalRunRefusedError(`forecast run ${payload.forecastRunId} does not exist`);
  }
  if (run.provider !== payload.provider || run.model !== payload.model) {
    throw new SeasonalRunRefusedError(
      `forecast run ${payload.forecastRunId} is ${run.provider}/${run.model}, not the ${payload.provider}/${payload.model} the job names`,
    );
  }
  // `product = 'seasonal'` alone is not enough: EC46 shares it. The model literal
  // is what separates SEAS5 from a product with no monthly rows.
  if (run.product !== "seasonal") {
    throw new SeasonalRunRefusedError(
      `forecast run ${payload.forecastRunId} has product "${run.product}"; a seasonal outlook needs "seasonal"`,
    );
  }

  const initializedAt = run.initializedAt.toISOString();
  const months = seasonalOutlookMonths(initializedAt);
  if (months === null) {
    throw new InvariantViolationError(
      `forecast run ${payload.forecastRunId} has an unusable initialised_at`,
    );
  }

  let inserted = 0;
  let superseded = 0;
  let unchanged = 0;
  let persistedMonths = 0;

  for (const entry of payload.targetSelector.cells) {
    const members: SeasonalMemberTotal[] = [];
    const ingestionRunIds = new Set<string>();

    for (const month of months) {
      const population = await loadSeasonalMemberPopulation(tx, {
        forecastRunId: payload.forecastRunId,
        provider: payload.provider,
        model: payload.model,
        cellKey: entry.cellKey,
        month,
      });
      if (!population.ok) {
        throw new SeasonalPopulationIncompleteError(`${entry.cellKey}: ${population.message}`);
      }
      ingestionRunIds.add(population.population.ingestionRunId);
      for (const member of population.population.members) {
        members.push({ month, memberIndex: member.memberIndex, valueMm: member.valueMm });
      }
    }

    if (ingestionRunIds.size !== 1) {
      throw new SeasonalPopulationIncompleteError(
        `${entry.cellKey} mixes ${ingestionRunIds.size} ingestion runs across the run window; one derivation is one conversion of one run`,
      );
    }
    const ingestionRunId = [...ingestionRunIds][0] as string;

    const assembled = assembleSeasonalOutlook({
      initializedAt,
      cellKey: entry.cellKey,
      forecastRunId: payload.forecastRunId,
      ingestionRunId,
      members,
    });
    if (!assembled.ok) {
      if (assembled.kind === "incomplete_population") {
        throw new SeasonalPopulationIncompleteError(`${entry.cellKey}: ${assembled.message}`);
      }
      throw new InvariantViolationError(
        `seasonal outlook assembly refused ${entry.cellKey}: ${assembled.message}`,
      );
    }

    const derivation = assembled.value;
    const written = await persistSeasonalOutlook(
      tx,
      {
        provider: payload.provider,
        model: payload.model,
        cellKey: entry.cellKey,
        variable: SUPPORTED_VARIABLE,
        forecastRunId: payload.forecastRunId,
        ingestionRunId,
        derivationVersion: derivation.derivationVersion,
        inputRefs: derivation.inputRefs,
        inputSnapshotHash: derivation.inputSnapshotHash,
        computedAt,
        months: derivation.months,
      },
      { footprintLockHeld: true },
    );

    inserted += written.inserted;
    superseded += written.superseded;
    unchanged += written.unchanged;
    persistedMonths += derivation.months.length;

    log("seasonal_outlook_materialised", {
      jobId: job.id,
      cellKey: entry.cellKey,
      forecastRunId: payload.forecastRunId,
      initializedAt,
      months: derivation.months.length,
      monthsInserted: written.inserted,
      monthsSuperseded: written.superseded,
      monthsUnchanged: written.unchanged,
      monthsSkipped: written.skipped,
      recordSetHash: derivation.recordSetHash,
      inputSnapshotHash: derivation.inputSnapshotHash,
    });
  }

  return { inserted, superseded, unchanged, persistedMonths };
}

export function createOutlookAggregationHandler(
  options: OutlookAggregationHandlerOptions = {},
): JobHandler {
  const now = options.now ?? (() => new Date());

  return {
    kind: "aggregate",
    // An outlook is a derived artifact, not an ingestion: no run is opened, and
    // the settlement primitive sees a job with `ingestion_run_id IS NULL`.
    opensIngestionRun: false,

    async handle(job, context): Promise<HandlerResult> {
      // Two payload shapes share the `aggregate` kind: climatology (5.7A) names a
      // baseline, seasonal (5.7D) names one explicit run. `forecastRunId` is the
      // discriminator; `model` cannot be, because both shapes carry one.
      const seasonalParsed = seasonalOutlookAggregationJobPayloadSchema.safeParse(job.payload);
      const climatologyParsed = outlookAggregationJobPayloadSchema.safeParse(job.payload);
      const plan: AggregationPlan = seasonalParsed.success
        ? { kind: "seasonal", payload: seasonalParsed.data }
        : climatologyParsed.success
          ? { kind: "climatology", payload: climatologyParsed.data }
          : { kind: "invalid" };
      if (plan.kind === "invalid") {
        return terminal(
          "payload_invalid",
          "the job payload satisfies neither outlookAggregationJobPayloadSchema nor seasonalOutlookAggregationJobPayloadSchema",
        );
      }
      const payload = plan.payload;

      // The queue row is not an approval: the digest must match the selector it
      // claims to describe.
      if (targetSelectorHashOf(payload.targetSelector) !== payload.targetSelectorHash) {
        return terminal(
          "selector_digest_mismatch",
          "targetSelectorHash does not match the targetSelector it names",
        );
      }
      const unsupported = payload.targetSelector.cells.find(
        (cell) => cell.variable !== SUPPORTED_VARIABLE,
      );
      if (unsupported !== undefined) {
        return terminal(
          "unsupported_variable",
          `variable "${unsupported.variable}" cannot be materialised as an outlook month`,
        );
      }

      if (payload.targetSelector.cells.length > MAX_OUTLOOK_CELLS_PER_JOB) {
        return terminal(
          "selector_too_large",
          `a single aggregate job materialises at most ${MAX_OUTLOOK_CELLS_PER_JOB} cells; this selector names ${payload.targetSelector.cells.length}`,
        );
      }

      // Hand the lease back rather than spend an attempt on a transaction that
      // cannot fit inside it. See `OUTLOOK_LEASE_HEADROOM_MS`.
      const computedAt = now();
      const leaseRemainingMs = job.leaseExpiresAt.getTime() - computedAt.getTime();
      if (leaseRemainingMs < OUTLOOK_LEASE_HEADROOM_MS) {
        return {
          outcome: "retryable",
          error: {
            code: "lease_headroom_insufficient",
            message: `lease has ${leaseRemainingMs} ms left; this transaction is bounded at ${OUTLOOK_AGGREGATION_TIMEOUTS.transactionTimeoutMs} ms and needs ${OUTLOOK_LEASE_HEADROOM_MS} ms of lease`,
            retryable: true,
          },
        };
      }

      try {
        const counts = await context.db.$transaction(
          async (tx) => {
            await configureTransactionTimeouts(tx, {
              lockTimeoutMs: OUTLOOK_AGGREGATION_TIMEOUTS.lockTimeoutMs,
              statementTimeoutMs: OUTLOOK_AGGREGATION_TIMEOUTS.statementTimeoutMs,
            });

            const lockedJob = await lockJobForSettlement(tx, job.id);
            if (
              lockedJob.status !== "running" ||
              lockedJob.leaseToken !== job.leaseToken ||
              !lockedJob.leaseLive
            ) {
              throw new LeaseLostError();
            }
            if (lockedJob.ingestionRunId !== null) {
              throw new InvariantViolationError(
                "an outlook aggregation job must not reference an ingestion run; none is created for a derived artifact",
              );
            }

            // One call, one global order: `lockForecastFootprint` sorts and
            // de-duplicates the complete set, so two jobs with the same cells in
            // any payload order acquire the same keys in the same order.
            await lockForecastFootprint(
              tx,
              payload.targetSelector.cells.map((entry) => ({
                cellKey: entry.cellKey,
                variable: SUPPORTED_VARIABLE,
              })),
            );

            const written =
              plan.kind === "seasonal"
                ? await materialiseSeasonalOutlook(tx, job, plan.payload, computedAt, context.log)
                : await materialiseClimatologyOutlook(
                    tx,
                    job,
                    plan.payload,
                    computedAt,
                    context.log,
                  );

            const recordCount = written.inserted + written.unchanged;
            // Coverage is a count of months affirmed, not a percentage: no
            // forecast axis exists to be partially covered in this phase.
            const coveragePercent = written.persistedMonths === 0 ? 0 : 100;

            await settlePairAsWorker(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              mode: { mode: "succeed", to: "succeeded", recordCount, coveragePercent },
            });

            return {
              recordCount,
              coveragePercent,
              inserted: written.inserted,
              superseded: written.superseded,
              unchanged: written.unchanged,
            };
          },
          {
            timeout: OUTLOOK_AGGREGATION_TIMEOUTS.transactionTimeoutMs,
            maxWait: OUTLOOK_AGGREGATION_TIMEOUTS.maxWaitMs,
          },
        );

        context.log("outlook_aggregation_settled", {
          jobId: job.id,
          payloadKind: plan.kind,
          ...(plan.kind === "climatology"
            ? { firstMonth: plan.payload.firstMonth, baselineVersion: plan.payload.baselineVersion }
            : { forecastRunId: plan.payload.forecastRunId }),
          cells: payload.targetSelector.cells.length,
          monthsInserted: counts.inserted,
          monthsSuperseded: counts.superseded,
          monthsUnchanged: counts.unchanged,
          // `recordCount` is the settlement contract's number: months affirmed,
          // not rows written. The three above are the write detail.
          monthsAffirmed: counts.recordCount,
          recordCount: counts.recordCount,
        });

        return {
          outcome: "settled",
          to: "succeeded",
          recordCount: counts.recordCount,
          coveragePercent: counts.coveragePercent,
        };
      } catch (error) {
        if (error instanceof OutlookCellNotFoundError) {
          return terminal("outlook_cell_not_found", error.message);
        }
        if (error instanceof OutlookBaselineNotFoundError) {
          return terminal("baseline_unknown", error.message);
        }
        if (error instanceof SeasonalRunRefusedError) {
          return terminal("forecast_run_refused", error.message);
        }
        if (error instanceof SeasonalPopulationIncompleteError) {
          // Terminal, not retryable: the same job would read the same rows. A new
          // ingest arrives as a new IngestionRun and a new job.
          return terminal("population_incomplete", error.message);
        }
        throw error;
      }
    },
  };
}
