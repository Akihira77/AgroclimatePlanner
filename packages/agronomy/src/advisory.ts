import type { GrowthStage } from "@agroclimate/contracts";

import { projectCycle } from "./cycle.js";
import { daysBetween } from "./stages.js";

export interface DailyRainSample {
  readonly date: string; // YYYY-MM-DD
  readonly rainMm: number | null;
}

export interface FieldWeeklyWeatherAdvisoryInput {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly farmName: string;
  readonly days: readonly DailyRainSample[];
  readonly dataSourceLabel?: string;
}

export interface FieldWeeklyWeatherAdvisoryResult {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly farmName: string;
  readonly hasData: boolean;
  readonly horizonDays: number;
  readonly totalRainMm: number | null;
  readonly peakRainDate: string | null;
  readonly peakRainMm: number | null;
  readonly advisoryTextId: string;
  readonly dataSourceLabel: string;
}

const SHORT_MONTHS_ID = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "Mei",
  "Jun",
  "Jul",
  "Agt",
  "Sep",
  "Okt",
  "Nov",
  "Des",
];

function formatShortDateId(isoDate: string): string {
  const day = Number(isoDate.slice(8, 10));
  const monthIdx = Number(isoDate.slice(5, 7)) - 1;
  const monthLabel = SHORT_MONTHS_ID[monthIdx] ?? isoDate.slice(5, 7);
  return `${day} ${monthLabel}`;
}

/**
 * Summarises 7–14 day precipitation outlook for a single field without coercing missing (`null`)
 * days to zero. When no valid forecast days exist, returns `hasData: false` and `null` totals.
 */
export function buildFieldWeeklyWeatherAdvisory(
  input: FieldWeeklyWeatherAdvisoryInput,
): FieldWeeklyWeatherAdvisoryResult {
  const windowDays = input.days.slice(0, 14);
  const validDays = windowDays.filter(
    (d): d is { readonly date: string; readonly rainMm: number } =>
      d.rainMm !== null && Number.isFinite(d.rainMm),
  );

  const dataSourceLabel = input.dataSourceLabel ?? "Open-Meteo ECMWF IFS 0,25°";

  if (validDays.length === 0) {
    return {
      fieldId: input.fieldId,
      fieldName: input.fieldName,
      farmName: input.farmName,
      hasData: false,
      horizonDays: windowDays.length,
      totalRainMm: null,
      peakRainDate: null,
      peakRainMm: null,
      advisoryTextId: `Data cuaca untuk lahan ${input.fieldName} belum tersedia. Buka menu Cuaca & Iklim untuk memantau ketersediaan prakiraan.`,
      dataSourceLabel,
    };
  }

  let total = 0;
  let peakDay = validDays[0]!;
  for (const day of validDays) {
    total += day.rainMm;
    if (day.rainMm > peakDay.rainMm) {
      peakDay = day;
    }
  }

  const totalRainMm = Math.round(total * 10) / 10;
  const peakRainMm = Math.round(peakDay.rainMm * 10) / 10;
  const peakLabel = formatShortDateId(peakDay.date);

  let advisoryTextId: string;
  if (peakRainMm >= 20) {
    advisoryTextId = `Potensi hujan sedang–lebat di ${input.fieldName} pada ${peakLabel} (~${Math.round(peakRainMm)} mm) — jadwalkan pemupukan atau penyemprotan di luar hari tersebut dan pastikan saluran air bersih.`;
  } else if (totalRainMm >= 35) {
    advisoryTextId = `Total hujan ${validDays.length} hari ke depan di ${input.fieldName} diperkirakan ~${Math.round(totalRainMm)} mm (puncak ${peakLabel} ~${Math.round(peakRainMm)} mm) — kelembaban cukup baik untuk pertumbuhan tanaman.`;
  } else {
    advisoryTextId = `Curah hujan ${validDays.length} hari ke depan di ${input.fieldName} cenderung ringan (~${Math.round(totalRainMm)} mm) — cocok untuk pemeliharaan dan penyemprotan, pantau kebutuhan penyiraman.`;
  }

  return {
    fieldId: input.fieldId,
    fieldName: input.fieldName,
    farmName: input.farmName,
    hasData: true,
    horizonDays: validDays.length,
    totalRainMm,
    peakRainDate: peakDay.date,
    peakRainMm,
    advisoryTextId,
    dataSourceLabel,
  };
}

