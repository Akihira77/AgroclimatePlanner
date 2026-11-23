import type { GridRegistry, GridSpec, TargetSelectorEntry } from "@agroclimate/contracts";
import { resolveGridCell, targetSelectorHashOf } from "@agroclimate/contracts";
import type { ForecastRecordInput } from "@agroclimate/database";
import {
  configureTransactionTimeouts,
  IngestionTerminalError,
  InvariantViolationError,
  LeaseLostError,
  lockForecastWriteScope,
  lockJobForSettlement,
  persistForecastRun,
  ProviderCoordinateDriftError,
  revalidateLease,
  settlePairAsWorker,
  type ForecastFootprint,
} from "@agroclimate/database";
import {
  aggregateMonthlyMemberTotals,
  createFetchTransport,
  fetchEc46Daily,
  fetchSeas5MemberDaily,
  fetchSeas5Monthly,
  normalizeDailyPrecipitation,
  normalizeMonthlySeries,
  type AdapterOutcome,
  type DailyAdapterConfig,
  type DailyProviderPayload,
  type Seas5MonthlyConfig,
  type Seas5MonthlyPayload,
  type Transport,
} from "@agroclimate/weather-core";

import type { ClaimedJob } from "../queue/types.js";
import type { HandlerResult, JobHandler } from "../runner.js";
import { NODE_COORDINATE_TOLERANCE_DEGREES } from "./climatology.js";

/**
 * `ingest.climate` — the seasonal handler, Phase 5.6.
 *
 * Two products, one queue, two data classes, never merged:
 *
 * - **EC46** (`ecmwf_ec46`) → `subseasonal_forecast`, daily values, lead days
 *   15–45. The adapter returns the provider's full 46-day axis so the anchor
 *   (index == lead day) can be asserted; this handler stores only lead days
 *   15–45, because days 0–14 belong to the short-range product and because
 *   `persistForecastRun` supersedes on `(cell, variable, valid_at, member)`
 *   alone — an overlapping band would make two models overwrite each other.
 * - **SEAS5** (`ecmwf_seas5`) → `seasonal_forecast`, monthly values, 7 rows.
 *   The provider-native `precipitation_mean` keeps its name, its `mm` unit, and
 *   its value: no monthly→daily, no `valueMm`, no renormalisation (F-09).
 *
 * Gates before a byte is requested: the selector digest must match the
 * selector, and `requireValidated` must know the grid (OPEN-18). The shipped
 * registry has no seasonal entry, so a real job dies `grid_not_validated`.
 *
 * Nothing here computes spread, probability, or confidence. EC46's 50 members
 * are stored as member rows so a later phase can derive spread from real
 * members; the mean column is never stored as if it were deterministic
 * (ADR-001 D8/D8b).
 *
 * SEAS5 publishes its own `precipitation_mean` monthly series and, verified
 * 2026-11-23, 50 daily members. The mean is stored as its own row; the members
 * are aggregated **per member, per calendar month** at ingest and stored as
 * member rows, because members are ephemeral (ADR-001 D8b). No spread is
 * computed here — this handler only makes it derivable.
 */

export interface SeasonalHandlerOptions {
  readonly registry: GridRegistry;
  readonly attribution: string;
  readonly transport?: Transport | undefined;
  readonly now?: (() => Date) | undefined;
  readonly timeoutMs?: number | undefined;
  readonly maxBytes?: number | undefined;
  readonly baseUrl?: string | undefined;
}

/** Seasonal payloads are MB-scale and slow; the write window is wider than short-range. */
export const SEASONAL_TIMEOUTS = {
  lockTimeoutMs: 5_000,
  statementTimeoutMs: 20_000,
  transactionTimeoutMs: 40_000,
  maxWaitMs: 3_000,
  /** Leaving less than this after the advisory wait is not enough to write. */
  minRemainingLeaseMs: 30_000,
} as const;

export const SEASONAL_ADAPTER_TIMEOUT_MS = 60_000;
export const SEASONAL_ADAPTER_MAX_BYTES = 16 * 1024 * 1024;

/**
 * The first lead day the subseasonal band owns. Day 0–14 is the short-range
 * product's; EC46 is stored from day 15 so the bands stay disjoint
 * (`temporal-and-weather-semantics.md` §3).
 */
export const EC46_FIRST_SUBSEASONAL_LEAD_DAY = 15;

interface SeasonalProduct {
  readonly dataClass: "subseasonal_forecast" | "seasonal_forecast";
  readonly aggregation: string;
}

