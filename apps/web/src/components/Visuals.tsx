import type { ReactNode } from "react";
import type {
  Farm,
  Field,
  FieldObservation,
  Harvest,
  Planting,
  SuitabilityRunWithWindows,
} from "@agroclimate/contracts";
import {
  dayLabel,
  dimensionLabel,
  dimensionStateLabel,
  drainageClassLabel,
  gradeLabel,
  irrigationLabel,
  observationKindLabel,
  plantingStatusLabel,
  plantingStatusTone,
  soilTypeLabel,
  suitabilityLabel,
  suitabilityTone,
  Tag,
} from "../ui";

function normalizeSlug(slug: string): string {
  return slug.trim().toLowerCase();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatNumber(value: number, maxFractionDigits = 1): string {
  return value.toLocaleString("id-ID", {
    maximumFractionDigits: maxFractionDigits,
  });
}

function daysBetween(startIso: string, endIso: string): number {
  const start = Date.parse(startIso);
  const end = Date.parse(endIso);
  if (Number.isNaN(start) || Number.isNaN(end)) return 0;
  return Math.round((end - start) / 86_400_000);
}

/**
 * Simple botanical SVG icon/illustration per crop slug for farmer-friendly scanning.
 */
export function CropIllustration({ slug, size = 44 }: { slug: string; size?: number }) {
  const key = normalizeSlug(slug);

  let label = "Ilustrasi tanaman";
  let content: ReactNode;

  if (key.includes("padi") || key.includes("rice")) {
    label = "Ilustrasi tanaman padi";
    content = (
      <>
        <circle cx="24" cy="24" r="22" fill="#e7f5ee" />
        <path d="M24 39V15" stroke="#1f6f4a" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M24 27C19 26 16 22 15 17C19 18 22 21 24 27Z" fill="#40916c" />
        <path d="M24 22C29 21 32 17 33 12C29 13 26 16 24 22Z" fill="#2d6a4f" />
        <ellipse cx="22" cy="14" rx="2.3" ry="3.6" fill="#d4a017" />
        <ellipse cx="26.5" cy="16" rx="2.3" ry="3.5" fill="#eab308" />
        <ellipse cx="21.5" cy="19.5" rx="2.2" ry="3.3" fill="#eab308" />
        <ellipse cx="26.5" cy="21.5" rx="2.2" ry="3.2" fill="#ca8a04" />
      </>
    );
  } else if (key.includes("jagung") || key.includes("corn") || key.includes("maize")) {
    label = "Ilustrasi tanaman jagung";
    content = (
      <>
        <circle cx="24" cy="24" r="22" fill="#fef3c7" />
        <ellipse cx="24" cy="22" rx="6" ry="11.5" fill="#eab308" />
        <path d="M20 16H28M19 20H29M19 24H29M20 28H28" stroke="#ca8a04" strokeWidth="1.2" />
        <path d="M18 35C16 29 16 23 19 19C20 25 21 30 24 36Z" fill="#2d6a4f" />
        <path d="M30 35C32 29 32 23 29 19C28 25 27 30 24 36Z" fill="#40916c" />
        <path
          d="M24 10.5C23 8 25 7.5 26 10.5"
          stroke="#a16207"
          strokeWidth="1.8"
          strokeLinecap="round"
        />
      </>
    );
  } else if (key.includes("kedelai") || key.includes("soy")) {
    label = "Ilustrasi tanaman kedelai";
    content = (
      <>
        <circle cx="24" cy="24" r="22" fill="#ecfdf3" />
        <path
          d="M15 33C17 24 22 17 31 13"
          stroke="#1f6f4a"
          strokeWidth="2.4"
          strokeLinecap="round"
          fill="none"
        />
        <rect
          x="19"
          y="16"
          width="14"
          height="7"
          rx="3.5"
          transform="rotate(-22 19 16)"
          fill="#52b788"
        />
        <circle cx="22.5" cy="18.2" r="1.9" fill="#d8f3dc" />
        <circle cx="26.8" cy="16.4" r="1.9" fill="#d8f3dc" />
        <rect
          x="17"
          y="25"
          width="14"
          height="7"
          rx="3.5"
          transform="rotate(14 17 25)"
          fill="#2d6a4f"
        />
        <circle cx="21" cy="28.6" r="1.8" fill="#b7e4c7" />
        <circle cx="25.5" cy="29.7" r="1.8" fill="#b7e4c7" />
      </>
    );
  } else if (key.includes("cabai") || key.includes("chili")) {
    label = "Ilustrasi tanaman cabai";
    content = (
      <>
        <circle cx="24" cy="24" r="22" fill="#fee4e2" />
        <path
          d="M25 11C25 13 24 15 24 17"
          stroke="#1f6f4a"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path d="M21 17C21 15 27 15 27 17C28 24 26 32 19 36C21 30 20 23 21 17Z" fill="#dc2626" />
        <path
          d="M23 19C23 24 22 29 20 33"
          stroke="#fca5a5"
          strokeWidth="1.4"
          strokeLinecap="round"
          fill="none"
        />
      </>
    );
  } else {
    content = (
      <>
        <circle cx="24" cy="24" r="22" fill="#e7f5ee" />
        <path d="M24 36V19" stroke="#1f6f4a" strokeWidth="2.4" strokeLinecap="round" />
        <path d="M24 25C17 25 14 20 14 14C20 14 24 18 24 25Z" fill="#40916c" />
        <path d="M24 21C31 21 34 16 34 10C28 10 24 14 24 21Z" fill="#1f6f4a" />
      </>
    );
  }

  return (
    <span className="crop-badge" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox="0 0 48 48" role="img" aria-label={label}>
        {content}
      </svg>
    </span>
  );
}

/**
 * Horizontal proportional area bar chart per farm, comparing total hectares and plot counts.
 */
export function FarmAreaBarChart({ farms, fields }: { farms: Farm[]; fields: Field[] }) {
  if (farms.length === 0) return null;

  const rows = farms
    .map((farm) => {
      const farmFields = fields.filter((f) => f.farmId === farm.id);
      const areaHa = farmFields.reduce((sum, f) => sum + (f.areaHa || 0), 0);
      return {
        id: farm.id,
        name: farm.name,
        region: farm.region,
        fieldCount: farmFields.length,
        areaHa,
      };
    })
    .sort((a, b) => b.areaHa - a.areaHa);

  const maxArea = Math.max(...rows.map((r) => r.areaHa), 0.1);
  const totalArea = rows.reduce((sum, r) => sum + r.areaHa, 0);

  return (
    <section className="visual-card" aria-label="Sebaran luas lahan per kebun">
      <div className="visual-card-head">
        <div>
          <h3>Luas Lahan per Kebun</h3>
          <p className="muted">
            Total {formatNumber(totalArea, 2)} ha di {rows.length} kebun
          </p>
        </div>
      </div>
      <div className="hbar-list">
        {rows.map((row) => {
          const pct = clamp((row.areaHa / maxArea) * 100, row.areaHa > 0 ? 6 : 0, 100);
          return (
            <div key={row.id} className="hbar-row">
              <div className="hbar-label">
                <strong>{row.name}</strong>
                <span className="muted">
                  {row.fieldCount} petak{row.region ? ` • ${row.region}` : ""}
                </span>
              </div>
              <div className="hbar-track" aria-hidden="true">
                <div className="hbar-fill" style={{ width: `${pct}%` }} />
              </div>
              <div className="hbar-val">
                {row.areaHa > 0 ? `${formatNumber(row.areaHa, 2)} ha` : "0 ha"}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

/**
 * Visual progress cards for active or recent plantings showing days elapsed vs expected harvest.
 */
export function PlantingProgressList({
  plantings,
  fields,
  maxItems = 4,
}: {
  plantings: Planting[];
  fields: Field[];
  maxItems?: number;
}) {
  if (plantings.length === 0) return null;

  const fieldById = new Map(fields.map((f) => [f.id, f]));
  const todayIso = new Date().toISOString().slice(0, 10);
  const sorted = [...plantings]
    .sort((a, b) => b.plantedAt.localeCompare(a.plantedAt))
    .slice(0, maxItems);

  return (
    <section className="visual-card" aria-label="Progres tanam aktif">
      <div className="visual-card-head">
        <div>
          <h3>Progres Siklus Tanam</h3>
          <p className="muted">Perkiraan posisi tanam menuju panen utama</p>
        </div>
      </div>
      <div className="progress-cards">
        {sorted.map((p) => {
          const field = fieldById.get(p.fieldId);
          const totalDays = Math.max(1, daysBetween(p.plantedAt, p.expectedHarvestTypical));
          const elapsed = Math.max(0, daysBetween(p.plantedAt, todayIso));
          const isCompleted = p.status === "harvested" || p.status === "failed";
          const pct =
            p.status === "harvested" ? 100 : clamp(Math.round((elapsed / totalDays) * 100), 0, 100);
          const remaining = Math.max(0, totalDays - elapsed);

          return (
            <div key={p.id} className="progress-item">
              <div className="progress-item-top">
                <div className="progress-item-title">
                  <CropIllustration slug={p.cropNameId} size={36} />
                  <div>
                    <strong>{p.cropNameId}</strong>
                    <div className="muted">
                      {field?.name ?? "Petak"} • {p.cultivarName}
                    </div>
                  </div>
                </div>
                <Tag tone={plantingStatusTone(p.status)}>{plantingStatusLabel(p.status)}</Tag>
              </div>
              <div
                className="progress-track"
                role="progressbar"
                aria-valuenow={pct}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-label={`Progres ${p.cropNameId} ${pct}%`}
              >
                <div
                  className={`progress-fill ${
                    p.status === "failed"
                      ? "progress-fill-danger"
                      : p.status === "harvested"
                        ? "progress-fill-done"
                        : ""
                  }`}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <div className="progress-item-meta">
                <span>Tanam: {dayLabel(p.plantedAt)}</span>
                <span>
                  {isCompleted
                    ? `Panen tercatat: ${formatNumber(p.totalYieldKg, 1)} kg`
                    : remaining === 0
                      ? "Siap panen / memasuki jendela panen"
                      : `Hari ke-${elapsed} dari ~${totalDays} hari (sisa ${remaining} hari)`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function phCategory(ph: number): { label: string; tone: "accent" | "warn" | "danger" } {
  if (ph < 5.0) return { label: "Terlalu asam", tone: "danger" };
  if (ph < 5.5) return { label: "Agak asam", tone: "warn" };
  if (ph <= 7.0) return { label: "Subur / ideal", tone: "accent" };
  if (ph <= 7.8) return { label: "Agak basa", tone: "warn" };
  return { label: "Terlalu basa", tone: "danger" };
}

/**
 * Visual soil & field condition card: 3.0-10.0 pH scale meter + 4 condition badges.
 */
export function SoilProfileVisual({
  soilType,
  drainageClass,
  irrigationAvailability,
  soilPh,
  elevationM,
}: {
  soilType: string | null | undefined;
  drainageClass: string | null | undefined;
  irrigationAvailability: string | null | undefined;
  soilPh: number | null | undefined;
  elevationM: number | null | undefined;
}) {
  const hasPh = typeof soilPh === "number" && Number.isFinite(soilPh);
  const phPos = hasPh ? clamp(((soilPh - 3) / 7) * 100, 2, 98) : null;
  const phInfo = hasPh ? phCategory(soilPh) : null;

  return (
    <div className="soil-visual" aria-label="Ringkasan visual kondisi tanah dan air">
      <div className="ph-meter">
        <div className="ph-meter-head">
          <span>Tingkat Keasaman Tanah (pH)</span>
          {hasPh && phInfo ? (
            <Tag tone={phInfo.tone}>
              pH {formatNumber(soilPh, 1)} • {phInfo.label}
            </Tag>
          ) : (
            <Tag>Belum diukur</Tag>
          )}
        </div>
        <div className="ph-track" aria-hidden="true">
          <span className="ph-zone ph-zone-acid">Asam (&lt;5,5)</span>
          <span className="ph-zone ph-zone-ideal">Ideal (5,5–7,0)</span>
          <span className="ph-zone ph-zone-alkaline">Basa (&gt;7,0)</span>
          {phPos !== null && <span className="ph-pin" style={{ left: `${phPos}%` }} />}
        </div>
        <div className="ph-scale-ticks">
          <span>3,0</span>
          <span>5,5</span>
          <span>7,0</span>
          <span>10,0</span>
        </div>
      </div>

      <div className="soil-gauges">
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Jenis Tanah</span>
          <strong>{soilType ? soilTypeLabel(soilType as never) : "Belum diisi"}</strong>
        </div>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Aliran Air</span>
          <strong>
            {drainageClass ? drainageClassLabel(drainageClass as never) : "Belum diisi"}
          </strong>
        </div>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Pengairan</span>
          <strong>
            {irrigationAvailability
              ? irrigationLabel(irrigationAvailability as never)
              : "Belum diisi"}
          </strong>
        </div>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Ketinggian</span>
          <strong>
            {typeof elevationM === "number" && Number.isFinite(elevationM)
              ? `${formatNumber(elevationM, 0)} mdpl`
              : "Belum diisi"}
          </strong>
        </div>
      </div>
    </div>
  );
}

export interface TimelineStageItem {
  id: string;
  name: string;
  startDayOffset: number;
  endDayOffset: number;
  isCritical: boolean;
  subtitle?: string | null;
}

const STAGE_COLORS = ["#2d6a4f", "#40916c", "#52b788", "#74c69d", "#1b4332"];

/**
 * Proportional horizontal timeline bar showing crop growth stages and critical periods.
 */
export function GrowthStageTimeline({
  stages,
  totalDays,
  todayOffset,
}: {
  stages: TimelineStageItem[];
  totalDays?: number;
  todayOffset?: number | null;
}) {
  if (stages.length === 0) return null;

  const computedMax = Math.max(totalDays ?? 0, ...stages.map((s) => s.endDayOffset), 1);
  const showToday =
    typeof todayOffset === "number" &&
    Number.isFinite(todayOffset) &&
    todayOffset >= 0 &&
    todayOffset <= computedMax;
  const todayPct = showToday ? clamp((todayOffset / computedMax) * 100, 1, 99) : null;

  return (
    <div className="stage-timeline" aria-label="Diagram linimasa fase tumbuh tanaman">
      <div className="stage-bar-wrap">
        <div
          className="stage-bar"
          role="img"
          aria-label={`Linimasa ${stages.length} fase tanam selama ${computedMax} hari`}
        >
          {stages.map((stage, idx) => {
            const span = Math.max(1, stage.endDayOffset - stage.startDayOffset);
            const widthPct = (span / computedMax) * 100;
            const bg = stage.isCritical ? "#d97706" : STAGE_COLORS[idx % STAGE_COLORS.length];
            return (
              <div
                key={stage.id}
                className={`stage-seg ${stage.isCritical ? "stage-seg-critical" : ""}`}
                style={{ width: `${widthPct}%`, backgroundColor: bg }}
                title={`${stage.name}: Hari ${stage.startDayOffset}–${stage.endDayOffset} (${span} hari)${stage.isCritical ? " • Fase Kritis" : ""}`}
              >
                {widthPct >= 14 ? <span>{stage.name}</span> : null}
              </div>
            );
          })}
        </div>
        {todayPct !== null && (
          <div className="stage-today-pin" style={{ left: `${todayPct}%` }}>
            <span>Hari ini (H+{todayOffset})</span>
          </div>
        )}
      </div>

      <div className="stage-legend">
        {stages.map((stage, idx) => {
          const span = Math.max(1, stage.endDayOffset - stage.startDayOffset);
          const color = stage.isCritical ? "#d97706" : STAGE_COLORS[idx % STAGE_COLORS.length];
          return (
            <div key={stage.id} className="stage-legend-item">
              <span className="stage-dot" style={{ backgroundColor: color }} aria-hidden="true" />
              <div>
                <strong>{stage.name}</strong>
                <span className="muted">
                  {" "}
                  (H{stage.startDayOffset}–{stage.endDayOffset}, {span} hr)
                </span>
                {stage.isCritical ? <Tag tone="warn">Fase Kritis</Tag> : null}
                {stage.subtitle ? <div className="muted">{stage.subtitle}</div> : null}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Visual evaluation summary: large verdict banner + 5-aspect status grid.
 */
export function EvaluationVisualSummary({ run }: { run: SuitabilityRunWithWindows }) {
  const bestWindow =
    run.plantingWindows.find((w) => w.suitability !== "unsuitable") ?? run.plantingWindows[0];
  const tone = bestWindow ? suitabilityTone(bestWindow.suitability) : "neutral";
  const verdictText = bestWindow ? suitabilityLabel(bestWindow.suitability) : "Belum dievaluasi";
  const readyWindows = run.plantingWindows.filter(
    (w) => w.suitability && w.suitability !== "unsuitable",
  ).length;

  return (
    <div className="eval-visual" aria-label="Ringkasan visual kecocokan lahan">
      <div className={`verdict-banner verdict-${tone}`}>
        <div>
          <span className="verdict-k">Hasil Kecocokan Jendela Tanam</span>
          <strong>{verdictText}</strong>
          <p>
            {readyWindows > 0
              ? `${readyWindows} dari ${run.plantingWindows.length} jendela evaluasi layak untuk mulai tanam.`
              : `Belum ada jendela yang layak tanam atau data pendukung masih terbatas.`}
          </p>
        </div>
        <div className="row">
          {run.maxAchievableLevel !== null ? (
            <Tag tone="accent">{gradeLabel(run.maxAchievableLevel)}</Tag>
          ) : null}
          <Tag tone={tone}>
            Pengairan: {irrigationLabel(run.fieldSnapshot.irrigationAvailability)}
          </Tag>
        </div>
      </div>

      <div className="aspect-grid">
        {run.dimensionCoverage.map((d) => {
          const ok = d.state === "known";
          const na = d.state === "not_applicable";
          return (
            <div
              key={d.dimension}
              className={`aspect-tile ${ok ? "aspect-ok" : na ? "aspect-missing" : "aspect-warn"}`}
            >
              <span className="aspect-dot" aria-hidden="true" />
              <div>
                <strong>{dimensionLabel(d.dimension)}</strong>
                <div className="muted">{dimensionStateLabel(d.state)}</div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function metricTitle(dimension: string, unit: string | null): string {
  const u = unit?.trim().toLowerCase() ?? "";
  if (dimension === "soil" && u === "ph") return "Keasaman Tanah (pH)";
  if (dimension === "climate" && (u === "°c" || u === "c" || u === "celsius")) {
    return "Suhu Udara";
  }
  if (dimension === "water" && u === "mm") return "Kebutuhan Air / Hujan";
  if (dimension === "water" && u === "cm") return "Tinggi Genangan Air";
  return dimensionLabel(dimension);
}

function formatThresholdText(item: Record<string, unknown>): string | null {
  const comparator = typeof item["comparator"] === "string" ? item["comparator"] : null;
  const unit = typeof item["unit"] === "string" ? item["unit"] : "";
  const lower = typeof item["thresholdLower"] === "number" ? item["thresholdLower"] : null;
  const upper = typeof item["thresholdUpper"] === "number" ? item["thresholdUpper"] : null;
  const count = typeof item["thresholdCount"] === "number" ? item["thresholdCount"] : null;
  const suffix = unit ? ` ${unit}` : "";

  if (comparator === "range" && lower !== null && upper !== null) {
    return `${formatNumber(lower, 1)} – ${formatNumber(upper, 1)}${suffix}`;
  }
  if (comparator === "min" && lower !== null) {
    return `Minimal ${formatNumber(lower, 1)}${suffix}`;
  }
  if (comparator === "max" && upper !== null) {
    return `Maksimal ${formatNumber(upper, 1)}${suffix}`;
  }
  if (comparator === "count" && count !== null) {
    return `Maksimal ${formatNumber(count, 0)} kejadian`;
  }
  return null;
}

function sourceLabel(source: unknown): string | null {
  switch (source) {
    case "field_profile":
      return "Profil tanah lahan";
    case "field_observation":
      return "Pengamatan lapangan";
    case "request":
      return "Input evaluasi";
    default:
      return null;
  }
}

function missingHint(dimension: string, unit: string | null): string {
  const u = unit?.trim().toLowerCase() ?? "";
  if (dimension === "soil" && u === "ph") {
    return "Lengkapi nilai pH tanah di menu Kebun & Lahan → Detail.";
  }
  if (dimension === "climate" && (u === "°c" || u === "c" || u === "celsius")) {
    return "Catat suhu lapangan di menu Aktivitas & Panen → Pengamatan Lapangan.";
  }
  if (dimension === "water") {
    return "Data curah hujan / tinggi air belum tercatat untuk periode ini.";
  }
  return "Data pengukuran belum tersedia pada lahan ini.";
}

/**
 * Farmer-friendly comparison of crop requirements against observed field conditions.
 */
export function ConstraintCheckList({ items }: { items: readonly Record<string, unknown>[] }) {
  if (items.length === 0) return null;

  return (
    <div className="check-section" aria-label="Perbandingan syarat tanaman dan kondisi lahan">
      <div className="check-section-title">Syarat Tanaman vs Kondisi Lahan Anda</div>
      <div className="check-grid">
        {items.map((item, idx) => {
          const id =
            typeof item["constraintId"] === "string" ? item["constraintId"] : `constraint-${idx}`;
          const dimension = typeof item["dimension"] === "string" ? item["dimension"] : "climate";
          const outcome =
            typeof item["outcome"] === "string" ? item["outcome"] : "insufficient_data";
          const unit = typeof item["unit"] === "string" ? item["unit"] : null;
          const observed =
            typeof item["observed"] === "number" && Number.isFinite(item["observed"])
              ? item["observed"]
              : null;
          const ideal = formatThresholdText(item);
          const src = sourceLabel(item["source"]);

          const statusTone =
            outcome === "satisfied" ? "accent" : outcome === "violated" ? "danger" : "warn";
          const statusText =
            outcome === "satisfied"
              ? "Cocok"
              : outcome === "violated"
                ? "Di luar batas"
                : "Data belum ada";
          const cardClass =
            outcome === "satisfied"
              ? "check-card-ok"
              : outcome === "violated"
                ? "check-card-danger"
                : "check-card-warn";

          return (
            <div key={id} className={`check-card ${cardClass}`}>
              <div className="spread">
                <strong>{metricTitle(dimension, unit)}</strong>
                <Tag tone={statusTone}>{statusText}</Tag>
              </div>
              <div className="check-values">
                <div>
                  <span className="muted">Kondisi lahan: </span>
                  <strong>
                    {observed !== null
                      ? `${formatNumber(observed, 1)}${unit ? ` ${unit}` : ""}`
                      : "Belum tercatat"}
                  </strong>
                </div>
                {ideal !== null ? (
                  <div>
                    <span className="muted">Syarat ideal: </span>
                    <span>{ideal}</span>
                  </div>
                ) : null}
              </div>
              {src !== null ? (
                <div className="check-hint">Sumber: {src}</div>
              ) : outcome === "insufficient_data" ? (
                <div className="check-hint">{missingHint(dimension, unit)}</div>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Vertical SVG bar chart comparing harvest yields (kg) across recorded harvests.
 */
export function HarvestBarChart({ items }: { items: Harvest[] }) {
  if (items.length === 0) return null;

  const sorted = [...items].sort((a, b) => a.harvestedAt.localeCompare(b.harvestedAt)).slice(-10);
  const maxYield = Math.max(...sorted.map((i) => i.yieldKg), 1);
  const totalYield = items.reduce((sum, i) => sum + i.yieldKg, 0);

  const width = Math.max(360, sorted.length * 56 + 48);
  const height = 165;
  const chartBottom = 132;
  const chartTop = 24;
  const plotH = chartBottom - chartTop;

  return (
    <div className="visual-card" aria-label="Grafik hasil panen">
      <div className="visual-card-head">
        <div>
          <h3>Grafik Hasil Panen</h3>
          <p className="muted">
            Total {formatNumber(totalYield, 1)} kg dari {items.length} catatan panen
          </p>
        </div>
      </div>
      <div className="chart-scroll">
        <svg
          viewBox={`0 0 ${width} ${height}`}
          className="chart-svg"
          role="img"
          aria-label={`Grafik batang hasil panen ${sorted.length} entri`}
        >
          <line
            x1="20"
            y1={chartBottom}
            x2={width - 20}
            y2={chartBottom}
            stroke="#c4d0c7"
            strokeWidth="1"
          />
          {sorted.map((item, idx) => {
            const x = 32 + idx * 54;
            const barH = Math.max(6, (item.yieldKg / maxYield) * plotH);
            const y = chartBottom - barH;
            return (
              <g key={item.id}>
                <rect x={x} y={y} width="32" height={barH} rx="6" fill="#1f6f4a" />
                <text
                  x={x + 16}
                  y={y - 6}
                  textAnchor="middle"
                  fontSize="11"
                  fontWeight="700"
                  fill="#132219"
                >
                  {formatNumber(item.yieldKg, 0)} kg
                </text>
                <text
                  x={x + 16}
                  y={chartBottom + 16}
                  textAnchor="middle"
                  fontSize="10"
                  fill="#4b5d52"
                >
                  {item.harvestedAt.slice(5, 10)}
                </text>
              </g>
            );
          })}
        </svg>
      </div>
    </div>
  );
}

/**
 * Grouped SVG bar charts for numeric field observations (rainfall, temperature, soil moisture).
 */
export function ObservationTrendChart({ observations }: { observations: FieldObservation[] }) {
  const numericKinds = ["rainfall", "temperature", "soil_moisture"] as const;
  const groups = numericKinds
    .map((kind) => {
      const points = observations
        .filter((o) => o.kind === kind && typeof o.value === "number")
        .sort((a, b) => a.observedAt.localeCompare(b.observedAt))
        .slice(-8);
      return { kind, points };
    })
    .filter((g) => g.points.length > 0);

  if (groups.length === 0) return null;

  const colorMap: Record<(typeof numericKinds)[number], string> = {
    rainfall: "#0284c7",
    temperature: "#d97706",
    soil_moisture: "#1f6f4a",
  };

  return (
    <div className="obs-charts" aria-label="Grafik tren pengamatan lapangan">
      {groups.map(({ kind, points }) => {
        const maxVal = Math.max(...points.map((p) => p.value ?? 0), 1);
        const unit = points[points.length - 1]?.unit ?? "";
        const width = Math.max(280, points.length * 46 + 32);
        const height = 148;
        const bottom = 118;
        const top = 22;
        const plotH = bottom - top;
        const color = colorMap[kind];

        return (
          <div key={kind} className="visual-card">
            <div className="visual-card-head">
              <div>
                <h3>{observationKindLabel(kind)}</h3>
                <p className="muted">
                  {points.length} catatan terbaru{unit ? ` (${unit})` : ""}
                </p>
              </div>
            </div>
            <div className="chart-scroll">
              <svg
                viewBox={`0 0 ${width} ${height}`}
                className="chart-svg"
                role="img"
                aria-label={`Grafik ${observationKindLabel(kind)}`}
              >
                <line
                  x1="16"
                  y1={bottom}
                  x2={width - 16}
                  y2={bottom}
                  stroke="#c4d0c7"
                  strokeWidth="1"
                />
                {points.map((pt, idx) => {
                  const val = pt.value ?? 0;
                  const x = 24 + idx * 44;
                  const barH = Math.max(5, (val / maxVal) * plotH);
                  const y = bottom - barH;
                  return (
                    <g key={pt.id}>
                      <rect x={x} y={y} width="26" height={barH} rx="5" fill={color} />
                      <text
                        x={x + 13}
                        y={y - 5}
                        textAnchor="middle"
                        fontSize="10"
                        fontWeight="700"
                        fill="#132219"
                      >
                        {formatNumber(val, 1)}
                      </text>
                      <text
                        x={x + 13}
                        y={bottom + 15}
                        textAnchor="middle"
                        fontSize="9.5"
                        fill="#4b5d52"
                      >
                        {pt.observedAt.slice(5, 10)}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        );
      })}
    </div>
  );
}
