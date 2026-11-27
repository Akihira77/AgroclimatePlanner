import type { ClimateDailyOutlook, ClimateOutlook } from "@agroclimate/contracts";
import { useState } from "react";

import { api } from "../api.js";
import { Link } from "../router.js";
import {
  ErrorNotice,
  Empty,
  Loading,
  Mono,
  Notice,
  Tag,
  dataClassLabel,
  dayLabel,
  millimetres,
  missingReasonLabel,
  monthLabel,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

/** The only grid production binds today; a real provider is `OPEN-18`. */
const SYNTHETIC_PROVIDER = "synthetic";
const SYNTHETIC_MODEL = "synthetic_1deg_20x20";

type Basis = "monthly" | "daily";

/**
 * The climate read, both horizons.
 *
 * The grid identity is typed by the caller, not derived from the field: the
 * field → cell mapping has no writer (`OPEN-18`), so this screen asks for the pair
 * and shows the failure the resolver returns rather than guessing one.
 *
 * Every value is labelled with its data class. A number without its class would be
 * the exact confusion the contract exists to prevent: a climatology normal and a
 * seasonal forecast are not the same claim.
 */
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

  if (fields.loading) return <Loading />;
  if (fields.error !== null) return <ErrorNotice error={fields.error} />;
  if (fields.data === null) return null;

  const available = fields.data;
  const selected = available.find((field) => field.id === fieldId) ?? available[0];

  return (
    <div className="stack">
      <div className="stack-tight">
        <p className="lede">
          Horizon bulanan materialisasi bulan 1–12, dan horizon harian 0–45 yang membaca baris cuaca
          langsung. Keduanya menampilkan kelas data tiap nilai.
        </p>
        <Notice tone="warn">
          Grid produksi belum divalidasi (<Mono>OPEN-18</Mono>). Pasangan{" "}
          <Mono>{`${SYNTHETIC_PROVIDER}/${SYNTHETIC_MODEL}`}</Mono> adalah grid sintetis untuk
          pengujian; provider nyata akan menjawab <Mono>GRID_NOT_FOUND</Mono>.
        </Notice>
      </div>

      {available.length === 0 ? (
        <Empty>
          Belum ada lahan. <Link to="/lahan">Buat lahan</Link> lalu hitung titik pusatnya menjadi
          sel grid.
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
            <div className="panel-body form-grid">
              <div className="field">
                <label htmlFor="climate-field">Lahan</label>
                <select
                  id="climate-field"
                  value={selected?.id ?? ""}
                  onChange={(event) => setFieldId(event.target.value)}
                >
                  {available.map((field) => (
                    <option key={field.id} value={field.id}>
                      {field.name}
                    </option>
                  ))}
                </select>
              </div>
              <div className="field">
                <label htmlFor="climate-provider">Provider</label>
                <input
                  id="climate-provider"
                  required
                  value={provider}
                  onChange={(event) => setProvider(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="climate-model">Model</label>
                <input
                  id="climate-model"
                  required
                  value={model}
                  onChange={(event) => setModel(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor="climate-basis">Horizon</label>
                <select
                  id="climate-basis"
                  value={basis}
                  onChange={(event) =>
                    setBasis(event.target.value === "daily" ? "daily" : "monthly")
                  }
                >
                  <option value="monthly">12 bulan</option>
                  <option value="daily">0–45 hari</option>
                </select>
              </div>
              <div className="form-actions">
                <button className="btn btn-primary" type="submit">
                  Tampilkan
                </button>
              </div>
            </div>
          </form>

          {request === null ? (
            <Empty>Pilih lahan dan horizon, lalu tampilkan.</Empty>
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

  if (state.loading) return <Loading label="Membaca horizon bulanan…" />;
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
          {present} dari 12 bulan bernilai · satuan {outlook.unit}
        </span>
      </div>

      <div className="month-list">
        {outlook.months.map((month) => (
          <div className="month-row" key={month.month}>
            <span className="month">{monthLabel(month.month)}</span>
            <span className="meta">
              {month.dataClass === null ? (
                <Tag>
                  {month.missingReason === null
                    ? "kosong"
                    : missingReasonLabel(month.missingReason)}
                </Tag>
              ) : (
                <>
                  <Tag tone={month.dataClass === "climatology" ? undefined : "accent"}>
                    {dataClassLabel(month.dataClass)}
                  </Tag>
                  {month.availability !== null ? (
                    <Tag tone={month.availability === "stale" ? "warn" : undefined}>
                      {month.availability === "fresh" ? "segar" : "basi"}
                    </Tag>
                  ) : null}
                  {month.baselineVersion !== null ? (
                    <Tag>baseline {month.baselineVersion}</Tag>
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

      <p className="faint">
        Bulan tanpa baris tidak diisi dari bulan sebelahnya. Nilai normal iklim dan prakiraan
        musiman berbeda kelas dan tidak boleh dibaca sebagai satu rangkaian yang setara.
      </p>
    </section>
  );
}

function DailyView({ request }: { readonly request: ReadRequest }) {
  const state = useAsync(`forecast:${request.fieldId}:${request.provider}:${request.model}`, () =>
    api.forecast(request.fieldId, request.provider, request.model),
  );

  if (state.loading) return <Loading label="Membaca horizon 0–45 hari…" />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  return <DailySegments forecast={state.data} />;
}

function DailySegments({ forecast }: { readonly forecast: ClimateDailyOutlook }) {
  return (
    <section className="stack">
      <h2>{`Hari 0 dimulai ${forecast.firstDate}`}</h2>

      {forecast.segments.map((segment) => {
        const present = segment.days.filter((day) => day.valueMm !== null).length;
        const stale = segment.days.filter((day) => day.availability === "stale").length;

        return (
          <div key={segment.band} className="stack-tight">
            <div className="segment-head">
              <h3>
                {segment.band === "daily" ? "Harian (0–14)" : "Subseasonal (15–45)"} ·{" "}
                <span className="muted">{dataClassLabel(segment.dataClass)}</span>
              </h3>
              <span className="muted numeric">
                {present}/{segment.days.length} hari bernilai
                {stale > 0 ? ` · ${stale} basi` : ""}
              </span>
            </div>

            <div className="day-grid">
              {segment.days.map((day) => (
                <div
                  className="day-cell"
                  key={day.date}
                  data-empty={day.valueMm === null ? "true" : undefined}
                  title={
                    day.availability === null
                      ? undefined
                      : `TTL ${day.staleAfterHours} jam · ${day.availability}`
                  }
                >
                  <span className="date">{dayLabel(day.date)}</span>
                  <span className="amount">
                    {day.valueMm === null ? "—" : millimetres(day.valueMm)}
                  </span>
                  {day.valueMm === null ? (
                    <Tag>
                      {day.missingReason === null
                        ? "kosong"
                        : missingReasonLabel(day.missingReason)}
                    </Tag>
                  ) : (
                    <span className="row">
                      <Tag tone={day.availability === "stale" ? "warn" : "accent"}>
                        {day.availability === "stale" ? "basi" : "segar"}
                      </Tag>
                      {day.model !== null ? <span className="faint">{day.model}</span> : null}
                    </span>
                  )}
                </div>
              ))}
            </div>
          </div>
        );
      })}

      <p className="faint">
        Tiap hari membawa model, waktu inisialisasi, dan kesegarannya sendiri: satu horizon 45 hari
        bisa memuat lebih dari satu run. Hari tanpa baris bukan nol.
      </p>
    </section>
  );
}
