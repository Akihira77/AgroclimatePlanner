import type {
  Constraint,
  IrrigationAvailability,
  SuitabilityVerdict,
} from "@agroclimate/contracts";

export interface OutlookMonthPoint {
  readonly month: string; // YYYY-MM-01
  readonly valueMm: number | null;
  readonly dataClass: string | null;
}

export interface CropCatalogCandidateInput {
  readonly cropId: string;
  readonly cropSlug: string;
  readonly cropNameId: string;
  readonly category: string;
  readonly cultivarId: string;
  readonly cultivarName: string;
  readonly profileVersionId: string;
  readonly durationDaysTypical: number;
  readonly altitudeMinM: number | null;
  readonly altitudeMaxM: number | null;
  readonly constraints: readonly Constraint[];
}

export interface FieldContextForRecommendation {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly elevationM: number | null;
  readonly soilPh: number | null;
  readonly drainageClass: string | null;
  readonly irrigationAvailability: IrrigationAvailability;
  readonly latestTempC: number | null;
}

export interface CropMatrixCellResult {
  readonly month: string;
  readonly verdict: SuitabilityVerdict;
  readonly evidenceClass: string | null;
  readonly rainfallMm: number | null;
  readonly noteId: string;
}

export interface CropRankingResult {
  readonly cropId: string;
  readonly cropSlug: string;
  readonly cropNameId: string;
  readonly category: string;
  readonly cultivarId: string;
  readonly cultivarName: string;
  readonly profileVersionId: string;
  readonly durationDaysTypical: number;
  readonly verdict: SuitabilityVerdict;
  readonly bestStartMonth: string | null;
  readonly evidenceBadge: string;
  readonly summaryId: string;
  readonly keyFactorId: string;
}

export interface CropMatrixRowResult {
  readonly cropId: string;
  readonly cropSlug: string;
  readonly cropNameId: string;
  readonly cultivarName: string;
  readonly profileVersionId: string;
  readonly cells: readonly CropMatrixCellResult[];
}

export interface FieldRecommendationsResult {
  readonly fieldId: string;
  readonly fieldName: string;
  readonly horizonMonths: 3 | 6 | 12;
  readonly indicativeNotice: string;
  readonly months: readonly string[];
  readonly rankings: readonly CropRankingResult[];
  readonly matrix: readonly CropMatrixRowResult[];
}

const VERDICT_RANK: Record<SuitabilityVerdict, number> = {
  suitable: 0,
  conditional: 1,
  insufficient_data: 2,
  unsuitable: 3,
};

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

function formatMonthId(isoMonth: string): string {
  const m = Number(isoMonth.slice(5, 7));
  const year = isoMonth.slice(0, 4);
  return `${SHORT_MONTHS_ID[m - 1] ?? isoMonth.slice(5, 7)} ${year}`;
}

