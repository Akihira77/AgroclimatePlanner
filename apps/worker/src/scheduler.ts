import { baselineVersionOf, CLIMATOLOGY_ALGORITHM_VERSION } from "@agroclimate/climate-core";
import { targetSelectorHashOf } from "@agroclimate/contracts";
import type { PrismaClient } from "@agroclimate/database";

import type { JobQueue } from "./queue/types.js";
import type { LogFn } from "./runner.js";

export const DEFAULT_BASELINE_VERSION = baselineVersionOf({
  dataset: "era5",
  algorithmVersion: CLIMATOLOGY_ALGORITHM_VERSION,
});
export const DEFAULT_SCHEDULER_INTERVAL_MS = 60 * 60 * 1000; // 1 hour

export interface SchedulerOptions {
  readonly db: PrismaClient;
  readonly queue: JobQueue;
  readonly log: LogFn;
  readonly baselineVersion?: string;
  readonly now?: () => Date;
}

export interface SchedulerSummary {
  readonly activeCells: number;
  readonly climatologyEnqueued: number;
  readonly outlookEnqueued: number;
  readonly forecastEnqueued: number;
  readonly seasonalDeferred: number;
}

function utcDay(now: Date): string {
  return now.toISOString().slice(0, 10);
}

function utcFirstMonth(now: Date): string {
  return `${now.toISOString().slice(0, 7)}-01`;
}

/**
 * Lightweight, idempotent worker scheduler (`OPEN-03` / `OPEN-18`).
 *
 * Discovers only active cells already registered in `app.outlook_cells` (no
 * cross-tenant `app.fields` read) and enqueues bounded jobs:
 * - `era5` climatology backfill: once per cell (skipped if 12 normals exist)
 * - `aggregate` 12-month climatology outlook: once per cell/month when normals exist
 * - `ecmwf_ifs025` daily forecast: once per UTC day per cell
 * - `ecmwf_seas5`: explicitly skipped (Reduced Gaussian Grid pending ADR-008)
 */
