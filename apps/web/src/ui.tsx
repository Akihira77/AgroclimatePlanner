import { useState, type ReactNode } from "react";

import { ApiError, describeError } from "./api.js";
import { IconChevronDown, IconInfo } from "./icons.js";

export const DATA_CHANGED_EVENT = "agroclimate:data-changed";

export function notifyDataChanged(): void {
  window.dispatchEvent(new CustomEvent(DATA_CHANGED_EVENT));
}

export function InfoTooltip({ text }: { readonly text: string }) {
  const [open, setOpen] = useState(false);
  return (
    <span
      className="tooltip-wrap"
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
    >
      <button
        type="button"
        className="tooltip-trigger"
        aria-label={text}
        aria-expanded={open}
        onClick={() => setOpen((prev) => !prev)}
        onBlur={() => setOpen(false)}
      >
        i
      </button>
      {open ? (
        <span className="tooltip-bubble" role="tooltip">
          {text}
        </span>
      ) : null}
    </span>
  );
}

export function FieldLabel({
  htmlFor,
  label,
  tooltip,
}: {
  readonly htmlFor?: string;
  readonly label: string;
  readonly tooltip?: string;
}) {
  return (
    <div className="field-label-row">
      {htmlFor === undefined ? (
        <span className="field-label-text">{label}</span>
      ) : (
        <label htmlFor={htmlFor}>{label}</label>
      )}
      {tooltip === undefined ? null : <InfoTooltip text={tooltip} />}
    </div>
  );
}

/** Monospaced technical identifier for optional details. */
export function Mono({ children }: { readonly children: ReactNode }) {
  return <span className="mono">{children}</span>;
}

export type Tone = "accent" | "warn" | "danger" | "neutral";

export function Tag({
  tone = "neutral",
  children,
}: {
  readonly tone?: Tone | undefined;
  readonly children: ReactNode;
}) {
  return (
    <span className="tag" data-tone={tone === "neutral" ? undefined : tone}>
      {children}
    </span>
  );
}

export function Notice({
  tone = "info",
  children,
}: {
  readonly tone?: "info" | "success" | "warn" | "error" | undefined;
  readonly children: ReactNode;
}) {
  return (
    <div
      className="notice"
      data-tone={tone === "info" ? undefined : tone}
      role={tone === "error" ? "alert" : undefined}
    >
      {children}
    </div>
  );
}

