import type { GridRegistry, GridSpec, TargetSelectorEntry } from "@agroclimate/contracts";
import {
  climatologyJobPayloadSchema,
  resolveGridCell,
  targetSelectorHashOf,
} from "@agroclimate/contracts";
import {
  baselineHashPayloadOf,
  buildMonthlyClimatology,
  type ClimatologyCellInput,
} from "@agroclimate/climate-core";
import type { ClimatologyCellInput as ClimatologyCellBaselineInput } from "@agroclimate/database";
import {
  ClimatologyConflictError,
  configureTransactionTimeouts,
  InvariantViolationError,
  LeaseLostError,
  lockJobForSettlement,
  persistClimatologyBaseline,
  ProviderCoordinateDriftError,
  settlePairAsWorker,
} from "@agroclimate/database";
import {
  ARCHIVE_PERIOD_FROM,
  ARCHIVE_PERIOD_TO,
  createFetchTransport,
  fetchArchiveDaily,
  type AdapterOutcome,
  type ArchiveAdapterConfig,
  type ArchiveDailyPayload,
  type Transport,
} from "@agroclimate/weather-core";

import type { ClaimedJob } from "../queue/types.js";
import type { HandlerResult, JobHandler } from "../runner.js";

/**
 * `ingest.climate` — the ERA5 climatology baseline handler, Phase 5.5.
 *
 * The job kind already exists (`jobs_kind_check`), so no queue and no migration
 * are added. Climatology is a **baseline**, not a forecast: the handler opens no
 * `IngestionRun` and invents no `ForecastRun`, and the settlement primitive sees
 * a job with `ingestion_run_id IS NULL`.
 *
 * Two gates run before a byte is requested:
 *
 * - **OPEN-18**: the `(open-meteo, era5)` grid must be `validated`. The shipped
 *   registry has no such entry, so a real job dies `grid_not_validated`. Tests
 *   supply a fixture registry, which is the adapter-development allowance, not
 *   production evidence.
 * - The selector digest must match the selector. A queue row is not an approval.
 *
 * The write half is one transaction: bounds, job row lock, lease check, the
 * baseline write, and the settlement. All 12 months of every cell commit
 * together, and a conflicting value under an existing `baseline_version` throws
 * instead of overwriting.
 */
export interface ClimatologyHandlerOptions {
  readonly registry: GridRegistry;
  readonly attribution: string;
  readonly transport?: Transport | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly baseUrl?: string | undefined;
}

/** The archive window is 30 years; the bound is for the small write, not the fetch. */
export const CLIMATOLOGY_TIMEOUTS = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 10_000,
  transactionTimeoutMs: 20_000,
  maxWaitMs: 2_000,
} as const;

const SUPPORTED_VARIABLES = new Set(["precipitation"]);

interface RequestedCell {
  readonly cellKey: string;
  readonly latitude: number;
  readonly longitude: number;
}

interface FetchedCell {
  readonly cell: RequestedCell;
  readonly payload: ArchiveDailyPayload;
}

function terminal(code: string, message: string): HandlerResult {
  return { outcome: "terminal", error: { code, message, retryable: false } };
}

function retryable(code: string, message: string): HandlerResult {
  return { outcome: "retryable", error: { code, message, retryable: true } };
}

function mapAdapterFailure(
  cellKey: string,
  outcome: Extract<AdapterOutcome<unknown>, { ok: false }>,
): HandlerResult {
  const message = `cell ${cellKey}: ${outcome.message}`;
  switch (outcome.kind) {
    case "rate_limited":
    case "transport":
      return retryable(outcome.kind, message);
    case "incomplete_horizon":
      return terminal("archive_incomplete", message);
    case "unsupported_unit":
      return terminal("archive_unsupported_unit", message);
    case "invalid_config":
      return terminal("archive_invalid_config", message);
    default:
      return terminal("archive_provider_changed", message);
  }
}

