import type { GridRegistry, GridSpec, TargetSelectorEntry } from "@agroclimate/contracts";
import { resolveGridCell, targetSelectorHashOf } from "@agroclimate/contracts";
import type { ForecastRecordInput } from "@agroclimate/database";
import {
  configureTransactionTimeouts,
  IngestionTerminalError,
  InvariantViolationError,
  LeaseLostError,
  lockForecastRun,
  lockJobForSettlement,
  persistForecastRun,
  ProviderCoordinateDriftError,
  revalidateLease,
  settlePairAsWorker,
} from "@agroclimate/database";
import {
  createFetchTransport,
  fetchDailyEnsemble,
  fetchDailyForecast,
  normalizeDailyPrecipitation,
  type AdapterOutcome,
  type DailyAdapterConfig,
  type DailyProviderPayload,
  type Transport,
} from "@agroclimate/weather-core";

import type { ClaimedJob } from "../queue/types.js";
import type { HandlerResult, JobHandler } from "../runner.js";

/**
 * `ingest.forecast` — the short-range forecast handler, Phase 5.4.
 *
 * Two gates run before a single byte is requested:
 *
 * - **OPEN-18**: the grid must be `validated`. `requireValidated` is the only
 *   lookup used, and the registry shipped today contains one `synthetic` entry,
 *   so every real job dies with `grid_not_validated` rather than borrowing a
 *   lattice. Wiring the handler does not open the gate; supplying a validated
 *   registry does.
 * - The selector hash in the payload must match the selector in the payload. A
 *   queue row is not a trusted authority for which cells were approved.
 *
 * The write half is one transaction (T3): transaction-local bounds first, then
 * Job → IngestionRun → advisory lock, a lease re-check after the advisory wait,
 * the data writes, and the settlement — in that order, in one transaction. A
 * lost lease after the advisory wait rolls the whole thing back.
 */

export interface ForecastHandlerOptions {
  readonly registry: GridRegistry;
  readonly attribution: string;
  readonly transport?: Transport | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly baseUrl?: string | undefined;
}

/** The relationship the timeout chain encodes: 5 s < 10 s < 20 s < 30 s. */
export const FORECAST_TIMEOUTS = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  transactionTimeoutMs: 20_000,
  maxWaitMs: 2_000,
  /** Leaving less than this after the advisory wait is not enough to write. */
  minRemainingLeaseMs: 30_000,
} as const;

interface RunRow {
  readonly provider: string;
  readonly model: string;
  readonly product: string;
  readonly initializedAt: Date;
}

interface RequestedCell {
  readonly cellKey: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly variable: string;
}

/** Everything one adapter answer contributes to the transaction. */
interface FetchedCell {
  readonly cellKey: string;
  readonly payload: DailyProviderPayload;
  readonly values: ReturnType<typeof normalizeDailyPrecipitation>;
}

const SUPPORTED_VARIABLES = new Set(["precipitation"]);

function terminal(code: string, message: string): HandlerResult {
  return { outcome: "terminal", error: { code, message, retryable: false } };
}

function retryable(code: string, message: string): HandlerResult {
  return { outcome: "retryable", error: { code, message, retryable: true } };
}

function mapAdapterFailure(
  label: string,
  outcome: Extract<AdapterOutcome<unknown>, { ok: false }>,
): HandlerResult {
  switch (outcome.kind) {
    case "rate_limited":
    case "transport":
      return retryable(outcome.kind, `${label}: ${outcome.message}`);
    case "incomplete_horizon":
      return terminal(`${label}_incomplete`, outcome.message);
    default:
      return terminal(`${label}_${outcome.kind}`, outcome.message);
  }
}