export function Loading({ label = "Memuat data…" }: { readonly label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Consistent error banner across every page. */
export function ErrorNotice({ error, note }: { readonly error: unknown; readonly note?: string }) {
  return (
    <Notice tone="error">
      <span>{describeError(error)}</span>
      {note ? <span className="faint"> · {note}</span> : null}
      {error instanceof ApiError && error.requestId !== undefined ? (
        <span className="faint"> · Ref: {error.requestId.slice(0, 8)}</span>
      ) : null}
    </Notice>
  );
}

export interface GuideStep {
  readonly title: string;
  readonly detail: string;
}

export interface GuideTerm {
  readonly term: string;
  readonly meaning: string;
}

function readGuideCollapsed(storageKey: string): boolean {
  try {
    return window.localStorage.getItem(`agroclimate.guide.${storageKey}`) === "collapsed";
  } catch {
    return false;
  }
}

function writeGuideCollapsed(storageKey: string, collapsed: boolean): void {
  try {
    if (collapsed) {
      window.localStorage.setItem(`agroclimate.guide.${storageKey}`, "collapsed");
    } else {
      window.localStorage.removeItem(`agroclimate.guide.${storageKey}`);
    }
  } catch {
    // Ignore storage unavailability (private browsing or sandboxed contexts).
  }
}

/**
 * Collapsible per-page guidance banner so users immediately understand what a screen
 * does, what order to take actions, and what domain labels mean.
 */
export function PageGuide({
  storageKey,
  title,
  summary,
  steps,
  glossary,
  tip,
}: {
  readonly storageKey: string;
  readonly title: string;
  readonly summary: string;
  readonly steps: readonly GuideStep[];
  readonly glossary?: readonly GuideTerm[];
  readonly tip?: string;
}) {
  const [collapsed, setCollapsed] = useState(() => readGuideCollapsed(storageKey));

  const toggle = (next: boolean) => {
    setCollapsed(next);
    writeGuideCollapsed(storageKey, next);
  };

  if (collapsed) {
    return (
      <div className="page-guide-collapsed">
        <span className="page-guide-collapsed-label">
          <IconInfo size={16} />
          <span>{title}</span>
        </span>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          onClick={() => toggle(false)}
          aria-expanded={false}
        >
          Tampilkan panduan halaman
        </button>
      </div>
    );
  }

  return (
    <aside className="page-guide" aria-label={title}>
      <div className="page-guide-head">
        <div className="page-guide-title">
          <span className="page-guide-icon">
            <IconInfo size={18} />
          </span>
          <div>
            <h2>{title}</h2>
            <p className="page-guide-summary">{summary}</p>
          </div>
        </div>
        <button
          type="button"
          className="btn btn-quiet btn-sm"
          onClick={() => toggle(true)}
          aria-expanded={true}
        >
          <span>Sembunyikan panduan</span>
          <IconChevronDown size={15} />
        </button>
      </div>

      <div className="guide-steps">
        {steps.map((step, index) => (
          <div className="guide-step" key={step.title}>
            <span className="guide-step-num">{index + 1}</span>
            <div>
              <strong>{step.title}</strong>
              <p>{step.detail}</p>
            </div>
          </div>
        ))}
      </div>

      {glossary !== undefined && glossary.length > 0 ? (
        <div className="guide-glossary" aria-label="Arti istilah">
          {glossary.map((item) => (
            <span className="guide-term" key={item.term}>
              <strong>{item.term}:</strong>
              <span>{item.meaning}</span>
            </span>
          ))}
        </div>
      ) : null}

      {tip !== undefined ? <div className="page-guide-tip">{tip}</div> : null}
    </aside>
  );
}

const MONTHS = [
  "Januari",
  "Februari",
  "Maret",
  "April",
  "Mei",
  "Juni",
  "Juli",
  "Agustus",
  "September",
  "Oktober",
  "November",
  "Desember",
];

/** `2026-11-01` → `November 2026`. */
export function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  if (year === undefined || month === undefined) return isoDate;
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** `2026-11-27` → `27 Nov`. */
export function dayLabel(isoDate: string): string {
  const [, month, day] = isoDate.split("-");
  if (month === undefined || day === undefined) return isoDate;
  return `${Number(day)} ${MONTHS[Number(month) - 1]?.slice(0, 3) ?? month}`;
}

export function millimetres(value: number): string {
  return `${value.toLocaleString("id-ID", { maximumFractionDigits: 1 })} mm`;
}

export function dataClassLabel(dataClass: string): string {
  switch (dataClass) {
    case "weather_forecast":
      return "Prakiraan cuaca harian";
    case "subseasonal_forecast":
      return "Prakiraan jangka menengah";
    case "seasonal_forecast":
      return "Prakiraan musiman";
    case "climatology":
      return "Rata-rata iklim historis";
    case "field_observation":
      return "Pengamatan lapangan";
    case "station_observation":
      return "Pengamatan stasiun";
    case "satellite_estimate":
      return "Estimasi satelit";
    default:
      return dataClass;
  }
}

export function missingReasonLabel(reason: string): string {
  switch (reason) {
    case "pending":
      return "Sedang disiapkan";
    case "provider_null":
      return "Belum tersedia dari sumber";
    case "not_requested":
      return "Tidak diminta";
    case "beyond_horizon":
      return "Di luar rentang prakiraan";
    case "insufficient_history":
      return "Riwayat data belum cukup";
    case "insufficient_provenance":
      return "Sumber data belum lengkap";
    default:
      return reason;
  }
}

export function availabilityLabel(value: string): string {
  return value === "stale" ? "Perlu diperbarui" : "Terbaru";
}

export function dimensionLabel(dimension: string): string {
  switch (dimension) {
    case "climate":
      return "Iklim & Cuaca";
    case "water":
      return "Ketersediaan Air";
    case "soil":
      return "Kondisi Tanah";
    case "timing":
      return "Waktu Tanam";
    case "risk":
      return "Risiko Cuaca";
    default:
      return dimension;
  }
}

export function dimensionStateLabel(state: string): string {
  switch (state) {
    case "known":
      return "Tersedia";
    case "not_applicable":
      return "Tidak disyaratkan";
    default:
      return "Belum lengkap";
  }
}

export function translateEvaluationDetail(detail: string): string {
  const text = detail.trim();
  if (
    /^the critical stage rests on climatology, which cannot support a suitable verdict$/i.test(text)
  ) {
    return "Evaluasi ini memakai rata-rata iklim historis (bukan prakiraan cuaca jangka pendek), sehingga status maksimal adalah Sesuai bersyarat.";
  }

  if (/^the critical stage is not fully covered by weather evidence/i.test(text)) {
    return "Fase kritis tanaman belum tercakup penuh oleh data prakiraan cuaca, sehingga status maksimal adalah Sesuai bersyarat.";
  }

  if (/^a short-range daily weather forecast cannot cover a critical stage beyond/i.test(text)) {
    return "Prakiraan cuaca harian hanya menjangkau 16 hari ke depan dan belum mencakup fase kritis yang jatuh lebih jauh, sehingga status maksimal adalah Sesuai bersyarat.";
  }

  if (/^climate criteria rely on a single point-in-time field observation/i.test(text)) {
    return "Penilaian suhu masih bersandar pada catatan pengamatan tunggal di lapangan (bukan prakiraan cuaca selama fase kritis), sehingga status maksimal adalah Sesuai bersyarat.";
  }

  const hardViolated =
    /^a hard (climate|water|soil|timing|risk) constraint was observed and violated$/i.exec(text);
  if (hardViolated?.[1] !== undefined) {
    return `Syarat wajib pada aspek ${dimensionLabel(hardViolated[1].toLowerCase())} tidak terpenuhi oleh kondisi lahan saat ini.`;
  }

  const hardMissing =
    /^a hard (climate|water|soil|timing|risk) constraint has no observation$/i.exec(text);
  if (hardMissing?.[1] !== undefined) {
    return `Syarat wajib pada aspek ${dimensionLabel(hardMissing[1].toLowerCase())} belum memiliki data pengukuran.`;
  }

  const hardGate = /^the profile hard-gates (climate|water|soil|timing|risk) and .*$/i.exec(text);
  if (hardGate?.[1] !== undefined) {
    return `Syarat wajib pada aspek ${dimensionLabel(hardGate[1].toLowerCase())} belum dapat dinilai karena datanya belum tersedia.`;
  }

  const softViolated =
    /^(\d+) soft (climate|water|soil|timing|risk) constraint\(s\) were violated$/i.exec(text);
  if (softViolated?.[1] !== undefined && softViolated[2] !== undefined) {
    return `Ada ${softViolated[1]} anjuran pada aspek ${dimensionLabel(softViolated[2].toLowerCase())} yang berada di luar batas ideal.`;
  }

  const match =
    /^(climate|water|soil|timing|risk) is judged by the rulebook but was not observed$/i.exec(text);
  if (match?.[1] !== undefined) {
    return `Data pada aspek ${dimensionLabel(match[1].toLowerCase())} belum tersedia untuk dinilai pada evaluasi ini.`;
  }
  return detail;
}

export function comparatorLabel(comparator: string): string {
  switch (comparator) {
    case "min":
      return "Minimal";
    case "max":
      return "Maksimal";
    case "range":
      return "Rentang ideal";
    case "count":
      return "Jumlah kejadian";
    default:
      return comparator;
  }
}

export function severityLabel(severity: string): string {
  switch (severity) {
    case "hard":
      return "Syarat wajib";
    case "soft":
      return "Anjuran";
    case "high":
      return "Risiko tinggi";
    case "warning":
      return "Perlu perhatian";
    case "info":
      return "Informasi";
    default:
      return severity;
  }
}

export function gradeLabel(grade: string): string {
  switch (grade) {
    case "A":
      return "Rujukan utama (A)";
    case "B":
      return "Rujukan pendukung (B)";
    default:
      return `Tingkat ${grade}`;
  }
}

export function cropCategoryLabel(category: string): string {
  switch (category.toLowerCase()) {
    case "cereal":
    case "grain":
      return "Tanaman pangan & biji-bijian";
    case "vegetable":
    case "horticulture":
      return "Sayuran & hortikultura";
    case "legume":
    case "pulse":
      return "Kacang-kacangan";
    case "fruit":
      return "Buah-buahan";
    case "root":
    case "tuber":
      return "Umbi-umbian";
    case "plantation":
      return "Tanaman perkebunan";
    case "spice":
      return "Rempah-rempah";
    default:
      return category;
  }
}

export function suitabilityLabel(verdict: string): string {
  switch (verdict) {
    case "suitable":
      return "Sesuai";
    case "conditional":
      return "Sesuai bersyarat";
    case "unsuitable":
      return "Kurang sesuai";
    case "insufficient_data":
      return "Data belum cukup";
    default:
      return verdict;
  }
}

export function suitabilityTone(verdict: string): Tone {
  switch (verdict) {
    case "suitable":
      return "accent";
    case "conditional":
      return "warn";
    case "unsuitable":
      return "danger";
    default:
      return "neutral";
  }
}

export function plantingStatusLabel(status: string): string {
  switch (status) {
    case "active":
      return "Sedang berjalan";
    case "harvested":
      return "Selesai panen";
    case "failed":
      return "Gagal tanam";
    case "abandoned":
      return "Dihentikan";
    default:
      return status;
  }
}

export function plantingStatusTone(status: string): Tone {
  switch (status) {
    case "active":
      return "accent";
    case "harvested":
      return "neutral";
    case "failed":
    case "abandoned":
      return "danger";
    default:
      return "neutral";
  }
}

export function irrigationLabel(value: string): string {
  switch (value) {
    case "irrigated":
      return "Beririgasi penuh";
    case "partial_irrigation":
      return "Irigasi sebagian (parsial)";
    case "rainfed":
      return "Tadah hujan";
    case "unknown":
      return "Belum diketahui";
    default:
      return value;
  }
}

export function observationKindLabel(kind: string): string {
  switch (kind) {
    case "rainfall":
      return "Curah hujan";
    case "soil_moisture":
      return "Kelembapan tanah";
    case "temperature":
      return "Suhu udara/tanah";
    case "note":
      return "Catatan lapangan";
    default:
      return kind;
  }
}

export function soilTypeLabel(value: string): string {
  switch (value) {
    case "clay":
      return "Tanah liat";
    case "loam":
      return "Tanah lempung";
    case "sandy":
      return "Tanah berpasir";
    case "clay_loam":
      return "Lempung berliat";
    case "sandy_loam":
      return "Lempung berpasir";
    case "silt_loam":
      return "Lempung berdebu";
    case "peat":
      return "Tanah gambut";
    case "alluvial":
      return "Tanah aluvial";
    case "volcanic":
      return "Tanah vulkanik";
    case "unknown":
      return "Belum diketahui";
    default:
      return value;
  }
}

export function drainageClassLabel(value: string): string {
  switch (value) {
    case "poor":
      return "Buruk (mudah tergenang)";
    case "moderate":
      return "Sedang";
    case "well":
      return "Baik (air mengalir lancar)";
    case "excessive":
      return "Terlalu cepat kering";
    case "unknown":
      return "Belum diketahui";
    default:
      return value;
  }
}