function addDaysIso(isoDate: string, days: number): string {
  const d = new Date(Date.parse(`${isoDate}T00:00:00.000Z`));
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysInUtcMonth(year: number, monthIndex0: number): number {
  return new Date(Date.UTC(year, monthIndex0 + 1, 0)).getUTCDate();
}

function prorateCycleRainfall(
  months: readonly OutlookMonthPoint[],
  startMonth: string,
  durationDaysTypical: number,
): { readonly rainfallMm: number | null; readonly hasSeasonal: boolean; readonly allSeasonal: boolean } {
  const byMonth = new Map(months.map((m) => [m.month.slice(0, 7), m]));
  const endIso = addDaysIso(startMonth, Math.max(1, durationDaysTypical) - 1);

  const [sy, sm, sd] = startMonth.split("-").map(Number);
  const [ey, em, ed] = endIso.split("-").map(Number);
  if (sy === undefined || sm === undefined || sd === undefined) {
    return { rainfallMm: null, hasSeasonal: false, allSeasonal: false };
  }
  if (ey === undefined || em === undefined || ed === undefined) {
    return { rainfallMm: null, hasSeasonal: false, allSeasonal: false };
  }

  let year = sy;
  let month = sm;
  let total = 0;
  let hasSeasonal = false;
  let allSeasonal = true;

  while (year < ey || (year === ey && month <= em)) {
    const ym = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}`;
    const entry = byMonth.get(ym);
    if (entry === undefined || entry.valueMm === null || !Number.isFinite(entry.valueMm)) {
      return { rainfallMm: null, hasSeasonal: false, allSeasonal: false };
    }
    if (entry.dataClass === "seasonal_forecast") {
      hasSeasonal = true;
    } else {
      allSeasonal = false;
    }
    const totalDays = daysInUtcMonth(year, month - 1);
    const startDay = year === sy && month === sm ? sd : 1;
    const endDay = year === ey && month === em ? ed : totalDays;
    const coveredDays = Math.max(0, endDay - startDay + 1);
    total += entry.valueMm * (coveredDays / totalDays);

    month += 1;
    if (month > 12) {
      month = 1;
      year += 1;
    }
  }

  return { rainfallMm: Math.round(total), hasSeasonal, allSeasonal };
}

function evaluateRuleBounds(
  value: number,
  c: Constraint,
): { readonly ok: boolean; readonly severe: boolean } {
  if (c.comparator === "range" && c.thresholdLower !== null && c.thresholdUpper !== null) {
    if (value >= c.thresholdLower && value <= c.thresholdUpper) return { ok: true, severe: false };
    const span = Math.max(0.5, c.thresholdUpper - c.thresholdLower);
    const dist = value < c.thresholdLower ? c.thresholdLower - value : value - c.thresholdUpper;
    return { ok: false, severe: dist > span * 0.35 };
  }
  if (c.comparator === "min" && c.thresholdLower !== null) {
    if (value >= c.thresholdLower) return { ok: true, severe: false };
    return { ok: false, severe: c.thresholdLower - value > 4 };
  }
  if (c.comparator === "max" && c.thresholdUpper !== null) {
    if (value <= c.thresholdUpper) return { ok: true, severe: false };
    return { ok: false, severe: value - c.thresholdUpper > 4 };
  }
  return { ok: true, severe: false };
}

function evaluateCropAtMonth(
  crop: CropCatalogCandidateInput,
  field: FieldContextForRecommendation,
  months: readonly OutlookMonthPoint[],
  startMonth: string,
): CropMatrixCellResult {
  const rain = prorateCycleRainfall(months, startMonth, crop.durationDaysTypical);
  const evidenceClass =
    rain.rainfallMm === null
      ? null
      : rain.allSeasonal
        ? "seasonal_forecast"
        : "climatology";

  const notes: string[] = [];
  let hardFail = false;
  let softWarn = false;
  let missingCount = 0;

  // 1. Elevation check if field elevation and crop bounds exist
  if (field.elevationM !== null) {
    if (crop.altitudeMinM !== null && field.elevationM < crop.altitudeMinM - 150) {
      hardFail = true;
      notes.push(`Ketinggian lahan (${Math.round(field.elevationM)} mdpl) terlalu rendah untuk ${crop.cropNameId} (min ${crop.altitudeMinM} mdpl).`);
    } else if (crop.altitudeMaxM !== null && field.elevationM > crop.altitudeMaxM + 150) {
      hardFail = true;
      notes.push(`Ketinggian lahan (${Math.round(field.elevationM)} mdpl) terlalu tinggi untuk ${crop.cropNameId} (maks ${crop.altitudeMaxM} mdpl).`);
    }
  }

  // 2. Soil pH check
  const phRule = crop.constraints.find(
    (c) => c.dimension === "soil" && (c.unit ?? "").toLowerCase() === "ph",
  );
  if (phRule !== undefined) {
    if (field.soilPh === null) {
      missingCount += 1;
      notes.push("pH tanah belum diisi.");
    } else {
      const check = evaluateRuleBounds(field.soilPh, phRule);
      if (!check.ok) {
        if (check.severe) {
          hardFail = true;
        } else {
          softWarn = true;
        }
        notes.push(
          `pH tanah (${field.soilPh}) di luar rentang ideal (${phRule.thresholdLower}–${phRule.thresholdUpper}).`,
        );
      }
    }
  }

  // 3. Water / Rainfall check
  const waterMmRule = crop.constraints.find(
    (c) => c.dimension === "water" && (c.unit ?? "").toLowerCase() === "mm",
  );
  if (waterMmRule !== undefined) {
    if (rain.rainfallMm === null) {
      missingCount += 1;
      notes.push("Data hujan untuk durasi tanam penuh belum tersedia.");
    } else if (waterMmRule.thresholdLower !== null && rain.rainfallMm < waterMmRule.thresholdLower) {
      if (field.irrigationAvailability === "irrigated") {
        softWarn = true;
        notes.push(`Hujan (${rain.rainfallMm} mm) di bawah kebutuhan, terbantu irigasi teknis.`);
      } else if (
        field.irrigationAvailability === "rainfed" &&
        rain.rainfallMm < waterMmRule.thresholdLower * 0.7
      ) {
        hardFail = true;
        notes.push(
          `Defisit hujan signifikan (${rain.rainfallMm} mm vs min ${waterMmRule.thresholdLower} mm) pada lahan tadah hujan.`,
        );
      } else {
        softWarn = true;
        notes.push(`Hujan (${rain.rainfallMm} mm) agak kurang; siapkan pengairan tambahan.`);
      }
    } else if (
      waterMmRule.thresholdUpper !== null &&
      rain.rainfallMm > waterMmRule.thresholdUpper * 1.25
    ) {
      softWarn = true;
      notes.push(`Curah hujan tinggi (~${rain.rainfallMm} mm); perhatikan drainase lahan.`);
    }
  } else {
    // Crops like kedelai/cabai without mm water threshold (OPEN-20)
    missingCount += 1;
  }

  // 4. Climate temperature check (optional latest observation)
  const tempRules = crop.constraints.filter(
    (c) => c.dimension === "climate" && (c.unit ?? "").toLowerCase().includes("c"),
  );
  if (tempRules.length > 0) {
    if (field.latestTempC === null) {
      missingCount += 1;
    } else {
      for (const tr of tempRules) {
        const check = evaluateRuleBounds(field.latestTempC, tr);
        if (!check.ok) {
          if (check.severe) hardFail = true;
          else softWarn = true;
          notes.push(`Suhu tercatat (${field.latestTempC} °C) di luar batas nyaman.`);
          break;
        }
      }
    }
  }

  let verdict: SuitabilityVerdict;
  if (hardFail) {
    verdict = "unsuitable";
  } else if (rain.rainfallMm === null && field.soilPh === null) {
    verdict = "insufficient_data";
  } else if (softWarn || missingCount > 0 || !rain.allSeasonal) {
    verdict = "conditional";
  } else {
    verdict = "suitable";
  }

  const noteId =
    notes.length > 0
      ? notes.join(" ")
      : rain.allSeasonal
        ? `Curah hujan (~${rain.rainfallMm} mm) dan profil lahan sesuai untuk ${crop.cropNameId}.`
        : `Pola hujan rata-rata (~${rain.rainfallMm} mm) mendukung; verifikasi prakiraan harian sebelum tanam.`;

  return {
    month: startMonth,
    verdict,
    evidenceClass,
    rainfallMm: rain.rainfallMm,
    noteId,
  };
}

/**
 * Evaluates all published catalog crops against a field's soil/irrigation profile and 12-month
 * climate outlook, producing a ranked list for `horizonMonths` and a 12-month planting window matrix.
 */
export function recommendCropsForField(input: {
  readonly field: FieldContextForRecommendation;
  readonly outlookMonths: readonly OutlookMonthPoint[];
  readonly crops: readonly CropCatalogCandidateInput[];
  readonly horizonMonths: 3 | 6 | 12;
}): FieldRecommendationsResult {
  const sortedMonths = [...input.outlookMonths]
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(0, 12);
  const monthKeys = sortedMonths.map((m) => m.month);

  const matrix: CropMatrixRowResult[] = [];
  const rankings: CropRankingResult[] = [];

  for (const crop of input.crops) {
    const cells = sortedMonths.map((m) =>
      evaluateCropAtMonth(crop, input.field, sortedMonths, m.month),
    );

    matrix.push({
      cropId: crop.cropId,
      cropSlug: crop.cropSlug,
      cropNameId: crop.cropNameId,
      cultivarName: crop.cultivarName,
      profileVersionId: crop.profileVersionId,
      cells,
    });

    const horizonCells = cells.slice(0, input.horizonMonths);
    const bestCell = [...horizonCells].sort((a, b) => {
      const rankDiff = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
      if (rankDiff !== 0) return rankDiff;
      return (b.rainfallMm ?? -1) - (a.rainfallMm ?? -1);
    })[0];

    const verdict: SuitabilityVerdict = bestCell?.verdict ?? "insufficient_data";
    const bestStartMonth = bestCell?.month ?? null;
    const evidenceBadge =
      bestCell?.evidenceClass === "seasonal_forecast"
        ? "Prakiraan musiman"
        : bestCell?.evidenceClass === "climatology"
          ? "Rata-rata iklim historis"
          : "Data cuaca belum lengkap";

    const monthPhrase =
      bestStartMonth !== null ? `Mulai terbaik ${formatMonthId(bestStartMonth)}. ` : "";
    const summaryId = `${monthPhrase}${bestCell?.noteId ?? "Data belum cukup untuk rekomendasi."}`;
    const keyFactorId = bestCell?.noteId ?? "Data belum lengkap";

    rankings.push({
      cropId: crop.cropId,
      cropSlug: crop.cropSlug,
      cropNameId: crop.cropNameId,
      category: crop.category,
      cultivarId: crop.cultivarId,
      cultivarName: crop.cultivarName,
      profileVersionId: crop.profileVersionId,
      durationDaysTypical: crop.durationDaysTypical,
      verdict,
      bestStartMonth,
      evidenceBadge,
      summaryId,
      keyFactorId,
    });
  }

  rankings.sort((a, b) => {
    const diff = VERDICT_RANK[a.verdict] - VERDICT_RANK[b.verdict];
    if (diff !== 0) return diff;
    return a.cropNameId.localeCompare(b.cropNameId);
  });

  return {
    fieldId: input.field.fieldId,
    fieldName: input.field.fieldName,
    horizonMonths: input.horizonMonths,
    indicativeNotice:
      "Rekomendasi bersifat himbauan indikatif berdasarkan profil tanah lahan dan perkiraan pola hujan 12 bulan.",
    months: monthKeys,
    rankings,
    matrix,
  };
}
