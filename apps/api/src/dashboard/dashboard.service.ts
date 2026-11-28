import {
  buildFieldWeeklyWeatherAdvisory,
  detectCriticalStageAlerts,
} from "@agroclimate/agronomy";
import {
  assembleDailyHorizon,
  assembleOutlookHorizon,
  dailyHorizonWindow,
  summariseCurrentMonthSeason,
} from "@agroclimate/climate-core";
import type {
  DashboardAdvisory,
  GridRegistry,
  GridRegistryEntry,
  GrowthStage,
} from "@agroclimate/contracts";
import {
  calendarMonthOf,
  createSpatialResolution,
  dashboardAdvisorySchema,
} from "@agroclimate/contracts";
import type { PrismaClient, TenantScope } from "@agroclimate/database";
import {
  createTenantScope,
  findCropBySlug,
  findCultivar,
  findProfileVersion,
  listAllFields,
  listFarms,
  listFieldObservations,
  listPlantings,
  listProfileVersionsForCrop,
  loadActiveDailyRecords,
  loadActiveOutlookMonths,
  selectFieldAnchor,
} from "@agroclimate/database";
import { Inject, Injectable } from "@nestjs/common";

import { jakartaDateOf, jakartaMonthOf } from "../climate/calendar.js";
import { DATABASE_CLIENT, GRID_REGISTRY } from "../tokens.js";

/**
 * Aggregates proactive weekly weather advisories, active critical-stage alerts,
 * and current-month seasonal context in a single tenant-scoped transaction (`withTenant`).
 */
@Injectable()
export class DashboardService {
  private readonly scope: TenantScope;

  constructor(
    @Inject(DATABASE_CLIENT) prisma: PrismaClient,
    @Inject(GRID_REGISTRY) private readonly grids: GridRegistry,
  ) {
    this.scope = createTenantScope(prisma);
  }

  private tryRegistryEntry(provider: string, model: string): GridRegistryEntry | null {
    try {
      const spec = this.grids.specFor({ provider, model });
      const evidence = this.grids.evidenceFor({ provider, model });
      return { provider, model, spec, evidence };
    } catch {
      return null;
    }
  }