export interface ActivePlantingInput {
  readonly plantingId: string;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly cropNameId: string;
  readonly cultivarName: string;
  readonly plantedAt: string; // YYYY-MM-DD
  readonly durationDaysMin: number;
  readonly durationDaysTypical: number;
  readonly durationDaysMax: number;
  readonly stages: readonly GrowthStage[];
  readonly weeklyRainMm: number | null;
  readonly latestTempC: number | null;
}

export interface CriticalStageAlertResult {
  readonly plantingId: string;
  readonly fieldId: string;
  readonly fieldName: string;
  readonly cropNameId: string;
  readonly cultivarName: string;
  readonly stageName: string;
  readonly status: "in_critical" | "approaching_critical";
  readonly daysUntilStart: number;
  readonly stageStartDate: string;
  readonly stageEndDate: string;
  readonly weatherSummaryId: string;
}

/**
 * Identifies active plantings currently in a critical growth stage or entering one within 14 days.
 */
export function detectCriticalStageAlerts(
  plantings: readonly ActivePlantingInput[],
  asOfDate: string,
): readonly CriticalStageAlertResult[] {
  const alerts: CriticalStageAlertResult[] = [];

  for (const planting of plantings) {
    if (planting.stages.length === 0) continue;
    const projected = projectCycle({
      cycleStartDate: planting.plantedAt,
      durationDays: {
        min: planting.durationDaysMin,
        typical: planting.durationDaysTypical,
        max: planting.durationDaysMax,
      },
      stages: planting.stages,
    });

    const criticalStages = projected.stages.filter((s) => s.isCritical);
    for (const stage of criticalStages) {
      const daysUntilStart = daysBetween(asOfDate, stage.startDate);
      const isInCritical = asOfDate >= stage.startDate && asOfDate <= stage.endDate;
      const isApproaching = daysUntilStart > 0 && daysUntilStart <= 14;

      if (!isInCritical && !isApproaching) continue;

      const weatherParts: string[] = [];
      if (planting.weeklyRainMm !== null) {
        weatherParts.push(`prakiraan hujan 14 hr ~${Math.round(planting.weeklyRainMm)} mm`);
      }
      if (planting.latestTempC !== null) {
        weatherParts.push(`suhu tercatat ${planting.latestTempC} °C`);
      }
      const weatherContext =
        weatherParts.length > 0
          ? weatherParts.join(", ")
          : "pantau ketersediaan air & kondisi cuaca lapangan";

      const timingDesc = isInCritical
        ? `Sedang memasuki fase kritis "${stage.name}" (${formatShortDateId(stage.startDate)}–${formatShortDateId(stage.endDate)})`
        : `Dalam ${daysUntilStart} hari akan masuk fase kritis "${stage.name}" (${formatShortDateId(stage.startDate)})`;

      alerts.push({
        plantingId: planting.plantingId,
        fieldId: planting.fieldId,
        fieldName: planting.fieldName,
        cropNameId: planting.cropNameId,
        cultivarName: planting.cultivarName,
        stageName: stage.name,
        status: isInCritical ? "in_critical" : "approaching_critical",
        daysUntilStart,
        stageStartDate: stage.startDate,
        stageEndDate: stage.endDate,
        weatherSummaryId: `${timingDesc} — ${weatherContext}.`,
      });
    }
  }

  return alerts.sort((a, b) => a.daysUntilStart - b.daysUntilStart);
}
