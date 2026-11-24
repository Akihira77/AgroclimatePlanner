import { targetSelectorHashOf } from "@agroclimate/contracts";
import { outlookAggregationJobPayloadSchema } from "@agroclimate/contracts";
import { assembleClimatologyOutlook } from "@agroclimate/climate-core";
import {
  configureTransactionTimeouts,
  findOutlookCellId,
  InvariantViolationError,
  LeaseLostError,
  loadClimatologyOutlookSource,
  lockForecastFootprint,
  lockJobForSettlement,
  OutlookBaselineNotFoundError,
  OutlookCellNotFoundError,
  persistClimatologyOutlook,
  settlePairAsWorker,
} from "@agroclimate/database";

import type { HandlerResult, JobHandler } from "../runner.js";

/**
 * `aggregate` — climatology outlook materialisation, Phase 5.7A.
 *
 * No provider is called and no `IngestionRun` exists: this handler reads
 * `app.climatology_normals` and writes `app.monthly_outlooks`, all as
 * `app_system`. The `aggregate` kind already exists in `jobs_kind_check`, so no
 * queue, kind or migration is added.
 *
 * What is written is only what has real inputs behind it: the climatology months
 * (lead 8–12). Lead 1–7 are assembled by the pure layer as explicit no-value
 * entries and are **not** rows — a `not_requested` month has no `DataInputRef`
 * to name, and the contract refuses an empty `inputRefs`.
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
  statementTimeoutMs: 30_000,
  transactionTimeoutMs: 60_000,
  maxWaitMs: 2_000,
} as const;

const SUPPORTED_VARIABLE = "precipitation";

/**
 * A ceiling on selector size, not a throughput target.
 *
 * `targetSelectorSchema` has no maximum, and this handler does every cell in one
 * transaction: the measured cost is a few dozen statements per cell (12 normals
 * read, 5 months × read/stage/retire/promote), against a 60 s client-side
 * transaction bound and a 30 s statement bound. An unbounded selector would fail
 * as a transaction timeout on every attempt — retried until `dead`, with nothing
 * saying why. 256 cells leaves an order of magnitude of headroom over the ~1200
 * cells the 60 s bound could fit, and the fix for more is a per-cell fan-out
 * (Phase 6), not a larger number here.
 */
export const MAX_OUTLOOK_CELLS_PER_JOB = 256;

export interface OutlookAggregationHandlerOptions {
  readonly now?: (() => Date) | undefined;
}

function terminal(code: string, message: string): HandlerResult {
  return { outcome: "terminal", error: { code, message, retryable: false } };
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
      const parsed = outlookAggregationJobPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        return terminal(
          "payload_invalid",
          "the job payload does not satisfy outlookAggregationJobPayloadSchema",
        );
      }
      const payload = parsed.data;

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

      const computedAt = now();

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
                context.log("outlook_no_baseline", {
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

              context.log("outlook_materialised", {
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

            const recordCount = inserted + unchanged;
            // Coverage is a count of months affirmed, not a percentage: no
            // forecast axis exists to be partially covered in this phase.
            const coveragePercent = persistedMonths === 0 ? 0 : 100;

            await settlePairAsWorker(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              mode: { mode: "succeed", to: "succeeded", recordCount, coveragePercent },
            });

            return { recordCount, coveragePercent, inserted, superseded, unchanged };
          },
          {
            timeout: OUTLOOK_AGGREGATION_TIMEOUTS.transactionTimeoutMs,
            maxWait: OUTLOOK_AGGREGATION_TIMEOUTS.maxWaitMs,
          },
        );

        context.log("outlook_aggregation_settled", {
          jobId: job.id,
          firstMonth: payload.firstMonth,
          baselineVersion: payload.baselineVersion,
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
        throw error;
      }
    },
  };
}