function cellsFromSelector(
  selector: readonly TargetSelectorEntry[],
  spec: GridSpec,
): RequestedCell[] {
  const cells = new Map<string, RequestedCell>();
  for (const entry of selector) {
    if (!SUPPORTED_VARIABLES.has(entry.variable)) {
      throw new InvariantViolationError(
        `variable "${entry.variable}" has no climatology builder in this build; supported: ${[...SUPPORTED_VARIABLES].join(", ")}`,
      );
    }
    const [latitude, longitude] = entry.cellKey.split(",");
    if (latitude === undefined || longitude === undefined) {
      throw new InvariantViolationError(`cell key "${entry.cellKey}" is not "lat,lon"`);
    }
    const resolved = resolveGridCell(spec, { lat: latitude, lon: longitude });
    if (resolved.cellKey !== entry.cellKey) {
      throw new InvariantViolationError(
        `cell key "${entry.cellKey}" is not a node of grid "${spec.gridId}" (resolved to "${resolved.cellKey}")`,
      );
    }
    // A pair repeated in the selector is one cell of work. The digest already
    // deduped it, so fetching twice would only double the provider call.
    if (!cells.has(entry.cellKey)) {
      cells.set(entry.cellKey, {
        cellKey: entry.cellKey,
        latitude: Number(resolved.nodeLat),
        longitude: Number(resolved.nodeLon),
      });
    }
  }
  return [...cells.values()];
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function createClimatologyHandler(options: ClimatologyHandlerOptions): JobHandler {
  const transport = options.transport ?? createFetchTransport();
  const now = options.now ?? (() => new Date());
  const runtime = {
    transport,
    now,
    timeoutMs: options.timeoutMs ?? 20_000,
    // 30 years of daily values is ~200 KB; the cap is a protocol guard, not a
    // budget the real payload approaches.
    maxBytes: options.maxBytes ?? 8 * 1024 * 1024,
  };

  async function fetchCell(
    cell: RequestedCell,
    attribution: string,
  ): Promise<HandlerResult | FetchedCell> {
    const config: ArchiveAdapterConfig = {
      latitude: cell.latitude,
      longitude: cell.longitude,
      startDate: ARCHIVE_PERIOD_FROM,
      endDate: ARCHIVE_PERIOD_TO,
      attribution,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    };
    const outcome = await fetchArchiveDaily(config, runtime);
    if (!outcome.ok) return mapAdapterFailure(cell.cellKey, outcome);
    return { cell, payload: outcome.value };
  }

  return {
    kind: "ingest.climate",
    opensIngestionRun: false,

    async handle(job: ClaimedJob, context): Promise<HandlerResult> {
      const parsed = climatologyJobPayloadSchema.safeParse(job.payload);
      if (!parsed.success) {
        return terminal(
          "payload_invalid",
          "the job payload does not satisfy climatologyJobPayloadSchema",
        );
      }
      const payload = parsed.data;

      if (targetSelectorHashOf(payload.targetSelector) !== payload.targetSelectorHash) {
        return terminal(
          "selector_hash_mismatch",
          "targetSelector does not hash to targetSelectorHash; refusing to fetch unapproved cells",
        );
      }

      let cells: RequestedCell[];
      let spatialResolutionKm: number;
      try {
        const spec = options.registry.requireValidated({
          provider: payload.provider,
          model: payload.model,
        });
        spatialResolutionKm = spec.spatialResolutionKm;
        cells = cellsFromSelector(payload.targetSelector.cells, spec);
      } catch (error) {
        const code =
          error instanceof InvariantViolationError ? "selector_invalid" : "grid_not_validated";
        return terminal(code, error instanceof Error ? error.message : String(error));
      }
      if (cells.length === 0) {
        return terminal("selector_empty", "the target selector names no cell");
      }

      const fetched: FetchedCell[] = [];
      for (const cell of cells) {
        const result = await fetchCell(cell, options.attribution);
        if ("outcome" in result) return result;
        fetched.push(result);
      }

      const builderInput: ClimatologyCellInput[] = fetched.map((entry) => ({
        cellKey: entry.cell.cellKey,
        unit: entry.payload.unit,
        days: entry.payload.days.map((day) => ({ date: day.date, value: day.value })),
      }));

      const built = buildMonthlyClimatology({
        dataset: payload.baselineDataset,
        cells: builderInput,
        algorithmVersion: payload.algorithmVersion,
      });
      if (!built.ok) {
        const code =
          built.kind === "incomplete_history" ? "insufficient_history" : `baseline_${built.kind}`;
        return terminal(code, built.message);
      }
      const baseline = built.value;

      // The provenance input ref for a later derivation. Computed here so the
      // handler proves the built baseline is hashable without a ForecastRun.
      const hashPayload = baselineHashPayloadOf(
        baseline,
        baseline.cells.map((cell) => cell.cellKey),
      );

      const computedAt = now();
      const cellsInput: ClimatologyCellBaselineInput[] = baseline.cells.map((cell) => {
        const source = fetched.find((entry) => entry.cell.cellKey === cell.cellKey);
        if (source === undefined) {
          throw new InvariantViolationError(`built cell "${cell.cellKey}" has no fetched payload`);
        }
        return {
          cellKey: cell.cellKey,
          servedLat: source.payload.servedLatitude,
          servedLon: source.payload.servedLongitude,
          spatialResolutionKm,
          normals: cell.normals.map((normal) => ({
            // `1991-MM-01` is a calendar day in the builder's fixed vocabulary.
            month: new Date(`${normal.monthStart}T00:00:00.000Z`),
            valueMm: normal.valueMm,
            sampleYears: normal.sampleYears,
          })),
        };
      });

      const sampleYearTotal = baseline.cells.reduce(
        (total, cell) => total + cell.normals.reduce((sum, normal) => sum + normal.sampleYears, 0),
        0,
      );
      const coveragePercent = round2((sampleYearTotal / (baseline.cells.length * 12 * 30)) * 100);

      try {
        return await context.db.$transaction(
          async (tx): Promise<HandlerResult> => {
            await configureTransactionTimeouts(tx, {
              lockTimeoutMs: CLIMATOLOGY_TIMEOUTS.lockTimeoutMs,
              statementTimeoutMs: CLIMATOLOGY_TIMEOUTS.statementTimeoutMs,
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
                "a climatology job must not reference an ingestion run; none is created for a baseline",
              );
            }

            const persisted = await persistClimatologyBaseline(tx, {
              provider: payload.provider,
              model: payload.model,
              baselineVersion: baseline.baselineVersion,
              baselineDataset: baseline.baselineDataset,
              periodFrom: new Date(`${baseline.periodFrom}T00:00:00.000Z`),
              periodTo: new Date(`${baseline.periodTo}T00:00:00.000Z`),
              computedAt,
              cells: cellsInput,
            });

            await settlePairAsWorker(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              mode: {
                mode: "succeed",
                to: "succeeded",
                // Rows this job affirms: freshly inserted plus already-identical.
                recordCount: persisted.inserted + persisted.unchanged,
                coveragePercent,
              },
            });

            context.log("climatology_ingested", {
              jobId: job.id,
              dataset: baseline.baselineDataset,
              baselineVersion: baseline.baselineVersion,
              cells: baseline.cells.length,
              inserted: persisted.inserted,
              unchanged: persisted.unchanged,
              complete: baseline.cells.every((cell) => cell.complete),
              minSampleYears: Math.min(...baseline.cells.map((cell) => cell.minSampleYears)),
              coveragePercent,
              baselineHashCells: hashPayload.monthlyNormals.length,
            });

            return {
              outcome: "settled",
              to: "succeeded",
              recordCount: persisted.inserted + persisted.unchanged,
              coveragePercent,
            };
          },
          {
            maxWait: CLIMATOLOGY_TIMEOUTS.maxWaitMs,
            timeout: CLIMATOLOGY_TIMEOUTS.transactionTimeoutMs,
          },
        );
      } catch (error) {
        if (error instanceof ProviderCoordinateDriftError) {
          return terminal("provider_changed", error.message);
        }
        if (error instanceof ClimatologyConflictError) {
          return terminal("baseline_conflict", error.message);
        }
        throw error;
      }
    },
  };
}
