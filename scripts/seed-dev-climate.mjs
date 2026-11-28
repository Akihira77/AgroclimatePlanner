/**
 * Idempotent development climate reference seeder for West Java fields (`OPEN-18`).
 *
 * Uses `unvalidatedGridRegistry` (`open-meteo / ecmwf_ifs025`) to resolve the exact
 * `cell_key` for every active field in `app.fields` plus preset West Java regions,
 * then seeds 12 months of `app.monthly_outlooks` (6 seasonal + 6 climatology) and
 * 45 days of `app.weather_records` (15 daily + 30 subseasonal) so `Cuaca & Iklim`
 * renders complete charts for development & testing.
 */
import { createHash } from "node:crypto";

import { createPrismaClient } from "../packages/database/dist/index.js";
import { unvalidatedGridRegistry } from "../packages/weather-core/dist/esm/index.js";

import { roleConnectionString } from "../packages/database/scripts/lib/connections.mjs";

const PROVIDER = "open-meteo";
const MODEL = "ecmwf_ifs025";
const BASELINE_VERSION = "era5-1991-2020-v3";
const HASH = createHash("sha256").update("dev-west-java-climate-v1").digest("hex");

const PRESET_COORDS = [
  { lat: -6.322, lon: 107.752 }, // Subang
  { lat: -6.814, lon: 107.618 }, // Lembang / Bandung Barat
  { lat: -6.305, lon: 107.305 }, // Karawang
  { lat: -7.216, lon: 107.907 }, // Garut
  { lat: -6.4675, lon: 106.795 }, // Bogor / Depok
];

// Realistic West Java monthly precipitation profile (Nov 2026 -> Oct 2027, mm)
const MONTHLY_SERIES = [
  { month: "2026-11-01", mm: 245, normalMm: 225, lead: 1 },
  { month: "2026-12-01", mm: 310, normalMm: 290, lead: 2 },
  { month: "2027-01-01", mm: 340, normalMm: 325, lead: 3 },
  { month: "2027-02-01", mm: 315, normalMm: 300, lead: 4 },
  { month: "2027-03-01", mm: 270, normalMm: 260, lead: 5 },
  { month: "2027-04-01", mm: 205, normalMm: 195, lead: 6 },
  { month: "2027-05-01", mm: 135, normalMm: 135, lead: 7 },
  { month: "2027-06-01", mm: 88, normalMm: 88, lead: 8 },
  { month: "2027-07-01", mm: 65, normalMm: 65, lead: 9 },
  { month: "2027-08-01", mm: 58, normalMm: 58, lead: 10 },
  { month: "2027-09-01", mm: 92, normalMm: 92, lead: 11 },
  { month: "2027-10-01", mm: 165, normalMm: 165, lead: 12 },
];

// Deterministic 45-day daily rainfall pattern (mm/day) starting 2026-11-28
const DAILY_PATTERN_MM = [
  14.2, 8.5, 22.0, 4.1, 0.0, 11.6, 18.4, 27.3, 6.2, 2.0, 15.8, 9.4, 0.0, 12.1, 19.7,
  16.0, 10.5, 5.4, 21.2, 13.8, 0.0, 7.6, 14.9, 24.1, 8.3, 3.2, 17.5, 11.0, 6.8, 19.3,
  12.4, 4.5, 0.0, 15.1, 20.6, 9.8, 7.2, 13.5, 18.9, 6.0, 11.2, 22.4, 14.7, 5.1, 10.3,
];

function addDaysIso(startIso, days) {
  const dt = new Date(Date.parse(`${startIso}T00:00:00.000Z`));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString();
}