/** Model → data class. The model, not the product column, chooses the class. */
const PRODUCTS = new Map<string, SeasonalProduct>([
  ["ecmwf_ec46", { dataClass: "subseasonal_forecast", aggregation: "daily_sum" }],
  ["ecmwf_seas5", { dataClass: "seasonal_forecast", aggregation: "monthly_mean" }],
]);

/**
 * The selector asks for the quantity; storage keeps the provider's variable
 * name. SEAS5 publishes `precipitation_mean`, so a row says exactly that.
 */
const SUPPORTED_SELECTOR_VARIABLES = new Set(["precipitation"]);

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
}

interface FetchedCell {
  readonly requested: RequestedCell;
  readonly payload: DailyProviderPayload | Seas5MonthlyPayload;
  /**
   * SEAS5 only: the daily member series the monthly aggregates are built from.
   * Fetched beside the monthly answer, because members are ephemeral and an
   * aggregate that is not taken now can never be taken (ADR-001 D8b).
   */
  readonly memberDaily?: DailyProviderPayload | undefined;
}

function terminal(code: string, message: string): HandlerResult {
  return { outcome: "terminal", error: { code, message, retryable: false } };
}

function retryable(code: string, message: string): HandlerResult {
  return { outcome: "retryable", error: { code, message, retryable: true } };
}

function mapAdapterFailure(
  label: string,
  cellKey: string,
  outcome: Extract<AdapterOutcome<unknown>, { ok: false }>,
): HandlerResult {
  const message = `cell ${cellKey}: ${outcome.message}`;
  switch (outcome.kind) {
    case "rate_limited":
    case "transport":
      return retryable(outcome.kind, message);
    case "incomplete_horizon":
      return terminal(`${label}_incomplete`, message);
    default:
      return terminal(`${label}_${outcome.kind}`, message);
  }
}

/**
 * The payload decides whether this is a seasonal ingest. Only a
 * `ingestionJobPayloadSchema` payload carries `forecastRunId`; the climatology
 * payload deliberately does not, because a baseline has no run.
 */
export function isSeasonalJobPayload(payload: unknown): boolean {
  return (
    typeof payload === "object" &&
    payload !== null &&
    "forecastRunId" in payload &&
    "targetSelectorHash" in payload
  );
}

