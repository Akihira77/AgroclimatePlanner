import type { ClimateDailyOutlook, ClimateOutlook } from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api } from "../api.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
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

const SYNTHETIC_PROVIDER = "synthetic";
const SYNTHETIC_MODEL = "synthetic_1deg_20x20";

type Basis = "monthly" | "daily";

export function ClimatePage() {
  const fields = useAsync("climate-fields", () => api.listFields());

  const [fieldId, setFieldId] = useState("");
  const [provider, setProvider] = useState(SYNTHETIC_PROVIDER);
  const [model, setModel] = useState(SYNTHETIC_MODEL);
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
      setRequest({ fieldId: selected.id, provider: SYNTHETIC_PROVIDER, model: SYNTHETIC_MODEL });
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
          <strong>Info Sumber Data:</strong> Grafik di bawah menggunakan data cuaca simulasi bawaan
          agar Anda dapat langsung menguji perencanaan lahan.
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
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="climate-field">Pilih Lahan</label>
                  <select
                    id="climate-field"
                    value={selected?.id ?? ""}
                    onChange={(event) => {
                      const nextId = event.target.value;
                      setFieldId(nextId);
                      setRequest({
                        fieldId: nextId,
                        provider: provider.trim(),
                        model: model.trim(),
                      });
                    }}
                  >
                    {available.map((field) => (
                      <option key={field.id} value={field.id}>
                        {field.name} · {field.areaHa.toFixed(2)} ha
                      </option>
                    ))}
                  </select>
                </div>

                <div className="field">
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

                <div className="form-actions">
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

  return (
    <section className="stack">
      <div className="spread">
        <h2>{`Mulai ${monthLabel(outlook.firstMonth)}`}</h2>
        <span className="muted">
          {present} dari 12 bulan terisi · satuan {outlook.unit}
        </span>
      </div>

      <MonthlyRainfallChart outlook={outlook} />

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
                  {month.baselineVersion !== null ? <Tag>Acuan {month.baselineVersion}</Tag> : null}
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

      <p className="faint">
        Catatan: Nilai rata-rata iklim historis dan prakiraan musiman memiliki tingkat kepastian
        yang berbeda dan ditampilkan terpisah agar mudah dibandingkan.
      </p>
    </section>
  );
}

function MonthlyRainfallChart({ outlook }: { readonly outlook: ClimateOutlook }) {
  const values = outlook.months.map((m) => m.valueMm).filter((v): v is number => v !== null);
  const maxVal = Math.max(10, ...values);
  const width = 640;
  const height = 180;
  const padBottom = 28;
  const padTop = 16;
  const plotHeight = height - padTop - padBottom;
  const slotWidth = width / outlook.months.length;

  return (
    <div className="chart-card">
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
        {outlook.months.map((m, idx) => {
          const x = idx * slotWidth + 8;
          const barWidth = Math.max(12, slotWidth - 16);
          const label = m.month.slice(5, 7);
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
          const barH = Math.max(2, (m.valueMm / maxVal) * plotHeight);
          const y = padTop + plotHeight - barH;
          const fill = m.dataClass === "climatology" ? "var(--warn)" : "var(--accent)";
          return (
            <g key={m.month}>
              <rect x={x} y={y} width={barWidth} height={barH} fill={fill} rx={3}>
                <title>{`${monthLabel(m.month)}: ${millimetres(m.valueMm)} (${dataClassLabel(m.dataClass ?? "")})`}</title>
              </rect>
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
      <svg
        className="chart-svg"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={`Grafik curah hujan ${segment.band === "daily" ? "harian" : "jangka menengah"}`}
      >
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
