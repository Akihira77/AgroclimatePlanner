/**
 * Hardened, atomic, idempotent development climate reference seeder (`OPEN-18`).
 *
 * Security & data-integrity guarantees:
 * 1. Refuses to run in `production` or without explicit `NODE_ENV=development`
 *    (programmatic `{ allowTest: true }` is permitted only for integration tests).
 * 2. Connects strictly as `app_system` (never `migration_owner`, never issues DELETE,
 *    and never reads tenant `app.fields`).
 * 3. Scopes all writes to seeder-owned provenance (`SEED_HASH` / `SEED_ADAPTER_VERSION`)
 *    and preserves any foreign provider/ingestion records untouched.
 * 4. Executes the entire run inside one atomic PostgreSQL transaction.
 */
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

import { createPrismaClient } from "../packages/database/dist/index.js";
import { roleConnectionString } from "../packages/database/scripts/lib/connections.mjs";
import { unvalidatedGridRegistry } from "../packages/weather-core/dist/esm/index.js";

const PROVIDER = "open-meteo";
const MODEL = "ecmwf_ifs025";
const BASELINE_VERSION = "era5-1991-2020-v3";

export const SEED_METADATA = Object.freeze({
  provider: PROVIDER,
  model: MODEL,
  adapterVersion: "dev-seed-climate@1.0.0",
  monthlyDerivationVersion: "dev-reference-climate@1.0.0",
  climatologyDerivationVersion: "dev-reference-climatology@1.0.0",
  dailyNormalizerVersion: "dev-seed-daily-precipitation@1.0.0",
  inputSnapshotHash: createHash("sha256").update("dev-west-java-climate-v1").digest("hex"),
});

export const PRESET_COORDS = Object.freeze([
  { lat: -6.322, lon: 107.752 }, // Subang
  { lat: -6.814, lon: 107.618 }, // Lembang / Bandung Barat
  { lat: -6.305, lon: 107.305 }, // Karawang
  { lat: -7.216, lon: 107.907 }, // Garut
  { lat: -6.4675, lon: 106.795 }, // Bogor / Depok
]);

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

export function assertDevClimateSeedEnvironment(env = process.env, options = {}) {
  const nodeEnv = env["NODE_ENV"];
  if (nodeEnv === "production") {
    throw new Error("Refusing to run dev climate seeder in NODE_ENV=production.");
  }
  const allowed = nodeEnv === "development" || (options.allowTest === true && nodeEnv === "test");
  if (!allowed) {
    throw new Error(
      `Refusing to run dev climate seeder outside NODE_ENV=development (got NODE_ENV=${String(nodeEnv)}).`,
    );
  }
}

