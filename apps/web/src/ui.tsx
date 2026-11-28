import type { ReactNode } from "react";

import { ApiError, describeError } from "./api.js";

/** A quoted value in the ledger's voice: monospaced, never a link. */
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
  readonly tone?: "info" | "warn" | "error" | undefined;
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

export function Loading({ label = "Memuat…" }: { readonly label?: string }) {
  return (
    <p className="loading" role="status">
      {label}
    </p>
  );
}

export function Empty({ children }: { readonly children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

/** Every fetch in the app reports through here, so a new screen cannot invent wording. */
export function ErrorNotice({
  error,
  note,
}: {
  readonly error: unknown;
  /** What this failure does *not* mean, when the default reading would be wrong. */
  readonly note?: string;
}) {
  return (
    <Notice tone="error">
      <span>{describeError(error)}</span>
      {note ? <span className="faint"> · {note}</span> : null}
      {error instanceof ApiError && error.requestId !== undefined ? (
        <span className="faint"> · {error.requestId}</span>
      ) : null}
    </Notice>
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

/** `2026-11-01` → `November 2026`. The stored value is always a first-of-month. */
export function monthLabel(isoDate: string): string {
  const [year, month] = isoDate.split("-");
  if (year === undefined || month === undefined) return isoDate;
  return `${MONTHS[Number(month) - 1] ?? month} ${year}`;
}

/** `2026-11-27` → `27 Nov`. Compact, still unambiguous within one horizon. */
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
      return "Prakiraan harian";
    case "subseasonal_forecast":
      return "Prakiraan subseasonal";
    case "seasonal_forecast":
      return "Prakiraan musiman";
    case "climatology":
      return "Normal iklim";
    case "field_observation":
      return "Pengamatan lahan";
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
      return "Belum tersedia";
    case "provider_null":
      return "Provider tidak menerbitkan nilai";
    case "not_requested":
      return "Tidak diminta";
    case "beyond_horizon":
      return "Di luar horizon";
    case "insufficient_history":
      return "Riwayat kurang";
    case "insufficient_provenance":
      return "Provenans kurang";
    default:
      return reason;
  }
}

export function suitabilityLabel(verdict: string): string {
  switch (verdict) {
    case "suitable":
      return "Sesuai";
    case "conditional":
      return "Bersyarat";
    case "unsuitable":
      return "Tidak sesuai";
    case "insufficient_data":
      return "Data tidak cukup";
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
      return "Aktif";
    case "harvested":
      return "Dipanen";
    case "failed":
      return "Gagal";
    case "abandoned":
      return "Ditinggalkan";
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
      return "Irigasi parsial";
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
      return "Suhu";
    case "note":
      return "Catatan lapangan";
    default:
      return kind;
  }
}
