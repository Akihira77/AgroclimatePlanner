import { classifySeasonalRegimes, type SeasonCategory } from "@agroclimate/climate-core/seasons";
import type { ClimateDailyOutlook, ClimateOutlook } from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { CustomSelect } from "../components/CustomSelect.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  FieldLabel,
  Loading,
  Notice,
  PageGuide,
  Tag,
  availabilityLabel,
  dataClassLabel,
  dayLabel,
  millimetres,
  missingReasonLabel,
  monthLabel,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

const DEFAULT_PROVIDER = "open-meteo";
const DEFAULT_MODEL = "ecmwf_ifs025";

type Basis = "monthly" | "daily";

export function ClimatePage() {
  const fields = useAsync("climate-fields", () => api.listFields());

  const [fieldId, setFieldId] = useState("");
  const [provider, setProvider] = useState(DEFAULT_PROVIDER);
  const [model, setModel] = useState(DEFAULT_MODEL);
  const [basis, setBasis] = useState<Basis>("monthly");
  const [request, setRequest] = useState<{
    fieldId: string;
    provider: string;
    model: string;
  } | null>(null);

  const available = fields.data ?? [];
  const selected = available.find((field) => field.id === fieldId) ?? available[0];

  useEffect(() => {
    if (request === null && selected !== undefined) {
      setRequest({ fieldId: selected.id, provider: DEFAULT_PROVIDER, model: DEFAULT_MODEL });
    }
  }, [request, selected]);

  if (fields.loading) return <Loading />;
  if (fields.error !== null) return <ErrorNotice error={fields.error} />;
  if (fields.data === null) return null;

  return (
    <div className="stack">
      <PageGuide
        storageKey="climate"
        title="Panduan Membaca Data Cuaca & Iklim"
        summary="Pantau perkiraan curah hujan 12 bulan ke depan dan prakiraan harian 0–45 hari untuk lokasi lahan Anda."
        steps={[
          {
            title: "Ringkasan 12 Bulan",
            detail:
              "Menampilkan gambaran curah hujan per bulan. Warna hijau berarti prakiraan musiman, kuning berarti rata-rata iklim historis.",
          },
          {
            title: "Prakiraan 0–45 Hari",
            detail:
              "Menampilkan prakiraan curah hujan harian (hari 0–14) dan jangka menengah (hari 15–45).",
          },
          {
            title: "Arti Kolom Kosong",
            detail:
              "Kotak abu-abu putus-putus berarti data belum tersedia — bukan berarti curah hujan 0 mm.",
          },
        ]}
      />

      <Notice tone="info">
        <span>
          <strong>Info Sumber Data:</strong> Grafik di bawah menggunakan grid{" "}
          <code>open-meteo / ecmwf_ifs025</code> &amp; <code>era5</code> (tervalidasi empiris{" "}
          <code>OPEN-18</code>, penggunaan pribadi / non-komersial CC BY 4.0).
        </span>
      </Notice>

      {available.length === 0 ? (
        <Empty>
          <p>Belum ada lahan yang tercatat.</p>
          <Link className="btn btn-primary" to="/lahan">
            Buat lahan pertama Anda
          </Link>
        </Empty>
      ) : (
        <>
          <form
            className="panel"
            onSubmit={(event) => {
              event.preventDefault();
              if (selected === undefined) return;
              setRequest({ fieldId: selected.id, provider: provider.trim(), model: model.trim() });
            }}
          >
            <div className="panel-body stack">
              <div className="climate-filter-bar">
                <div className="field climate-filter-field">
                  <FieldLabel htmlFor="climate-field" label="Pilih Lahan" />
                  <CustomSelect
                    id="climate-field"
                    value={selected?.id ?? ""}
                    onChange={(nextId) => {
                      setFieldId(nextId);
                      setRequest({
                        fieldId: nextId,
                        provider: provider.trim(),
                        model: model.trim(),
                      });
                    }}
                    options={available.map((field) => ({
                      value: field.id,
                      label: `${field.name} · ${field.areaHa.toFixed(2)} ha`,
                    }))}
                  />
                </div>

                <div className="field climate-filter-tabs">
                  <label>Rentang Waktu</label>
                  <div className="tabs" role="tablist" aria-label="Pilih rentang waktu iklim">
                    <button
                      type="button"
                      role="tab"
                      aria-selected={basis === "monthly"}
                      className={`tab-btn${basis === "monthly" ? " is-active" : ""}`}
                      onClick={() => setBasis("monthly")}
                    >
                      Ringkasan 12 Bulan
                    </button>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={basis === "daily"}
                      className={`tab-btn${basis === "daily" ? " is-active" : ""}`}
                      onClick={() => setBasis("daily")}
                    >
                      Prakiraan 0–45 Hari
                    </button>
                  </div>
                </div>

                <div className="climate-filter-actions">
                  <button className="btn btn-primary" type="submit">
                    Muat Ulang Data
                  </button>
                </div>
              </div>

              <details className="tech-details">
                <summary>Pengaturan sumber data lanjutan</summary>
                <div className="form-grid">
                  <div className="field">
                    <label htmlFor="climate-provider">Penyedia Data</label>
                    <input
                      id="climate-provider"
                      required
                      value={provider}
                      onChange={(event) => setProvider(event.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label htmlFor="climate-model">Model Cuaca</label>
                    <input
                      id="climate-model"
                      required
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                    />
                  </div>
                </div>
              </details>
            </div>
          </form>

          {request === null ? (
            <Empty>Pilih lahan dan rentang waktu, lalu klik Muat Ulang Data.</Empty>
          ) : basis === "monthly" ? (
            <MonthlyView
              key={`${request.fieldId}:${request.provider}:${request.model}`}
              request={request}
            />
          ) : (
            <DailyView
              key={`${request.fieldId}:${request.provider}:${request.model}`}
              request={request}
            />
          )}
        </>
      )}

      <footer className="climate-attribution" aria-label="Atribusi sumber data cuaca">
        <span>
          <a href="https://open-meteo.com/" target="_blank" rel="noreferrer">
            Weather data by Open-Meteo.com (CC BY 4.0)
          </a>
        </span>
        <span>
          Based on data and products of the European Centre for Medium-Range Weather Forecasts
          (ECMWF)
        </span>
        <span>Contains modified Copernicus Climate Change Service information 2026 (ERA5)</span>
      </footer>
    </div>
  );
}

interface ReadRequest {
  readonly fieldId: string;
  readonly provider: string;
  readonly model: string;
}

function MonthlyView({ request }: { readonly request: ReadRequest }) {
  const state = useAsync(`outlook:${request.fieldId}:${request.provider}:${request.model}`, () =>
    api.outlook(request.fieldId, request.provider, request.model),
  );

  if (state.loading) return <Loading label="Memuat ringkasan curah hujan 12 bulan…" />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  return <MonthlyTable outlook={state.data} />;
}

function MonthlyTable({ outlook }: { readonly outlook: ClimateOutlook }) {
  const present = outlook.months.filter((month) => month.valueMm !== null).length;
  const regimes = classifySeasonalRegimes(
    outlook.months.map((m) => ({
      month: m.month,
      valueMm: m.valueMm,
      dataClass: m.dataClass,
    })),
  );
  const baselines = Array.from(
    new Set(
      outlook.months
        .map((m) => m.baselineVersion)
        .filter((b): b is string => b !== null && b.length > 0),
    ),
  );

  const seasonTone = (cat: SeasonCategory): "accent" | "warn" | undefined => {
    if (cat === "wet") return "accent";
    if (cat === "dry") return "warn";
    return undefined;
  };

  return (
    <section className="stack">
      <div className="spread">
        <h2>{`Mulai ${monthLabel(outlook.firstMonth)}`}</h2>
        <span className="muted">
          {present} dari 12 bulan terisi · satuan {outlook.unit}
        </span>
      </div>

      <MonthlyRainfallChart outlook={outlook} />

      <div className="panel">
        <div className="panel-head spread" style={{ flexWrap: "wrap", gap: 8 }}>
          <div>
            <h3 style={{ margin: 0 }}>Himbauan Pola Musim 12 Bulan</h3>
            <p className="muted" style={{ margin: "2px 0 0", fontSize: "0.86rem" }}>
              Pengelompokan bulan basah (&gt;200 mm), peralihan (100–200 mm), dan kering (&lt;100 mm).
            </p>
          </div>
          <Tag tone="accent">Himbauan indikatif • Gabungan prakiraan musiman &amp; rata-rata historis</Tag>
        </div>
        <div className="panel-body">
          <div className="season-regime-grid">
            {regimes.map((reg) => {
              const rangeLabel =
                reg.startMonth === reg.endMonth
                  ? monthLabel(reg.startMonth)
                  : `${shortMonthLabel(reg.startMonth)} ${reg.startMonth.slice(0, 4)} – ${shortMonthLabel(reg.endMonth)} ${reg.endMonth.slice(0, 4)}`;
              const mmRange =
                reg.minMm === null || reg.maxMm === null
                  ? "Data belum tersedia"
                  : reg.minMm === reg.maxMm
                    ? `${reg.minMm} mm/bln`
                    : `${reg.minMm}–${reg.maxMm} mm/bln`;

              return (
                <div
                  className="season-regime-card"
                  data-category={reg.category}
                  key={`${reg.startMonth}:${reg.category}`}
                >
                  <div className="spread" style={{ gap: 8 }}>
                    <strong>{rangeLabel}</strong>
                    <Tag tone={seasonTone(reg.category)}>{reg.labelId}</Tag>
                  </div>
                  <div className="muted numeric" style={{ fontSize: "0.85rem", marginTop: 4 }}>
                    {mmRange} ({reg.monthCount} bln)
                  </div>
                  <p style={{ margin: "8px 0 0", fontSize: "0.88rem" }}>{reg.guidanceId}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      <details className="tech-details">
        <summary>Lihat rincian angka per bulan &amp; sumber data</summary>
        <div className="stack" style={{ marginTop: "var(--space-2)" }}>
          {baselines.length > 0 ? (
            <p className="faint" style={{ margin: 0 }}>
              Acuan rata-rata iklim historis: <strong>{baselines.join(", ")}</strong>
            </p>
          ) : null}

          <div className="month-list">
            {outlook.months.map((month) => (
              <div className="month-row" key={month.month}>
                <span className="month">{monthLabel(month.month)}</span>
                <span className="meta">
                  {month.dataClass === null ? (
                    <Tag>
                      {month.missingReason === null
                        ? "Data kosong"
                        : missingReasonLabel(month.missingReason)}
                    </Tag>
                  ) : (
                    <>
                      <Tag tone={month.dataClass === "climatology" ? "warn" : "accent"}>
                        {dataClassLabel(month.dataClass)}
                      </Tag>
                      {month.availability !== null ? (
                        <Tag tone={month.availability === "stale" ? "warn" : undefined}>
                          {availabilityLabel(month.availability)}
                        </Tag>
                      ) : null}
                    </>
                  )}
                </span>
                <span className="value">
                  {month.valueMm === null ? (
                    <span className="faint">—</span>
                  ) : (
                    millimetres(month.valueMm)
                  )}
                </span>
              </div>
            ))}
          </div>

          <p className="faint" style={{ margin: 0 }}>
            Catatan: Nilai rata-rata iklim historis dan prakiraan musiman memiliki tingkat kepastian
            yang berbeda dan ditampilkan terpisah agar mudah dibandingkan.
          </p>
        </div>
      </details>
    </section>
  );
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

function shortMonthLabel(isoMonth: string): string {
  const m = Number(isoMonth.slice(5, 7));
  if (m >= 1 && m <= 12) return SHORT_MONTHS_ID[m - 1] ?? isoMonth.slice(5, 7);
  return isoMonth.slice(5, 7);
}

function MonthlyRainfallChart({ outlook }: { readonly outlook: ClimateOutlook }) {
  const values = outlook.months.map((m) => m.valueMm).filter((v): v is number => v !== null);
  const maxVal = Math.max(10, ...values);
  const totalMm = values.reduce((sum, v) => sum + v, 0);
  const avgMm = values.length > 0 ? totalMm / values.length : null;
  const wettest = outlook.months.reduce<(typeof outlook.months)[number] | null>(
    (best, cur) =>
      cur.valueMm !== null && (best === null || (best.valueMm ?? -1) < cur.valueMm) ? cur : best,
    null,
  );

  const width = 640;
  const height = 200;
  const padBottom = 28;
  const padTop = 26;
  const plotHeight = height - padTop - padBottom;
  const slotWidth = width / outlook.months.length;

  return (
    <div className="chart-card">
      <div className="soil-gauges" style={{ marginBottom: "var(--space-2)" }}>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Bulan Terbasah</span>
          <strong>
            {wettest !== null && wettest.valueMm !== null
              ? `${shortMonthLabel(wettest.month)} (${millimetres(wettest.valueMm)})`
              : "Belum tersedia"}
          </strong>
        </div>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Rata-rata / Bulan</span>
          <strong>{avgMm !== null ? millimetres(Math.round(avgMm)) : "Belum tersedia"}</strong>
        </div>
        <div className="soil-gauge-tile">
          <span className="soil-gauge-k">Total Bulan Terisi</span>
          <strong>
            {values.length > 0
              ? `${millimetres(Math.round(totalMm))} (${values.length} bln)`
              : "0 bln"}
          </strong>
        </div>
      </div>

      <div className="chart-legend" aria-label="Legenda grafik bulanan">
        <span className="legend-item">
          <span className="legend-swatch" data-kind="forecast" /> Prakiraan musiman
        </span>
        <span className="legend-item">
          <span className="legend-swatch" data-kind="climatology" /> Rata-rata iklim historis
        </span>
        <span className="legend-item">
          <span className="legend-swatch" data-kind="missing" /> Data belum tersedia (bukan nol)
        </span>
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label="Grafik curah hujan bulanan 12 bulan"
      >
        <line
          x1="8"
          y1={padTop + plotHeight / 2}
          x2={width - 8}
          y2={padTop + plotHeight / 2}
          stroke="var(--line)"
          strokeDasharray="4 4"
          strokeWidth="1"
        />
        <line
          x1="8"
          y1={padTop + plotHeight}
          x2={width - 8}
          y2={padTop + plotHeight}
          stroke="var(--line-strong)"
          strokeWidth="1"
        />
        {outlook.months.map((m, idx) => {
          const x = idx * slotWidth + 8;
          const barWidth = Math.max(12, slotWidth - 16);
          const label = shortMonthLabel(m.month);
          if (m.valueMm === null) {
            return (
              <g key={m.month}>
                <rect
                  x={x}
                  y={padTop}
                  width={barWidth}
                  height={plotHeight}
                  fill="var(--surface-muted)"
                  stroke="var(--line-strong)"
                  strokeDasharray="3 3"
                  rx={3}
                >
                  <title>{`${monthLabel(m.month)}: data belum tersedia`}</title>
                </rect>
                <text
                  x={x + barWidth / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize="11"
                  fill="var(--ink-faint)"
                >
                  {label}
                </text>
              </g>
            );
          }
          const barH = Math.max(3, (m.valueMm / maxVal) * plotHeight);
          const y = padTop + plotHeight - barH;
          const fill = m.dataClass === "climatology" ? "var(--warn)" : "var(--accent)";
          return (
            <g key={m.month}>
              <rect x={x} y={y} width={barWidth} height={barH} fill={fill} rx={4}>
                <title>{`${monthLabel(m.month)}: ${millimetres(m.valueMm)} (${dataClassLabel(m.dataClass ?? "")})`}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={y - 5}
                textAnchor="middle"
                fontSize="10"
                fontWeight="700"
                fill="var(--ink)"
              >
                {Math.round(m.valueMm)}
              </text>
              <text
                x={x + barWidth / 2}
                y={height - 8}
                textAnchor="middle"
                fontSize="11"
                fill="var(--ink-muted)"
              >
                {label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function DailyView({ request }: { readonly request: ReadRequest }) {
  const state = useAsync(`forecast:${request.fieldId}:${request.provider}:${request.model}`, () =>
    api.forecast(request.fieldId, request.provider, request.model),
  );

  if (state.loading) return <Loading label="Memuat prakiraan 0–45 hari…" />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  return <DailySegments forecast={state.data} />;
}

function DailySegments({ forecast }: { readonly forecast: ClimateDailyOutlook }) {
  return (
    <section className="stack">
      <h2>{`Prakiraan Mulai ${forecast.firstDate}`}</h2>

      {forecast.segments.map((segment) => {
        const present = segment.days.filter((day) => day.valueMm !== null).length;
        const stale = segment.days.filter((day) => day.availability === "stale").length;

        return (
          <div key={segment.band} className="stack-tight">
            <div className="segment-head">
              <h3>
                {segment.band === "daily" ? "Harian (Hari 0–14)" : "Jangka Menengah (Hari 15–45)"} ·{" "}
                <span className="muted">{dataClassLabel(segment.dataClass)}</span>
              </h3>
              <span className="muted numeric">
                {present}/{segment.days.length} hari terisi
                {stale > 0 ? ` · ${stale} perlu diperbarui` : ""}
              </span>
            </div>

            <DailyRainfallChart segment={segment} />

            <div className="day-grid">
              {segment.days.map((day) => (
                <div
                  className="day-cell"
                  key={day.date}
                  data-empty={day.valueMm === null ? "true" : undefined}
                  title={
                    day.availability === null
                      ? undefined
                      : `Masa berlaku ${day.staleAfterHours} jam · ${availabilityLabel(day.availability)}`
                  }
                >
                  <span className="date">{dayLabel(day.date)}</span>
                  <span className="amount">
                    {day.valueMm === null ? "—" : millimetres(day.valueMm)}
                  </span>
                  {day.valueMm === null ? (
                    <Tag>
                      {day.missingReason === null
                        ? "Kosong"
                        : missingReasonLabel(day.missingReason)}
                    </Tag>
                  ) : (
                    <span className="row">
                      <Tag tone={day.availability === "stale" ? "warn" : "accent"}>
                        {availabilityLabel(day.availability ?? "fresh")}
                      </Tag>
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <p className="faint">
        Setiap kotak menampilkan perkiraan curah hujan harian beserta status pembaruannya. Hari yang
        kosong menandakan data tidak tersedia, bukan berarti 0 mm.
      </p>
    </section>
  );
}

function DailyRainfallChart({
  segment,
}: {
  readonly segment: ClimateDailyOutlook["segments"][number];
}) {
  const values = segment.days.map((d) => d.valueMm).filter((v): v is number => v !== null);
  const maxVal = Math.max(5, ...values);
  const width = 640;
  const height = 110;
  const padBottom = 18;
  const padTop = 8;
  const plotHeight = height - padTop - padBottom;
  const slotWidth = width / Math.max(1, segment.days.length);
  const fill = segment.dataClass === "climatology" ? "var(--warn)" : "var(--accent)";

  return (
    <div className="chart-card">
      <div className="spread" style={{ marginBottom: "4px", fontSize: "0.78rem" }}>
        <span className="muted">Puncak harian: {millimetres(Math.round(maxVal))}</span>
        <span className="muted">{segment.days.length} hari</span>
      </div>
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Grafik curah hujan ${segment.band === "daily" ? "harian" : "jangka menengah"}`}
      >
        <line
          x1="2"
          y1={padTop + plotHeight}
          x2={width - 2}
          y2={padTop + plotHeight}
          stroke="var(--line-strong)"
          strokeWidth="1"
        />
        {segment.days.map((d, idx) => {
          const x = idx * slotWidth + 2;
          const barWidth = Math.max(3, slotWidth - 4);
          if (d.valueMm === null) {
            return (
              <rect
                key={d.date}
                x={x}
                y={padTop}
                width={barWidth}
                height={plotHeight}
                fill="var(--surface-muted)"
                stroke="var(--line-strong)"
                strokeDasharray="2 2"
                rx={1}
              >
                <title>{`${dayLabel(d.date)}: data belum tersedia`}</title>
              </rect>
            );
          }
          const barH = Math.max(2, (d.valueMm / maxVal) * plotHeight);
          const y = padTop + plotHeight - barH;
          return (
            <rect key={d.date} x={x} y={y} width={barWidth} height={barH} fill={fill} rx={1}>
              <title>{`${dayLabel(d.date)}: ${millimetres(d.valueMm)}`}</title>
            </rect>
          );
        })}
      </svg>
    </div>
  );
}