function cellsFromSelector(
  selector: readonly TargetSelectorEntry[],
  spec: GridSpec,
): RequestedCell[] {
  const cells = new Map<string, RequestedCell>();
  for (const entry of selector) {
    if (!SUPPORTED_SELECTOR_VARIABLES.has(entry.variable)) {
      throw new InvariantViolationError(
        `variable "${entry.variable}" has no seasonal adapter in this build; supported: ${[...SUPPORTED_SELECTOR_VARIABLES].join(", ")}`,
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

function dedupeFootprints(records: readonly ForecastRecordInput[]): ForecastFootprint[] {
  const seen = new Map<string, ForecastFootprint>();
  for (const record of records) {
    const key = `${record.cellKey}\u0000${record.variable}`;
    if (!seen.has(key)) seen.set(key, { cellKey: record.cellKey, variable: record.variable });
  }
  return [...seen.values()];
}

/** The lead-day cutoff as an instant: the axis date at index 15, or `null`. */
function subseasonalCutoff(payload: DailyProviderPayload): number | null {
  const axis = [...new Set(payload.days.map((day) => day.date))].sort();
  const from = axis[EC46_FIRST_SUBSEASONAL_LEAD_DAY];
  if (from === undefined) return null;
  const parsed = Date.parse(`${from}T00:00:00.000Z`);
  return Number.isNaN(parsed) ? null : parsed;
}

export function createSeasonalHandler(options: SeasonalHandlerOptions): JobHandler {
  const transport = options.transport ?? createFetchTransport();
  const now = options.now ?? (() => new Date());
  const runtime = {
    transport,
    now,
    timeoutMs: options.timeoutMs ?? SEASONAL_ADAPTER_TIMEOUT_MS,
    maxBytes: options.maxBytes ?? SEASONAL_ADAPTER_MAX_BYTES,
  };

  async function fetchCell(run: RunRow, cell: RequestedCell): Promise<HandlerResult | FetchedCell> {
    const base = {
      latitude: cell.latitude,
      longitude: cell.longitude,
      attribution: options.attribution,
      ...(options.baseUrl === undefined ? {} : { baseUrl: options.baseUrl }),
    };

    let outcome: AdapterOutcome<DailyProviderPayload | Seas5MonthlyPayload>;
    let monthlyConfig: Seas5MonthlyConfig | null = null;
    if (run.model === "ecmwf_ec46") {
      outcome = await fetchEc46Daily(base satisfies DailyAdapterConfig, runtime);
    } else {
      monthlyConfig = {
        ...base,
        initializedAt: run.initializedAt.toISOString(),
      };
      outcome = await fetchSeas5Monthly(monthlyConfig, runtime);
    }
    if (!outcome.ok) return mapAdapterFailure(run.model, cell.cellKey, outcome);

    const served = outcome.value;
    // The answer coordinate is not the approved node until it is proved to be.
    // The seasonal grid is a single lattice for both models; a served point
    // outside this bound is an interpolated or relocated answer (OPEN-18).
    const latOff = Math.abs(served.servedLatitude - cell.latitude);
    const lonOff = Math.abs(served.servedLongitude - cell.longitude);
    if (latOff > NODE_COORDINATE_TOLERANCE_DEGREES || lonOff > NODE_COORDINATE_TOLERANCE_DEGREES) {
      return terminal(
        "provider_coordinate_mismatch",
        `cell ${cell.cellKey}: provider served ${served.servedLatitude},${served.servedLongitude}, which is not the grid node ${cell.latitude},${cell.longitude} within ${NODE_COORDINATE_TOLERANCE_DEGREES}°`,
      );
    }

    if (monthlyConfig === null) return { requested: cell, payload: served };

    // The member request is a second answer for the same cell, and it is
    // checked on its own: a monthly answer at the node does not prove the daily
    // one is.
    const members = await fetchSeas5MemberDaily(monthlyConfig, runtime);
    if (!members.ok) {
      return mapAdapterFailure(`${run.model}_members`, cell.cellKey, members);
    }
    if (
      Math.abs(members.value.servedLatitude - cell.latitude) > NODE_COORDINATE_TOLERANCE_DEGREES ||
      Math.abs(members.value.servedLongitude - cell.longitude) > NODE_COORDINATE_TOLERANCE_DEGREES
    ) {
      return terminal(
        "provider_coordinate_mismatch",
        `cell ${cell.cellKey}: member series served ${members.value.servedLatitude},${members.value.servedLongitude}, which is not the grid node ${cell.latitude},${cell.longitude} within ${NODE_COORDINATE_TOLERANCE_DEGREES}°`,
      );
    }

    return { requested: cell, payload: served, memberDaily: members.value };
  }

  return {
    kind: "ingest.climate",
    opensIngestionRun: isSeasonalJobPayload,

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
          "the job payload carries no targetSelector; a seasonal ingest cannot guess its cells",
        );
      }
      if (targetSelectorHashOf(payload.targetSelector) !== payload.targetSelectorHash) {
        return terminal(
          "selector_hash_mismatch",
          "targetSelector does not hash to targetSelectorHash; refusing to fetch unapproved cells",
        );
      }

      const runRows = await context.db.$queryRaw<RunRow[]>`
        SELECT provider, model, product, initialized_at AS "initializedAt"
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
      if (run.product !== "seasonal") {
        return terminal("unsupported_product", `product "${run.product}" has no seasonal adapter`);
      }
      const seasonalProduct = PRODUCTS.get(run.model);
      if (seasonalProduct === undefined) {
        return terminal(
          "unsupported_product",
          `model "${run.model}" has no seasonal adapter; supported: ${[...PRODUCTS.keys()].join(", ")}`,
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
      let quantity: string | null = null;

      for (const cell of fetched) {
        const served = cell.payload;

        if (run.model === "ecmwf_ec46") {
          const daily = served as DailyProviderPayload;
          const cutoff = subseasonalCutoff(daily);
          if (cutoff === null) {
            return terminal(
              "subseasonal_window_missing",
              `cell ${cell.requested.cellKey}: the EC46 axis has no lead day ${EC46_FIRST_SUBSEASONAL_LEAD_DAY}`,
            );
          }
          const normalized = normalizeDailyPrecipitation(daily, cell.requested.cellKey);
          if (!normalized.ok)
            return mapAdapterFailure(run.model, cell.requested.cellKey, normalized);
          quantity = normalized.value.values[0]?.variable ?? "precipitation";

          for (const value of normalized.value.values) {
            if (Date.parse(value.validAt) < cutoff) continue;
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
              requestedLat: daily.requestedLatitude,
              requestedLon: daily.requestedLongitude,
              servedLat: daily.servedLatitude,
              servedLon: daily.servedLongitude,
              servedValueIsInterpolated: false,
              spatialResolutionKm,
              sourceUrl: daily.sourceUrl,
              attribution: daily.attribution,
            });
          }
          continue;
        }

        const monthly = served as Seas5MonthlyPayload;
        const normalized = normalizeMonthlySeries(monthly);
        if ("ok" in normalized)
          return mapAdapterFailure(run.model, cell.requested.cellKey, normalized);
        quantity = normalized.quantity;

        // D8b: the members are aggregated here or not at all. Each stored row is
        // one member's monthly total, which is exactly what the provider's own
        // `precipitation_mean` is the mean of — the two are cross-checkable and
        // neither replaces the other.
        const memberDaily = cell.memberDaily;
        if (memberDaily === undefined) {
          return terminal(
            "member_series_missing",
            `cell ${cell.requested.cellKey}: the SEAS5 member series was not fetched, so no monthly aggregate can be stored`,
          );
        }
        const aggregated = aggregateMonthlyMemberTotals(memberDaily, cell.requested.cellKey);
        if (!aggregated.ok) {
          return mapAdapterFailure(`${run.model}_members`, cell.requested.cellKey, aggregated);
        }

        // Two answers about the same run must describe the same months. If the
        // monthly product and the daily member window disagree, the aggregate
        // would be attached to months the mean does not cover.
        const monthlyKeys = normalized.months.map((month) => month.month);
        if (
          monthlyKeys.length !== aggregated.value.months.length ||
          monthlyKeys.some((month, index) => month !== aggregated.value.months[index])
        ) {
          return terminal(
            "provider_changed",
            `cell ${cell.requested.cellKey}: monthly mean covers ${monthlyKeys.join(", ")} but the member window covers ${aggregated.value.months.join(", ")}`,
          );
        }

        for (const month of normalized.months) {
          records.push({
            cellKey: cell.requested.cellKey,
            // The provider's own name, never renamed to `precipitation`.
            variable: normalized.quantity,
            unit: normalized.nativeUnit,
            validAt: new Date(`${month.month}T00:00:00.000Z`),
            value: month.nativeValue,
            temporalResolution: "monthly",
            ensembleMember: null,
            ensembleSize: null,
            aggregationLevel: seasonalProduct.aggregation,
            requestedLat: monthly.requestedLatitude,
            requestedLon: monthly.requestedLongitude,
            servedLat: monthly.servedLatitude,
            servedLon: monthly.servedLongitude,
            servedValueIsInterpolated: false,
            spatialResolutionKm,
            sourceUrl: monthly.sourceUrl,
            attribution: monthly.attribution,
          });
        }

        for (const value of aggregated.value.values) {
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
            requestedLat: memberDaily.requestedLatitude,
            requestedLon: memberDaily.requestedLongitude,
            servedLat: memberDaily.servedLatitude,
            servedLon: memberDaily.servedLongitude,
            servedValueIsInterpolated: false,
            spatialResolutionKm,
            sourceUrl: memberDaily.sourceUrl,
            attribution: memberDaily.attribution,
          });
        }
      }

      if (records.length === 0) {
        return terminal(
          "empty_result",
          `the provider answered with no ${quantity ?? "seasonal"} values`,
        );
      }

      const valued = records.filter((record) => record.value !== null);
      if (valued.length === 0) {
        return terminal(
          "no_values",
          `the provider returned ${records.length} seasonal values and every one is null`,
        );
      }

      const coveragePercent = Math.round((valued.length / records.length) * 10_000) / 100;
      const footprints = dedupeFootprints(records);

      try {
        return await context.db.$transaction(
          async (tx): Promise<HandlerResult> => {
            await configureTransactionTimeouts(tx, {
              lockTimeoutMs: SEASONAL_TIMEOUTS.lockTimeoutMs,
              statementTimeoutMs: SEASONAL_TIMEOUTS.statementTimeoutMs,
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

            await lockForecastWriteScope(tx, {
              forecastRunId: payload.forecastRunId,
              footprints,
            });

            const stillOwned = await revalidateLease(tx, {
              jobId: job.id,
              leaseToken: job.leaseToken,
              minRemainingMs: SEASONAL_TIMEOUTS.minRemainingLeaseMs,
            });
            if (!stillOwned) throw new LeaseLostError();

            const persisted = await persistForecastRun(tx, {
              forecastRunId: payload.forecastRunId,
              ingestionRunId: runId,
              provider: run.provider,
              model: run.model,
              product: "seasonal",
              dataClass: seasonalProduct.dataClass,
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
            maxWait: SEASONAL_TIMEOUTS.maxWaitMs,
            timeout: SEASONAL_TIMEOUTS.transactionTimeoutMs,
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