function cellsFromSelector(
  selector: readonly TargetSelectorEntry[],
  spec: GridSpec,
): RequestedCell[] {
  const cells: RequestedCell[] = [];
  for (const entry of selector) {
    if (!SUPPORTED_VARIABLES.has(entry.variable)) {
      throw new InvariantViolationError(
        `variable "${entry.variable}" has no adapter in this build; supported: ${[...SUPPORTED_VARIABLES].join(", ")}`,
      );
    }
    const [latitude, longitude] = entry.cellKey.split(",");
    if (latitude === undefined || longitude === undefined) {
      throw new InvariantViolationError(`cell key "${entry.cellKey}" is not "lat,lon"`);
    }
    // Round-trip through the resolver: a key that does not resolve back to
    // itself is not on this grid, and fetching it would store a cell the
    // registry never approved.
    const resolved = resolveGridCell(spec, { lat: latitude, lon: longitude });
    if (resolved.cellKey !== entry.cellKey) {
      throw new InvariantViolationError(
        `cell key "${entry.cellKey}" is not a node of grid "${spec.gridId}" (resolved to "${resolved.cellKey}")`,
      );
    }
    cells.push({
      cellKey: entry.cellKey,
      latitude: Number(resolved.nodeLat),
      longitude: Number(resolved.nodeLon),
      variable: entry.variable,
    });
  }
  return cells;
}

