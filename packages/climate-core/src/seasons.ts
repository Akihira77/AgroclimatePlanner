export type SeasonCategory = "wet" | "transition" | "dry" | "missing";

export interface SeasonalOutlookMonthInput {
  readonly month: string; // YYYY-MM-01
  readonly valueMm: number | null;
  readonly dataClass?: string | null;
}

export interface SeasonalRegimePeriod {
  readonly startMonth: string;
  readonly endMonth: string;
  readonly monthCount: number;
  readonly category: SeasonCategory;
  readonly minMm: number | null;
  readonly maxMm: number | null;
  readonly avgMm: number | null;
  readonly dataClasses: readonly string[];
  readonly labelId: string;
  readonly guidanceId: string;
}

export interface CurrentMonthSeasonSummary {
  readonly category: SeasonCategory;
  readonly month: string;
  readonly valueMm: number | null;
  readonly summaryId: string;
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

function formatMonthId(isoMonth: string): string {
  const year = isoMonth.slice(0, 4);
  const m = Number(isoMonth.slice(5, 7));
  const label = m >= 1 && m <= 12 ? (SHORT_MONTHS_ID[m - 1] ?? isoMonth.slice(5, 7)) : isoMonth.slice(5, 7);
  return `${label} ${year}`;
}

/**
 * Classifies a single month's precipitation (mm) using simplified Oldeman agroclimate thresholds.
 * `null` or non-finite values always map to `"missing"` — never coerced to `0` or `"dry"`.
 */
export function classifyOldemanMonth(valueMm: number | null): SeasonCategory {
  if (valueMm === null || !Number.isFinite(valueMm)) return "missing";
  if (valueMm > 200) return "wet";
  if (valueMm >= 100) return "transition";
  return "dry";
}

function labelForCategory(category: SeasonCategory): string {
  switch (category) {
    case "wet":
      return "Periode Basah";
    case "transition":
      return "Periode Peralihan / Lembab";
    case "dry":
      return "Periode Kering";
    case "missing":
      return "Data Belum Tersedia";
  }
}

function guidanceForCategory(category: SeasonCategory): string {
  switch (category) {
    case "wet":
      return "Curah hujan tinggi (>200 mm/bln). Utamakan kelancaran saluran drainase, waspadai serangan jamur/busuk daun, dan manfaatkan untuk padi sawah atau tanaman berkebutuhan air tinggi.";
    case "transition":
      return "Curah hujan sedang (100–200 mm/bln). Waktu ideal untuk olah lahan, pemupukan dasar, serta menanam palawija atau sayuran dengan risiko genangan lebih rendah.";
    case "dry":
      return "Curah hujan rendah (<100 mm/bln). Siapkan irigasi tambahan, gunakan mulsa untuk menjaga kelembaban tanah, atau prioritaskan komoditas toleran kering seperti ubi kayu dan kacang tanah.";
    case "missing":
      return "Sebagian bulan belum memiliki data prakiraan atau rata-rata historis. Gunakan pengamatan lapangan dan jangan menganggap bulan kosong sebagai nol hujan.";
  }
}

/**
 * Groups consecutive 12-month outlook entries with the same Oldeman season category into
 * farmer-friendly seasonal regime periods.
 */
export function classifySeasonalRegimes(
  months: readonly SeasonalOutlookMonthInput[],
): readonly SeasonalRegimePeriod[] {
  if (months.length === 0) return [];

  const sorted = [...months].sort((a, b) => a.month.localeCompare(b.month));
  const periods: SeasonalRegimePeriod[] = [];

  let groupCategory = classifyOldemanMonth(sorted[0]!.valueMm);
  let groupItems: SeasonalOutlookMonthInput[] = [sorted[0]!];

  const flush = () => {
    const values = groupItems
      .map((item) => item.valueMm)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const dataClasses = Array.from(
      new Set(
        groupItems
          .map((item) => item.dataClass)
          .filter((dc): dc is string => typeof dc === "string" && dc.length > 0),
      ),
    );
    const minMm = values.length > 0 ? Math.round(Math.min(...values)) : null;
    const maxMm = values.length > 0 ? Math.round(Math.max(...values)) : null;
    const avgMm =
      values.length > 0
        ? Math.round(values.reduce((sum, v) => sum + v, 0) / values.length)
        : null;

    periods.push({
      startMonth: groupItems[0]!.month,
      endMonth: groupItems[groupItems.length - 1]!.month,
      monthCount: groupItems.length,
      category: groupCategory,
      minMm,
      maxMm,
      avgMm,
      dataClasses,
      labelId: labelForCategory(groupCategory),
      guidanceId: guidanceForCategory(groupCategory),
    });
  };

  for (let i = 1; i < sorted.length; i += 1) {
    const item = sorted[i]!;
    const cat = classifyOldemanMonth(item.valueMm);
    if (cat === groupCategory) {
      groupItems.push(item);
    } else {
      flush();
      groupCategory = cat;
      groupItems = [item];
    }
  }
  flush();

  return periods;
}

/**
 * Produces a 1-sentence Indonesian seasonal context summary for the current month.
 */
export function summariseCurrentMonthSeason(
  months: readonly SeasonalOutlookMonthInput[],
  currentMonthIso?: string,
): CurrentMonthSeasonSummary {
  const targetMonth = currentMonthIso ?? months[0]?.month ?? new Date().toISOString().slice(0, 7) + "-01";
  const found = months.find((m) => m.month.slice(0, 7) === targetMonth.slice(0, 7)) ?? months[0];
  if (found === undefined) {
    return {
      category: "missing",
      month: targetMonth,
      valueMm: null,
      summaryId: `Data pola musim untuk ${formatMonthId(targetMonth)} belum tersedia.`,
    };
  }
  const category = classifyOldemanMonth(found.valueMm);
  const monthLabel = formatMonthId(found.month);
  if (category === "missing" || found.valueMm === null) {
    return {
      category: "missing",
      month: found.month,
      valueMm: null,
      summaryId: `Data curah hujan bulanan untuk ${monthLabel} belum tersedia.`,
    };
  }
  const rounded = Math.round(found.valueMm);
  if (category === "wet") {
    return {
      category,
      month: found.month,
      valueMm: rounded,
      summaryId: `${monthLabel} tergolong Bulan Basah (~${rounded} mm) — pastikan drainase lahan lancar dan waspadai kelembaban tinggi.`,
    };
  }
  if (category === "transition") {
    return {
      category,
      month: found.month,
      valueMm: rounded,
      summaryId: `${monthLabel} tergolong Masa Peralihan (~${rounded} mm) — kondisi cukup seimbang untuk persiapan lahan dan tanam bertahap.`,
    };
  }
  return {
    category,
    month: found.month,
    valueMm: rounded,
    summaryId: `${monthLabel} tergolong Bulan Kering (~${rounded} mm) — siapkan pasokan air/irigasi tambahan atau pilih tanaman toleran kering.`,
  };
}