export async function runSchedulerTick(options: SchedulerOptions): Promise<SchedulerSummary> {
  const now = (options.now ?? (() => new Date()))();
  const baselineVersion = options.baselineVersion ?? DEFAULT_BASELINE_VERSION;
  const today = utcDay(now);
  const firstMonth = utcFirstMonth(now);

  const cellRows = await options.db.$queryRawUnsafe<
    {
      id: string;
      provider: string;
      model: string;
      cellKey: string;
      normalsCount: number;
      activeOutlooks: number;
      hasTodayForecast: boolean;
    }[]
  >(
    `SELECT oc.id::text AS id,
            oc.provider,
            oc.model,
            oc.cell_key AS "cellKey",
            (SELECT count(*)::int
               FROM app.climatology_normals cn
               JOIN app.outlook_cells era_oc ON era_oc.id = cn.outlook_cell_id
              WHERE era_oc.provider = 'open-meteo'
                AND era_oc.model = 'era5'
                AND era_oc.cell_key = oc.cell_key
                AND cn.baseline_version = $1) AS "normalsCount",
            (SELECT count(*)::int
               FROM app.monthly_outlooks mo
               JOIN app.outlook_cells era_oc ON era_oc.id = mo.outlook_cell_id
              WHERE era_oc.provider = 'open-meteo'
                AND era_oc.model = 'era5'
                AND era_oc.cell_key = oc.cell_key
                AND mo.status = 'active') AS "activeOutlooks",
            EXISTS (
              SELECT 1
                FROM app.weather_records wr
                JOIN app.outlook_cells fc_oc ON fc_oc.id = wr.outlook_cell_id
               WHERE fc_oc.provider = 'open-meteo'
                 AND fc_oc.model = 'ecmwf_ifs025'
                 AND fc_oc.cell_key = oc.cell_key
                 AND wr.provider = 'open-meteo'
                 AND wr.model = 'ecmwf_ifs025'
                 AND wr.superseded_at IS NULL
                 AND wr.initialized_at >= $2::date::timestamptz
            ) AS "hasTodayForecast"
       FROM app.outlook_cells oc
      WHERE oc.provider = 'open-meteo'
        AND oc.model IN ('ecmwf_ifs025', 'era5', 'ecmwf_seas5')
      ORDER BY oc.cell_key ASC`,
    baselineVersion,
    today,
  );

  const byCellKey = new Map<string, (typeof cellRows)[number]>();
  let seasonalDeferred = 0;

  for (const row of cellRows) {
    if (row.model === "ecmwf_seas5") {
      seasonalDeferred += 1;
      continue;
    }
    if (!byCellKey.has(row.cellKey)) {
      byCellKey.set(row.cellKey, row);
    }
  }

  if (seasonalDeferred > 0) {
    options.log("scheduler_seasonal_skipped", {
      reason: "ecmwf_seas5 uses Reduced Gaussian Grid pending ADR-008 extension",
      cells: seasonalDeferred,
    });
  }

  let climatologyEnqueued = 0;
  let outlookEnqueued = 0;
  let forecastEnqueued = 0;

  for (const cell of byCellKey.values()) {
    const selector = {
      cells: [{ cellKey: cell.cellKey, variable: "precipitation" }],
    };
    const targetSelectorHash = targetSelectorHashOf(selector);

    if (cell.normalsCount < 12) {
      const res = await options.queue.enqueue({
        kind: "ingest.climate",
        idempotencyKey: `sched:climatology:${baselineVersion}:${cell.cellKey}`,
        payload: {
          provider: "open-meteo",
          model: "era5",
          baselineDataset: "era5",
          algorithmVersion: CLIMATOLOGY_ALGORITHM_VERSION,
          targetSelectorHash,
          targetSelector: selector,
        },
      });
      if (res.enqueued) climatologyEnqueued += 1;
    } else if (cell.activeOutlooks === 0) {
      const res = await options.queue.enqueue({
        kind: "aggregate",
        idempotencyKey: `sched:aggregate:${baselineVersion}:${cell.cellKey}:${firstMonth}`,
        payload: {
          provider: "open-meteo",
          model: "era5",
          baselineVersion,
          firstMonth,
          targetSelectorHash,
          targetSelector: selector,
        },
      });
      if (res.enqueued) outlookEnqueued += 1;
    }

    if (!cell.hasTodayForecast) {
      const initializedAt = `${today}T00:00:00.000Z`;
      const horizonEnd = new Date(Date.parse(initializedAt) + 15 * 86_400_000).toISOString();
      const runRows = await options.db.$queryRawUnsafe<{ id: string }[]>(
        `INSERT INTO app.forecast_runs
           (provider, model, product, initialized_at, horizon_end, received_at)
         VALUES ('open-meteo', 'ecmwf_ifs025', 'forecast', $1::timestamptz, $2::timestamptz, now())
         ON CONFLICT (provider, model, product, initialized_at)
         DO UPDATE SET horizon_end = GREATEST(app.forecast_runs.horizon_end, EXCLUDED.horizon_end)
         RETURNING id::text AS id`,
        initializedAt,
        horizonEnd,
      );
      const forecastRunId = runRows[0]?.id;
      if (forecastRunId !== undefined) {
        const res = await options.queue.enqueue({
          kind: "ingest.forecast",
          idempotencyKey: `sched:forecast:ecmwf_ifs025:${cell.cellKey}:${today}`,
          payload: {
            forecastRunId,
            adapterVersion: "open-meteo-daily@1.0.0",
            normalizerVersion: "daily-precipitation@1.0.0",
            targetSelectorHash,
            targetSelector: selector,
          },
        });
        if (res.enqueued) forecastEnqueued += 1;
      }
    }
  }

  const summary: SchedulerSummary = {
    activeCells: byCellKey.size,
    climatologyEnqueued,
    outlookEnqueued,
    forecastEnqueued,
    seasonalDeferred,
  };
  options.log("scheduler_tick_completed", { ...summary });
  return summary;
}