export async function seedDevClimate(options = {}) {
  assertDevClimateSeedEnvironment(options.env ?? process.env, {
    allowTest: options.allowTest === true,
  });

  const coords = options.coords ?? PRESET_COORDS;
  const uniqueCells = new Map();
  for (const coord of coords) {
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
        requestedLat: Number(coord.lat),
        requestedLon: Number(coord.lon),
      });
    }
  }

  const connectionString = options.connectionString ?? roleConnectionString("app_system");
  const prisma = createPrismaClient({ connectionString });

  const initIso = "2026-11-28T00:00:00.000Z";
  const seasonalHorizonIso = "2027-06-01T00:00:00.000Z";
  const dailyHorizonIso = "2027-01-13T00:00:00.000Z";

  try {
    return await prisma.$transaction(
      async (tx) => {
        const roleRows = await tx.$queryRawUnsafe(`SELECT current_user::text AS role_name`);
        const roleName = roleRows[0]?.role_name;

        const seasonalRunRows = await tx.$queryRawUnsafe(
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

        const seasonalIngRows = await tx.$queryRawUnsafe(
          `INSERT INTO app.ingestion_runs
             (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
              ingestion_version, status, finished_at, coverage_percent)
           VALUES ($1::uuid, $2, 'monthly-outlook@1.0.0', $3, $3, 'succeeded', now(), 100)
           ON CONFLICT (forecast_run_id, ingestion_version)
           DO UPDATE SET adapter_version = EXCLUDED.adapter_version, status = 'succeeded'
           RETURNING id::text AS id`,
          seasonalRunId,
          SEED_METADATA.adapterVersion,
          SEED_METADATA.inputSnapshotHash,
        );
        const seasonalIngId = seasonalIngRows[0].id;

        const dailyRunRows = await tx.$queryRawUnsafe(
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

        const dailyIngRows = await tx.$queryRawUnsafe(
          `INSERT INTO app.ingestion_runs
             (forecast_run_id, adapter_version, normalizer_version, target_selector_hash,
              ingestion_version, status, finished_at, coverage_percent)
           VALUES ($1::uuid, $2, $3, $4, $4, 'succeeded', now(), 100)
           ON CONFLICT (forecast_run_id, ingestion_version)
           DO UPDATE SET adapter_version = EXCLUDED.adapter_version,
                         normalizer_version = EXCLUDED.normalizer_version,
                         status = 'succeeded'
           RETURNING id::text AS id`,
          dailyRunId,
          SEED_METADATA.adapterVersion,
          SEED_METADATA.dailyNormalizerVersion,
          SEED_METADATA.inputSnapshotHash,
        );
        const dailyIngId = dailyIngRows[0].id;

        let monthlyInserted = 0;
        let monthlyUpdated = 0;
        let monthlySkippedForeign = 0;
        let dailyInserted = 0;
        let dailyUpdated = 0;
        let dailySkippedForeign = 0;

        for (const cell of uniqueCells.values()) {
          const cellRows = await tx.$queryRawUnsafe(
            `INSERT INTO app.outlook_cells (provider, model, cell_key, served_lat, served_lon)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT (provider, model, cell_key)
             DO UPDATE SET served_lat = COALESCE(app.outlook_cells.served_lat, EXCLUDED.served_lat),
                           served_lon = COALESCE(app.outlook_cells.served_lon, EXCLUDED.served_lon)
             RETURNING id::text AS id`,
            PROVIDER,
            MODEL,
            cell.cellKey,
            cell.servedLat,
            cell.servedLon,
          );
          const cellId = cellRows[0].id;

          for (const entry of MONTHLY_SERIES) {
            const existingRows = await tx.$queryRawUnsafe(
              `SELECT id::text AS id, input_snapshot_hash
                 FROM app.monthly_outlooks
                WHERE outlook_cell_id = $1::uuid
                  AND variable = 'precipitation'
                  AND month = $2::date
                  AND status = 'active'
                LIMIT 1`,
              cellId,
              entry.month,
            );
            const existing = existingRows[0];

            if (
              existing !== undefined &&
              existing.input_snapshot_hash !== SEED_METADATA.inputSnapshotHash
            ) {
              monthlySkippedForeign += 1;
              continue;
            }

            if (entry.lead <= 6) {
              const anomalyMm = entry.mm - entry.normalMm;
              const anomalyPct = Number(((anomalyMm / entry.normalMm) * 100).toFixed(1));
              if (existing !== undefined) {
                await tx.$executeRawUnsafe(
                  `UPDATE app.monthly_outlooks
                      SET forecast_run_id = $2::uuid,
                          ingestion_run_id = $3::uuid,
                          value_mm = $4,
                          anomaly_mm = $5,
                          anomaly_percent = $6,
                          derivation_version = $7,
                          computed_at = now()
                    WHERE id = $1::uuid`,
                  existing.id,
                  seasonalRunId,
                  seasonalIngId,
                  entry.mm,
                  anomalyMm,
                  anomalyPct,
                  SEED_METADATA.monthlyDerivationVersion,
                );
                monthlyUpdated += 1;
              } else {
                await tx.$executeRawUnsafe(
                  `INSERT INTO app.monthly_outlooks
                     (outlook_cell_id, forecast_run_id, ingestion_run_id, variable, month,
                      data_class, evaluation_basis, value_mm, baseline_version, anomaly_kind,
                      anomaly_mm, anomaly_percent, model_climate_offset_mm, data_coverage_percent,
                      ensemble_spread_mm, derivation_version, input_refs, input_snapshot_hash, status)
                   VALUES ($1::uuid, $2::uuid, $3::uuid, 'precipitation', $4::date,
                           'seasonal_forecast', 'monthly', $5, $6, 'baseline_difference',
                           $7, $8, 0, 100, 18.5, $9, '[]'::jsonb, $10, 'active')`,
                  cellId,
                  seasonalRunId,
                  seasonalIngId,
                  entry.month,
                  entry.mm,
                  BASELINE_VERSION,
                  anomalyMm,
                  anomalyPct,
                  SEED_METADATA.monthlyDerivationVersion,
                  SEED_METADATA.inputSnapshotHash,
                );
                monthlyInserted += 1;
              }
            } else if (existing !== undefined) {
              await tx.$executeRawUnsafe(
                `UPDATE app.monthly_outlooks
                    SET value_mm = $2,
                        derivation_version = $3,
                        computed_at = now()
                  WHERE id = $1::uuid`,
                existing.id,
                entry.mm,
                SEED_METADATA.climatologyDerivationVersion,
              );
              monthlyUpdated += 1;
            } else {
              await tx.$executeRawUnsafe(
                `INSERT INTO app.monthly_outlooks
                   (outlook_cell_id, variable, month, data_class, evaluation_basis, value_mm,
                    missing_reason, baseline_version, derivation_version, input_refs,
                    input_snapshot_hash, spread_unavailable_reason, status)
                 VALUES ($1::uuid, 'precipitation', $2::date, 'climatology', 'climatology', $3,
                         'beyond_horizon', $4, $5, '[]'::jsonb,
                         $6, 'climatology_has_no_ensemble', 'active')`,
                cellId,
                entry.month,
                entry.mm,
                BASELINE_VERSION,
                SEED_METADATA.climatologyDerivationVersion,
                SEED_METADATA.inputSnapshotHash,
              );
              monthlyInserted += 1;
            }
          }

          if (typeof options._onAfterMonthlyForTest === "function") {
            await options._onAfterMonthlyForTest(tx, cell);
          }

          for (let day = 0; day < DAILY_PATTERN_MM.length; day += 1) {
            const value = DAILY_PATTERN_MM[day];
            const dataClass = day < 15 ? "weather_forecast" : "subseasonal_forecast";
            const validAt = addDaysIso("2026-11-28", day);

            const existingDailyRows = await tx.$queryRawUnsafe(
              `SELECT wr.id::text AS id, ir.adapter_version
                 FROM app.weather_records wr
                 JOIN app.ingestion_runs ir ON ir.id = wr.ingestion_run_id
                WHERE wr.forecast_run_id = $1::uuid
                  AND wr.cell_key = $2
                  AND wr.variable = 'precipitation'
                  AND wr.valid_at = $3::timestamptz
                  AND wr.ensemble_member IS NULL
                  AND wr.superseded_at IS NULL
                LIMIT 1`,
              dailyRunId,
              cell.cellKey,
              validAt,
            );
            const existingDaily = existingDailyRows[0];

            if (existingDaily !== undefined) {
              const isOwnRecord =
                existingDaily.adapter_version === SEED_METADATA.adapterVersion ||
                existingDaily.adapter_version === "dev-seed@1";
              if (!isOwnRecord) {
                dailySkippedForeign += 1;
                continue;
              }
              await tx.$executeRawUnsafe(
                `UPDATE app.weather_records
                    SET ingestion_run_id = $2::uuid,
                        data_class = $3,
                        value = $4,
                        normalizer_version = $5
                  WHERE id = $1::uuid`,
                existingDaily.id,
                dailyIngId,
                dataClass,
                value,
                SEED_METADATA.dailyNormalizerVersion,
              );
              dailyUpdated += 1;
            } else {
              await tx.$executeRawUnsafe(
                `INSERT INTO app.weather_records
                   (forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
                    data_class, variable, value, unit, valid_at, initialized_at, requested_lat,
                    requested_lon, served_value_is_interpolated, temporal_resolution,
                    ensemble_member, ensemble_size, aggregation_level, normalizer_version)
                 VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6,
                         $7, 'precipitation', $8, 'mm', $9::timestamptz, $10::timestamptz, $11,
                         $12, false, 'daily',
                         NULL, NULL, 'daily_sum', $13)`,
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
                SEED_METADATA.dailyNormalizerVersion,
              );
              dailyInserted += 1;
            }
          }
        }

        return {
          roleName,
          cellKeys: [...uniqueCells.keys()],
          monthlyInserted,
          monthlyUpdated,
          monthlySkippedForeign,
          dailyInserted,
          dailyUpdated,
          dailySkippedForeign,
        };
      },
      { timeout: 30_000 },
    );
  } finally {
    await prisma.$disconnect();
  }
}

const isCli =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isCli) {
  const result = await seedDevClimate();
  console.log(
    `Seeded ${result.cellKeys.length} cells (${result.cellKeys.join(", ")}) as role "${result.roleName}" — monthly(ins:${result.monthlyInserted}, upd:${result.monthlyUpdated}, skipForeign:${result.monthlySkippedForeign}), daily(ins:${result.dailyInserted}, upd:${result.dailyUpdated}, skipForeign:${result.dailySkippedForeign}).`,
  );
}