  async advisory(userId: string): Promise<DashboardAdvisory> {
    const now = new Date();
    const today = jakartaDateOf(now);
    const nowIso = now.toISOString();
    const firstMonth = jakartaMonthOf(now);
    const dailyWindow = dailyHorizonWindow(today);

    return this.scope.withTenant(userId, async (tx) => {
      const [farmsPage, fieldsPage, plantings] = await Promise.all([
        listFarms(tx, { limit: 100, offset: 0, sort: "-createdAt" }),
        listAllFields(tx, { limit: 100, offset: 0, sort: "-createdAt" }),
        listPlantings(tx, { status: "active" }),
      ]);

      const fields = fieldsPage.items;
      const farmById = new Map(farmsPage.items.map((f) => [f.id, f]));

      const fcEntry = this.tryRegistryEntry("open-meteo", "ecmwf_ifs025");
      const eraEntry = this.tryRegistryEntry("open-meteo", "era5");

      const fieldCellKey = new Map<string, string>();
      const uniqueCellKeys = new Set<string>();

      for (const field of fields) {
        if (fcEntry === null) continue;
        const anchor = await selectFieldAnchor(tx, field.id);
        if (anchor === null) continue;
        try {
          const res = createSpatialResolution(fcEntry, { lat: anchor.lat, lon: anchor.lon });
          fieldCellKey.set(field.id, res.cellKey);
          uniqueCellKeys.add(res.cellKey);
        } catch {
          // Field outside grid coverage degrades honestly as missing data
        }
      }

      const dailyByCell = new Map<
        string,
        readonly { readonly date: string; readonly rainMm: number | null }[]
      >();
      for (const cellKey of uniqueCellKeys) {
        const records = await loadActiveDailyRecords(tx, {
          provider: "open-meteo",
          model: "ecmwf_ifs025",
          cellKey,
          from: dailyWindow.from,
          to: dailyWindow.to,
        });
        const assembled = assembleDailyHorizon({
          firstDate: today,
          provider: "open-meteo",
          model: "ecmwf_ifs025",
          rows: records,
          now: nowIso,
        });
        if (assembled.ok) {
          const days = assembled.value.segments.flatMap((seg) =>
            seg.days.map((d) => ({ date: d.date, rainMm: d.valueMm })),
          );
          dailyByCell.set(cellKey, days);
        } else {
          dailyByCell.set(cellKey, []);
        }
      }

      const fieldWeather = fields.map((field) => {
        const farmName = farmById.get(field.farmId)?.name ?? "Kebun";
        const cellKey = fieldCellKey.get(field.id);
        const days = cellKey !== undefined ? (dailyByCell.get(cellKey) ?? []) : [];
        return buildFieldWeeklyWeatherAdvisory({
          fieldId: field.id,
          fieldName: field.name,
          farmName,
          days,
        });
      });

      const weatherByFieldId = new Map(fieldWeather.map((w) => [w.fieldId, w]));

      let currentMonthSeason = summariseCurrentMonthSeason([], firstMonth);
      const firstCellKey = [...uniqueCellKeys][0];
      if (firstCellKey !== undefined) {
        const toMonth = calendarMonthOf(firstMonth, 12);
        const fcOutlook = await loadActiveOutlookMonths(tx, {
          provider: "open-meteo",
          model: "ecmwf_ifs025",
          cellKey: firstCellKey,
          fromMonth: firstMonth,
          toMonth,
        });
        const eraOutlook =
          eraEntry !== null
            ? await loadActiveOutlookMonths(tx, {
                provider: "open-meteo",
                model: "era5",
                cellKey: firstCellKey,
                fromMonth: firstMonth,
                toMonth,
              })
            : null;

        const mergedMonths = new Map<
          string,
          { readonly month: string; readonly valueMm: number | null; readonly dataClass: string | null }
        >();

        if (eraOutlook !== null) {
          const assembledEra = assembleOutlookHorizon({
            firstMonth,
            rows: eraOutlook.months,
            now: nowIso,
          });
          if (assembledEra.ok) {
            for (const m of assembledEra.value.months) {
              if (m.valueMm !== null) {
                mergedMonths.set(m.month, {
                  month: m.month,
                  valueMm: m.valueMm,
                  dataClass: m.dataClass,
                });
              }
            }
          }
        }
        if (fcOutlook !== null) {
          const assembledFc = assembleOutlookHorizon({
            firstMonth,
            rows: fcOutlook.months,
            now: nowIso,
          });
          if (assembledFc.ok) {
            for (const m of assembledFc.value.months) {
              if (m.valueMm !== null) {
                mergedMonths.set(m.month, {
                  month: m.month,
                  valueMm: m.valueMm,
                  dataClass: m.dataClass,
                });
              }
            }
          }
        }

        currentMonthSeason = summariseCurrentMonthSeason(
          [...mergedMonths.values()],
          firstMonth,
        );
      }

      const activeInputs = [];
      for (const planting of plantings) {
        const field = fields.find((f) => f.id === planting.fieldId);
        if (field === undefined) continue;
        const [crop, cultivar, obs] = await Promise.all([
          findCropBySlug(tx, planting.cropSlug),
          findCultivar(tx, planting.cultivarId),
          listFieldObservations(tx, planting.fieldId, 5),
        ]);
        if (crop === null || cultivar === null) continue;
        const versions = await listProfileVersionsForCrop(tx, crop.id);
        const published = versions.find(
          (v) => v.cultivarId === planting.cultivarId && v.status === "published",
        );
        if (published === undefined) continue;
        const profile = await findProfileVersion(tx, published.id);
        if (profile === null) continue;
        const tempObs = (obs ?? []).find((o) => o.kind === "temperature");
        activeInputs.push({
          plantingId: planting.id,
          fieldId: planting.fieldId,
          fieldName: field.name,
          cropNameId: planting.cropNameId,
          cultivarName: cultivar.name,
          plantedAt: planting.plantedAt,
          durationDaysMin: cultivar.durationDaysMin,
          durationDaysTypical: cultivar.durationDaysTypical,
          durationDaysMax: cultivar.durationDaysMax,
          stages: profile.growthStages as unknown as readonly GrowthStage[],
          weeklyRainMm: weatherByFieldId.get(planting.fieldId)?.totalRainMm ?? null,
          latestTempC: tempObs?.value ?? null,
        });
      }

      const criticalStageAlerts = detectCriticalStageAlerts(activeInputs, today);

      return dashboardAdvisorySchema.parse({
        generatedAt: nowIso,
        indicativeLabel:
          "Himbauan Indikatif • Berdasarkan prakiraan cuaca & siklus tanam tercatat",
        currentMonthSeason,
        fieldWeather,
        criticalStageAlerts,
      });
    });
  }
}