export function createForecastHandler(options: ForecastHandlerOptions): JobHandler {
  const transport = options.transport ?? createFetchTransport();
  const now = options.now ?? (() => new Date());
  const runtime = {
    transport,
    now,
    timeoutMs: options.timeoutMs ?? 20_000,
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
  };

  async function fetchCell(run: RunRow, cell: RequestedCell): Promise<HandlerResult | FetchedCell> {
    const config: DailyAdapterConfig = {
      latitude: cell.latitude,
      longitude: cell.longitude,
      attribution: options.attribution,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    };

    const outcome =
      run.product === "ensemble"
        ? await fetchDailyEnsemble(config, runtime)
        : await fetchDailyForecast(config, runtime);
    if (!outcome.ok) return mapAdapterFailure(cell.variable, outcome);

    const normalized = normalizeDailyPrecipitation(outcome.value, cell.cellKey);
    if (!normalized.ok) return mapAdapterFailure(cell.variable, normalized);

    return { cellKey: cell.cellKey, payload: outcome.value, values: normalized };
  }

  return {
    kind: "ingest.forecast",
    opensIngestionRun: true,

    async handle(job: ClaimedJob, context): Promise<HandlerResult> {
      const payload = job.payload as {
        forecastRunId: string;
        targetSelectorHash: string;
        targetSelector?: { cells: TargetSelectorEntry[] };
        normalizerVersion: string;
      };

      if (payload.targetSelector === undefined) {
        return terminal(
          "selector_missing",
          "the job payload carries no targetSelector; an ingest cannot guess its cells",
        );
      }

      // The digest is the approval; the cells are the work. They must agree.
      if (targetSelectorHashOf(payload.targetSelector) !== payload.targetSelectorHash) {
        return terminal(
          "selector_hash_mismatch",
          "targetSelector does not hash to targetSelectorHash; refusing to fetch unapproved cells",
        );
      }

      const runRows = await context.db.$queryRaw<RunRow[]>`
        SELECT provider,
               model,
               product,
               initialized_at AS "initializedAt"
          FROM app.forecast_runs
         WHERE id = ${payload.forecastRunId}::uuid
      `;
      const run = runRows[0];
      if (run === undefined) {
        return terminal(
          "forecast_run_missing",
          `forecast run ${payload.forecastRunId} does not exist`,
        );
      }
      if (run.product !== "forecast" && run.product !== "ensemble") {
        return terminal(
          "unsupported_product",
          `product "${run.product}" has no short-range adapter`,
        );
      }

      let cells: RequestedCell[];
      let spatialResolutionKm: number | null = null;
      try {
        const spec = options.registry.requireValidated({
          provider: run.provider,
          model: run.model,
        });
        spatialResolutionKm = spec.spatialResolutionKm;
        cells = cellsFromSelector(payload.targetSelector.cells, spec);
      } catch (error) {
        const code =
          error instanceof InvariantViolationError ? "selector_invalid" : "grid_not_validated";
        return terminal(code, error instanceof Error ? error.message : String(error));
      }

      const fetched: FetchedCell[] = [];
      for (const cell of cells) {
        const result = await fetchCell(run, cell);
        if ("outcome" in result) return result;
        fetched.push(result);
      }

      const records: ForecastRecordInput[] = [];
      for (const cell of fetched) {
        if (!cell.values.ok) {
          return mapAdapterFailure(cell.cellKey, cell.values);
        }
        for (const value of cell.values.value.values) {
          records.push({
            cellKey: value.cellKey,
            variable: value.variable,
            unit: value.unit,
            validAt: new Date(value.validAt),
            value: value.value,
            temporalResolution: value.temporalResolution,
            ensembleMember: value.ensembleMember,
            ensembleSize: value.ensembleSize,
            aggregationLevel: value.aggregationLevel,
            requestedLat: cell.payload.requestedLatitude,
            requestedLon: cell.payload.requestedLongitude,
            servedLat: cell.payload.servedLatitude,
            servedLon: cell.payload.servedLongitude,
            servedValueIsInterpolated: false,
            spatialResolutionKm,
            sourceUrl: cell.payload.sourceUrl,
            attribution: cell.payload.attribution,
          });
        }
      }

      if (records.length === 0) {
        return terminal("empty_result", "the provider answered with no daily values");
      }

      const covered = new Set(
        records
          .filter((record) => record.value !== null)
          .map((record) => `${record.variable}\u0000${record.cellKey}`),
      );
      const coveragePercent =
        cells.length === 0 ? 0 : Math.round((covered.size / cells.length) * 10_000) / 100;

      try {
        return await context.db.$transaction(
          async (tx): Promise<HandlerResult> => {
            // Statement 1: a bound that is applied after the first lock wait is
            // not a bound at all.
            await configureTransactionTimeouts(tx, {
              lockTimeoutMs: FORECAST_TIMEOUTS.lockTimeoutMs,
              statementTimeoutMs: FORECAST_TIMEOUTS.statementTimeoutMs,
            });

            const lockedJob = await lockJobForSettlement(tx, job.id);
            if (
              lockedJob.status !== "running" ||
              lockedJob.leaseToken !== job.leaseToken ||
              !lockedJob.leaseLive
            ) {
              throw new LeaseLostError();
            }
            const runId = lockedJob.ingestionRunId;
            if (runId === null) {
              throw new InvariantViolationError(
                "the handler opened no ingestion run; the settlement refuses to invent one",
              );
            }

            const runRows = await tx.$queryRaw<{ status: string; createdAt: Date }[]>`
              SELECT status, created_at AS "createdAt"
                FROM app.ingestion_runs
               WHERE id = ${runId}::uuid
                 FOR UPDATE
            `;
            const runRow = runRows[0];
            if (runRow === undefined) {
              throw new InvariantViolationError(`ingestion run ${runId} vanished under its job`);
            }
            if (runRow.status !== "running") {
              throw new IngestionTerminalError(runRow.status);
            }

            await lockForecastRun(tx, payload.forecastRunId);

            // The advisory wait can be seconds. Ownership is re-proved against
            // the locked row, not against the claim that started the handler.
            const stillOwned = await revalidateLease(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              minRemainingMs: FORECAST_TIMEOUTS.minRemainingLeaseMs,
            });
            if (!stillOwned) throw new LeaseLostError();

            const persisted = await persistForecastRun(tx, {
              forecastRunId: payload.forecastRunId,
              ingestionRunId: runId,
              provider: run.provider,
              model: run.model,
              product: run.product as "forecast" | "ensemble",
              dataClass: "weather_forecast",
              initializedAt: run.initializedAt,
              ingestionCreatedAt: runRow.createdAt,
              normalizerVersion: payload.normalizerVersion,
              records,
            });

            const to = coveragePercent >= 100 ? "succeeded" : "partial";
            await settlePairAsWorker(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              mode: {
                mode: "succeed",
                to,
                recordCount: persisted.inserted,
                coveragePercent,
              },
            });

            return {
              outcome: "settled",
              to,
              recordCount: persisted.inserted,
              coveragePercent,
            };
          },
          {
            maxWait: FORECAST_TIMEOUTS.maxWaitMs,
            timeout: FORECAST_TIMEOUTS.transactionTimeoutMs,
          },
        );
      } catch (error) {
        if (error instanceof ProviderCoordinateDriftError) {
          return terminal("provider_changed", error.message);
        }
        throw error;
      }
    },
  };
}