async function main() {
  const prisma = createPrismaClient({
    connectionString: roleConnectionString("migration_owner"),
  });

  try {
    const fieldRows = await prisma.$queryRawUnsafe(`
      SELECT ST_Y(ST_Centroid(geom))::double precision AS lat,
             ST_X(ST_Centroid(geom))::double precision AS lon
        FROM app.fields
       WHERE deleted_at IS NULL
    `);

    const allCoords = [...PRESET_COORDS, ...fieldRows];
    const uniqueCells = new Map();
    for (const coord of allCoords) {
      const res = unvalidatedGridRegistry.resolve(
        { provider: PROVIDER, model: MODEL },
        { lat: Number(coord.lat).toFixed(6), lon: Number(coord.lon).toFixed(6) },
      );
      if (!uniqueCells.has(res.cellKey)) {
        const [latStr, lonStr] = res.cellKey.split(",");
        uniqueCells.set(res.cellKey, {
          cellKey: res.cellKey,
          servedLat: Number(latStr),
          servedLon: Number(lonStr),
          requestedLat: coord.lat,
          requestedLon: coord.lon,
        });
      }
    }

    const initIso = "2026-11-28T00:00:00.000Z";
    const seasonalHorizonIso = "2027-06-01T00:00:00.000Z";
    const dailyHorizonIso = "2027-01-13T00:00:00.000Z";

    const seasonalRunRows = await prisma.$queryRawUnsafe(
      `INSERT INTO app.forecast_runs
         (provider, model, product, initialized_at, horizon_end, received_at)
       VALUES ($1, $2, 'seasonal', $3::timestamptz, $4::timestamptz, $3::timestamptz)
       ON CONFLICT (provider, model, product, initialized_at)
       DO UPDATE SET horizon_end = EXCLUDED.horizon_end
       RETURNING id::text AS id`,
      PROVIDER,
      MODEL,
      initIso,
      seasonalHorizonIso,
    );
    const seasonalRunId = seasonalRunRows[0].id;

    const seasonalIngRows = await prisma.$queryRawUnsafe(
      `INSERT INTO app.ingestion_runs
         (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
          ingestion_version, status, finished_at, coverage_percent)
       VALUES ($1::uuid, 'dev-seed@1', 'monthly-outlook@1.0.0', $2, $2, 'succeeded', now(), 100)
       ON CONFLICT (forecast_run_id, ingestion_version)
       DO UPDATE SET status = 'succeeded'
       RETURNING id::text AS id`,
      seasonalRunId,
      HASH,
    );
    const seasonalIngId = seasonalIngRows[0].id;

    const dailyRunRows = await prisma.$queryRawUnsafe(
      `INSERT INTO app.forecast_runs
         (provider, model, product, initialized_at, horizon_end, received_at)
       VALUES ($1, $2, 'forecast', $3::timestamptz, $4::timestamptz, $3::timestamptz)
       ON CONFLICT (provider, model, product, initialized_at)
       DO UPDATE SET horizon_end = EXCLUDED.horizon_end
       RETURNING id::text AS id`,
      PROVIDER,
      MODEL,
      initIso,
      dailyHorizonIso,
    );
    const dailyRunId = dailyRunRows[0].id;

    const dailyIngRows = await prisma.$queryRawUnsafe(
      `INSERT INTO app.ingestion_runs
         (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
          ingestion_version, status, finished_at, coverage_percent)
       VALUES ($1::uuid, 'dev-seed@1', 'daily-precipitation@1.0.0', $2, $2, 'succeeded', now(), 100)
       ON CONFLICT (forecast_run_id, ingestion_version)
       DO UPDATE SET status = 'succeeded'
       RETURNING id::text AS id`,
      dailyRunId,
      HASH,
    );
    const dailyIngId = dailyIngRows[0].id;

    for (const cell of uniqueCells.values()) {
      const cellRows = await prisma.$queryRawUnsafe(
        `INSERT INTO app.outlook_cells (provider, model, cell_key, served_lat, served_lon)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (provider, model, cell_key)
         DO UPDATE SET served_lat = EXCLUDED.served_lat, served_lon = EXCLUDED.served_lon
         RETURNING id::text AS id`,
        PROVIDER,
        MODEL,
        cell.cellKey,
        cell.servedLat,
        cell.servedLon,
      );
      const cellId = cellRows[0].id;

      await prisma.$executeRawUnsafe(
        `DELETE FROM app.monthly_outlooks WHERE outlook_cell_id = $1::uuid`,
        cellId,
      );
      await prisma.$executeRawUnsafe(
        `DELETE FROM app.weather_records WHERE outlook_cell_id = $1::uuid`,
        cellId,
      );

      for (const entry of MONTHLY_SERIES) {
        if (entry.lead <= 6) {
          const anomalyMm = entry.mm - entry.normalMm;
          const anomalyPct = Number(((anomalyMm / entry.normalMm) * 100).toFixed(1));
          await prisma.$executeRawUnsafe(
            `INSERT INTO app.monthly_outlooks
               (outlook_cell_id, forecast_run_id, ingestion_run_id, variable, month,
                data_class, evaluation_basis, value_mm, baseline_version, anomaly_kind,
                anomaly_mm, anomaly_percent, model_climate_offset_mm, data_coverage_percent,
                ensemble_spread_mm, derivation_version, input_refs, input_snapshot_hash, status)
             VALUES ($1::uuid, $2::uuid, $3::uuid, 'precipitation', $4::date,
                     'seasonal_forecast', 'monthly', $5, $6, 'baseline_difference',
                     $7, $8, 0, 100, 18.5, 'dev-reference-climate@1.0.0',
                     '[]'::jsonb, $9, 'active')`,
            cellId,
            seasonalRunId,
            seasonalIngId,
            entry.month,
            entry.mm,
            BASELINE_VERSION,
            anomalyMm,
            anomalyPct,
            HASH,
          );
        } else {
          await prisma.$executeRawUnsafe(
            `INSERT INTO app.monthly_outlooks
               (outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
                missing_reason, baseline_version, derivation_version, input_refs,
                input_snapshot_hash, spread_unavailable_reason, status)
             VALUES ($1::uuid, 'precipitation', $2::date, 'climatology', 'climatology', $3,
                     'beyond_horizon', $4, 'climatology-outlook@1.0.0', '[]'::jsonb,
                     $5, 'climatology_has_no_ensemble', 'active')`,
            cellId,
            entry.month,
            entry.mm,
            BASELINE_VERSION,
            HASH,
          );
        }
      }

      for (let day = 0; day < DAILY_PATTERN_MM.length; day += 1) {
        const value = DAILY_PATTERN_MM[day];
        const dataClass = day < 15 ? "weather_forecast" : "subseasonal_forecast";
        const validAt = addDaysIso("2026-11-28", day);
        await prisma.$executeRawUnsafe(
          `INSERT INTO app.weather_records
             (forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
              data_class, variable, value, unit, valid_at, initialized_at, requested_lat,
              requested_lon, served_value_is_interpolated, temporal_resolution,
              ensemble_member, ensemble_size, aggregation_level, normalizer_version)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                   $7, 'precipitation', $8, 'mm', $9::timestamptz, $10::timestamptz, $11,
                   $12, false, 'daily',
                   NULL, NULL, 'daily_sum', 'daily-precipitation@1.0.0')`,
          dailyRunId,
          dailyIngId,
          cellId,
          cell.cellKey,
          PROVIDER,
          MODEL,
          dataClass,
          value,
          validAt,
          initIso,
          cell.requestedLat,
          cell.requestedLon,
        );
      }
    }

    console.log(
      `Seeded ${uniqueCells.size} ecmwf_ifs025 cells (${[...uniqueCells.keys()].join(", ")}) with 12 monthly outlooks and 45 daily weather records each.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

await main();
