import type {
  AiBriefing,
  CropCycle,
  IrrigationAvailability,
  Planting,
  PlantingWindow,
  SingleValueEvaluationBasis,
  SuitabilityRunWithWindows,
  SuitabilityVerdict,
} from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { ApiError, api } from "../api.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  Loading,
  Mono,
  Notice,
  Tag,
  dataClassLabel,
  irrigationLabel,
  monthLabel,
  plantingStatusLabel,
  plantingStatusTone,
  suitabilityLabel,
  suitabilityTone,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

const BASELINE_HASH_PLACEHOLDER = "0".repeat(64);

/**
 * Phase 7.5, 7.6 & 7.8: suitability evaluation, planting calendar & opportunities,
 * grounded AI briefing, and deterministic rulebook cycle projection.
 */
export function PlanPage() {
  const state = useAsync("plan-fields", async () => {
    const [fields, catalog, windows, plantings] = await Promise.all([
      api.listFields(),
      api.listCrops(),
      api.listPlantingWindows(),
      api.listPlantings(),
    ]);
    return { fields, crops: catalog.crops, windows, plantings };
  });

  const [fieldId, setFieldId] = useState("");
  const [cropSlug, setCropSlug] = useState("");
  const [date, setDate] = useState(today);
  const [irrigation, setIrrigation] = useState<IrrigationAvailability>("rainfed");
  const [basis, setBasis] = useState<SingleValueEvaluationBasis>("climatology");
  const [verdictFilter, setVerdictFilter] = useState<"all" | SuitabilityVerdict>("all");

  const [suitabilityRun, setSuitabilityRun] = useState<SuitabilityRunWithWindows | null>(null);
  const [suitabilityLoading, setSuitabilityLoading] = useState(false);
  const [briefing, setBriefing] = useState<AiBriefing | null>(null);
  const [briefingQuestion, setBriefingQuestion] = useState("");
  const [actionBusy, setActionBusy] = useState(false);
  const [actionError, setActionError] = useState<unknown>(null);

  const fields = state.data?.fields ?? [];
  const crops = state.data?.crops ?? [];
  const windows = state.data?.windows ?? [];
  const plantings = state.data?.plantings ?? [];

  const field = fields.find((entry) => entry.id === fieldId) ?? fields[0];
  const crop = crops.find((entry) => entry.slug === cropSlug) ?? crops[0];

  useEffect(() => {
    if (field === undefined) {
      setSuitabilityRun(null);
      setBriefing(null);
      return;
    }
    let alive = true;
    setSuitabilityLoading(true);
    Promise.all([
      api.getLatestSuitability(field.id).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
      api.getLatestBriefing(field.id).catch((err: unknown) => {
        if (err instanceof ApiError && err.status === 404) return null;
        throw err;
      }),
    ]).then(
      ([run, latestBriefing]) => {
        if (!alive) return;
        setSuitabilityRun(run);
        setBriefing(latestBriefing);
        setSuitabilityLoading(false);
      },
      (err: unknown) => {
        if (!alive) return;
        setActionError(err);
        setSuitabilityLoading(false);
      },
    );
    return () => {
      alive = false;
    };
  }, [field]);

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  if (crops.length === 0) {
    return (
      <Empty>
        Katalog kosong. Jalankan <Mono>pnpm db:seed:catalog</Mono> lebih dulu.
      </Empty>
    );
  }

  const filteredWindows = windows.filter((w) => {
    if (field !== undefined && w.fieldId !== field.id) return false;
    if (verdictFilter !== "all" && w.suitability !== verdictFilter) return false;
    return true;
  });

  const fieldPlantings =
    field === undefined ? plantings : plantings.filter((p) => p.fieldId === field.id);

  const runEvaluation = async () => {
    if (field === undefined || crop === undefined) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const detail = await api.cropDetail(crop.slug);
      const published = detail.cultivars
        .map((cultivar) => ({
          cultivar,
          version: cultivar.profileVersions.find((v) => v.status === "published"),
        }))
        .find((entry) => entry.version !== undefined);

      if (published?.version === undefined) {
        throw new Error(`Belum ada versi profil terbit untuk ${crop.nameId}.`);
      }

      const endDate = addDaysIso(date, published.cultivar.durationDaysTypical - 1);
      const evidenceClass = basis === "daily" ? "weather_forecast" : "climatology";

      const result = await api.evaluateField(field.id, {
        profileVersionId: published.version.id,
        irrigationAvailability: irrigation,
        inputRefs: [
          basis === "daily"
            ? {
                kind: "forecast",
                role: "short_range",
                purpose: "input",
                forecastRunIds: [published.version.id],
                ingestionRunIds: [field.id],
                recordSetHash: BASELINE_HASH_PLACEHOLDER,
              }
            : {
                kind: "baseline",
                role: "climatology",
                purpose: "input",
                baselineVersion: "1991-2020-v1",
                baselineHash: BASELINE_HASH_PLACEHOLDER,
                cellKeys: ["centroid-preview"],
              },
        ],
        candidates: [
          {
            startDate: date,
            observations: {},
            primaryBasis: basis,
            evidenceSegments: [
              {
                startDate: date,
                endDate,
                evaluationBasis: basis,
                evidenceClass,
                coveragePercent: 100,
                provenance:
                  basis === "daily"
                    ? {
                        kind: "forecast",
                        forecastRunIds: [published.version.id],
                        ingestionRunIds: [field.id],
                        initializedAt: new Date().toISOString(),
                      }
                    : {
                        kind: "climatology",
                        baselineVersion: "1991-2020-v1",
                      },
              },
            ],
            missingRanges: [],
          },
        ],
        reproducible: false,
      });

      setSuitabilityRun(result);
      state.reload();
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(false);
    }
  };

  const handleGenerateBriefing = async (forceRegenerate: boolean) => {
    if (field === undefined) return;
    setActionBusy(true);
    setActionError(null);
    try {
      const q = briefingQuestion.trim();
      const result = await api.generateBriefing(field.id, {
        ...(q === "" ? {} : { question: q }),
        forceRegenerate,
      });
      setBriefing(result);
    } catch (err) {
      setActionError(err);
    } finally {
      setActionBusy(false);
    }
  };

  return (
    <div className="stack">
      <p className="lede">
        Evaluasi kesesuaian tanam berbasis aturan deterministik, jelajahi kalender &amp; peluang
        tanam, serta hasilkan briefing AI yang terikat pada segmen bukti.
      </p>

      {actionError !== null ? <ErrorNotice error={actionError} /> : null}

      <form className="panel" onSubmit={(event) => event.preventDefault()}>
        <div className="panel-body form-grid">
          <div className="field">
            <label htmlFor="plan-field">Lahan</label>
            {fields.length === 0 ? (
              <p className="muted">
                Belum ada lahan. <Link to="/lahan">Buat lahan</Link> dulu untuk evaluasi.
              </p>
            ) : (
              <select
                id="plan-field"
                value={field?.id ?? ""}
                onChange={(event) => setFieldId(event.target.value)}
              >
                {fields.map((entry) => (
                  <option key={entry.id} value={entry.id}>
                    {entry.name} · {entry.areaHa.toFixed(2)} ha
                  </option>
                ))}
              </select>
            )}
          </div>

          <div className="field">
            <label htmlFor="plan-crop">Komoditas</label>
            <select
              id="plan-crop"
              value={crop?.slug ?? ""}
              onChange={(event) => setCropSlug(event.target.value)}
            >
              {crops.map((entry) => (
                <option key={entry.slug} value={entry.slug}>
                  {entry.nameId}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="plan-date">Tanggal mulai tanam</label>
            <input
              id="plan-date"
              type="date"
              value={date}
              onChange={(event) => setDate(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="plan-irrigation">Ketersediaan irigasi</label>
            <select
              id="plan-irrigation"
              value={irrigation}
              onChange={(e) => setIrrigation(e.target.value as IrrigationAvailability)}
            >
              <option value="irrigated">{irrigationLabel("irrigated")}</option>
              <option value="partial_irrigation">{irrigationLabel("partial_irrigation")}</option>
              <option value="rainfed">{irrigationLabel("rainfed")}</option>
              <option value="unknown">{irrigationLabel("unknown")}</option>
            </select>
          </div>

          <div className="field">
            <label htmlFor="plan-basis">Basis bukti utama</label>
            <select
              id="plan-basis"
              value={basis}
              onChange={(e) => setBasis(e.target.value as SingleValueEvaluationBasis)}
            >
              <option value="climatology">Normal iklim (klimatologi)</option>
              <option value="daily">Prakiraan harian</option>
            </select>
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionBusy || field === undefined}
              onClick={() => void runEvaluation()}
            >
              Evaluasi kesesuaian
            </button>
          </div>
        </div>
      </form>

      {field !== undefined ? (
        <section className="section">
          <div className="section-head">
            <h2>Hasil evaluasi kesesuaian · {field.name}</h2>
            {suitabilityRun !== null ? (
              <Tag tone="accent">Run {suitabilityRun.id.slice(0, 8)}</Tag>
            ) : null}
          </div>

          {suitabilityLoading ? (
            <Loading label="Memuat evaluasi terakhir…" />
          ) : suitabilityRun === null ? (
            <Empty>
              Belum ada evaluasi tersimpan untuk {field.name}. Klik &ldquo;Evaluasi
              kesesuaian&rdquo; di atas untuk menjalankan mesin agronomi.
            </Empty>
          ) : (
            <div className="panel">
              <div className="panel-body stack">
                <div className="row">
                  {suitabilityRun.maxAchievableLevel !== null ? (
                    <Tag tone="accent">Grade maks {suitabilityRun.maxAchievableLevel}</Tag>
                  ) : (
                    <Tag>Grade tidak tersedia</Tag>
                  )}
                  <Tag>{irrigationLabel(suitabilityRun.fieldSnapshot.irrigationAvailability)}</Tag>
                  {suitabilityRun.dimensionCoverage.map((d) => (
                    <Tag key={d.dimension} tone={d.state === "known" ? "accent" : "warn"}>
                      {d.dimension}: {d.state}
                    </Tag>
                  ))}
                </div>

                {suitabilityRun.plantingWindows.map((w) => (
                  <div key={w.id} className="panel">
                    <div className="panel-head">
                      <strong>
                        {w.windowStart} s.d. {w.windowEnd}
                      </strong>
                      <div className="row">
                        <Tag tone={suitabilityTone(w.suitability)}>
                          {suitabilityLabel(w.suitability)}
                        </Tag>
                        <Tag>{dataClassLabel(w.weakestEvidenceClass)}</Tag>
                        {w.mixedEvidence ? <Tag tone="warn">Bukti campuran</Tag> : null}
                      </div>
                    </div>
                    <div className="panel-body stack-tight">
                      {w.explanations.length > 0 ? (
                        <ul className="stack-tight">
                          {w.explanations.map((exp, idx) => (
                            <li key={idx}>
                              {typeof exp["detail"] === "string"
                                ? exp["detail"]
                                : JSON.stringify(exp)}
                            </li>
                          ))}
                        </ul>
                      ) : (
                        <p className="muted">Tidak ada catatan alasan tambahan.</p>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </section>
      ) : null}

      <section className="section">
        <div className="section-head">
          <h2>Kalender &amp; peluang tanam</h2>
          <div className="row">
            <label htmlFor="filter-verdict" className="muted">
              Filter status:
            </label>
            <select
              id="filter-verdict"
              value={verdictFilter}
              onChange={(e) => setVerdictFilter(e.target.value as "all" | SuitabilityVerdict)}
            >
              <option value="all">Semua status</option>
              <option value="suitable">Sesuai</option>
              <option value="conditional">Bersyarat</option>
              <option value="unsuitable">Tidak sesuai</option>
              <option value="insufficient_data">Data tidak cukup</option>
            </select>
          </div>
        </div>

        <CalendarView windows={filteredWindows} plantings={fieldPlantings} />
      </section>

      {field !== undefined ? (
        <section className="section">
          <div className="section-head">
            <h2>Briefing analis AI · {field.name}</h2>
            {briefing !== null ? (
              <div className="row">
                <Tag tone={briefing.body.sourceMode === "llm" ? "accent" : "warn"}>
                  {briefing.body.sourceMode === "llm" ? "Model AI" : "Fallback deterministik"}
                </Tag>
                <Tag>{briefing.narrationStatus}</Tag>
              </div>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-body stack">
              <div className="form-grid">
                <div className="field">
                  <label htmlFor="briefing-question">Pertanyaan ke analis AI (opsional)</label>
                  <input
                    id="briefing-question"
                    maxLength={500}
                    placeholder="Contoh: Apa risiko utama bila menanam bulan ini?"
                    value={briefingQuestion}
                    onChange={(e) => setBriefingQuestion(e.target.value)}
                  />
                </div>
                <div className="form-actions">
                  <button
                    type="button"
                    className="btn btn-primary"
                    disabled={actionBusy || suitabilityRun === null}
                    onClick={() => void handleGenerateBriefing(false)}
                  >
                    Buat briefing
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={actionBusy || suitabilityRun === null}
                    onClick={() => void handleGenerateBriefing(true)}
                  >
                    Buat ulang
                  </button>
                </div>
              </div>

              {suitabilityRun === null ? (
                <Notice tone="warn">
                  Jalankan evaluasi kesesuaian terlebih dahulu sebelum membuat briefing AI.
                </Notice>
              ) : briefing === null ? (
                <p className="muted">
                  Belum ada briefing AI untuk lahan ini. Klik &ldquo;Buat briefing&rdquo; untuk
                  membuat ringkasan berbasis bukti.
                </p>
              ) : (
                <BriefingCard briefing={briefing} />
              )}
            </div>
          </div>
        </section>
      ) : null}

      {crop === undefined ? null : (
        <section className="section">
          <h2>Proyeksi siklus rulebook</h2>
          <CropPlan slug={crop.slug} date={date} fieldName={field?.name} />
        </section>
      )}
    </div>
  );
}

function CalendarView({
  windows,
  plantings,
}: {
  readonly windows: readonly PlantingWindow[];
  readonly plantings: readonly Planting[];
}) {
  const monthBuckets = new Map<string, { windows: PlantingWindow[]; plantings: Planting[] }>();

  for (const w of windows) {
    const key = `${w.windowStart.slice(0, 7)}-01`;
    const bucket = monthBuckets.get(key) ?? { windows: [], plantings: [] };
    bucket.windows.push(w);
    monthBuckets.set(key, bucket);
  }
  for (const p of plantings) {
    const key = `${p.plantedAt.slice(0, 7)}-01`;
    const bucket = monthBuckets.get(key) ?? { windows: [], plantings: [] };
    bucket.plantings.push(p);
    monthBuckets.set(key, bucket);
  }

  const sortedMonths = [...monthBuckets.keys()].sort();
  if (sortedMonths.length === 0) {
    return (
      <Empty>
        Belum ada jendela tanam aktif atau catatan penanaman untuk filter ini. Evaluasi lahan atau
        catat penanaman di <Link to="/aktivitas">Aktivitas</Link>.
      </Empty>
    );
  }

  return (
    <div className="calendar-grid">
      {sortedMonths.map((monthKey) => {
        const bucket = monthBuckets.get(monthKey);
        if (bucket === undefined) return null;
        return (
          <div className="calendar-month" key={monthKey}>
            <h3>{monthLabel(monthKey)}</h3>
            {bucket.windows.map((w) => (
              <div className="calendar-item" key={w.id}>
                <div className="spread">
                  <span className="numeric">
                    {w.windowStart} → {w.windowEnd}
                  </span>
                  <Tag tone={suitabilityTone(w.suitability)}>{suitabilityLabel(w.suitability)}</Tag>
                </div>
                <span className="muted">
                  Basis: {w.evaluationBasis} · {dataClassLabel(w.weakestEvidenceClass)}
                </span>
              </div>
            ))}
            {bucket.plantings.map((p) => (
              <div className="calendar-item" key={p.id}>
                <div className="spread">
                  <span>
                    {p.cropNameId} ({p.cultivarName})
                  </span>
                  <Tag tone={plantingStatusTone(p.status)}>{plantingStatusLabel(p.status)}</Tag>
                </div>
                <span className="muted numeric">
                  Tanam {p.plantedAt} · Panen {p.expectedHarvestTypical}
                </span>
              </div>
            ))}
          </div>
        );
      })}
    </div>
  );
}

function BriefingCard({ briefing }: { readonly briefing: AiBriefing }) {
  const { body } = briefing;
  return (
    <div className="stack">
      <div className="briefing-section">
        <h4>Ringkasan</h4>
        <p>{body.summary}</p>
      </div>
      <div className="briefing-section">
        <h4>Interpretasi cuaca &amp; iklim</h4>
        <p>{body.weatherInterpretation}</p>
      </div>
      <div className="briefing-section">
        <h4>Penjelasan kesesuaian deterministik</h4>
        <p>{body.suitabilityExplanation}</p>
      </div>
      {body.questionAnswer !== null ? (
        <div className="briefing-section">
          <h4>Jawaban pertanyaan</h4>
          <p>{body.questionAnswer}</p>
        </div>
      ) : null}
      {body.riskHighlights.length > 0 ? (
        <div className="briefing-section">
          <h4>Sorotan risiko</h4>
          <ul className="stack-tight">
            {body.riskHighlights.map((r, i) => (
              <li key={i}>
                <Tag
                  tone={
                    r.severity === "high" ? "danger" : r.severity === "warning" ? "warn" : "neutral"
                  }
                >
                  {r.severity}
                </Tag>{" "}
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {body.missingDataCaveats.length > 0 ? (
        <div className="briefing-section">
          <h4>Catatan kekurangan data</h4>
          <ul className="stack-tight">
            {body.missingDataCaveats.map((c, i) => (
              <li key={i} className="muted">
                {c}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <div className="briefing-section">
        <h4>Segmen bukti yang dirujuk</h4>
        <div className="segment-chips">
          {body.evidenceSegmentIds.map((id) => (
            <Mono key={id}>{id}</Mono>
          ))}
        </div>
      </div>
      <p className="faint">
        Model: {briefing.modelId} · Prompt: {briefing.promptVersion} · Snapshot:{" "}
        {briefing.inputSnapshotHash.slice(0, 12)}
      </p>
    </div>
  );
}

/**
 * One crop's published profiles, newest first. A cultivar with no published version
 * is shown as unavailable rather than hidden: an empty catalog row is information.
 */
function CropPlan({
  slug,
  date,
  fieldName,
}: {
  readonly slug: string;
  readonly date: string;
  readonly fieldName: string | undefined;
}) {
  const state = useAsync(`plan:${slug}`, () => api.cropDetail(slug));

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const options = state.data.cultivars.flatMap((cultivar) => {
    const published = cultivar.profileVersions.find((version) => version.status === "published");
    return published === undefined ? [] : [{ cultivar, version: published }];
  });

  if (options.length === 0) {
    return (
      <Empty>
        Belum ada rulebook terbit untuk {state.data.nameId}. Katalog tidak dapat membuat jadwal
        tanpa ambang yang disahkan.
      </Empty>
    );
  }

  if (date === "") {
    return <p className="muted">Pilih tanggal mulai untuk melihat kalender.</p>;
  }

  return (
    <div className="stack">
      {fieldName === undefined ? null : (
        <p className="muted">
          Proyeksi rulebook untuk <strong>{fieldName}</strong>.
        </p>
      )}
      {options.map(({ cultivar, version }) => (
        <section className="panel" key={version.id}>
          <div className="panel-body stack">
            <div className="section-head">
              <h3>{cultivar.name}</h3>
              <Tag>{version.ruleVersion}</Tag>
            </div>
            <PlanTimeline profileVersionId={version.id} cultivarName={cultivar.name} date={date} />
          </div>
        </section>
      ))}
    </div>
  );
}

function PlanTimeline({
  profileVersionId,
  cultivarName,
  date,
}: {
  readonly profileVersionId: string;
  readonly cultivarName: string;
  readonly date: string;
}) {
  const state = useAsync(`plan-cycle:${profileVersionId}:${date}`, () =>
    api.cropCycle(profileVersionId, date),
  );

  if (state.loading) return <div className="loading">Menghitung siklus…</div>;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const cycle = state.data;
  const position = locate(cycle);

  return (
    <>
      <p>
        Panen <strong>{cycle.harvest.typical}</strong>
        <span className="muted">
          {" "}
          (rentang {cycle.harvest.earliest} – {cycle.harvest.latest}, {cycle.duration.min}–
          {cycle.duration.max} hari)
        </span>
      </p>

      <div className="panel">
        <div className="panel-body">{position}</div>
      </div>

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Tahap</th>
              <th className="numeric">Hari</th>
              <th>Mulai</th>
              <th>Selesai</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {cycle.stages.map((stage) => (
              <tr key={stage.stageId}>
                <td>
                  {stage.name}
                  {stage.isCritical ? (
                    <>
                      {" "}
                      <Tag tone="warn">kritis</Tag>
                    </>
                  ) : null}
                </td>
                <td className="numeric">
                  {stage.startDayOffset}–{stage.endDayOffset}
                </td>
                <td className="numeric">{stage.startDate}</td>
                <td className="numeric">
                  {stage.endDate}
                  {stage.clipped ? <Tag>dipotong durasi</Tag> : null}
                </td>
                <td className="muted">{stageStatus(stage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="faint">
        {cultivarName} diproyeksikan pada durasi khas {cycle.duration.typical} hari. Tanggal bukan
        jaminan: cuaca dan iklim belum dinilai oleh proyeksi kalender ini saja.
      </p>
    </>
  );
}

function locate(cycle: CropCycle) {
  const now = today();
  const start = cycle.cycleStartDate;

  if (now < start) {
    const days = daysBetween(now, start);
    return (
      <span>
        Belum mulai: {days} hari menuju tanggal mulai {start}.
      </span>
    );
  }

  const offset = daysBetween(start, now);
  const stage = cycle.stages.find(
    (entry) => offset >= entry.startDayOffset && offset <= entry.endDayOffset,
  );

  if (stage !== undefined) {
    return (
      <span>
        Hari ini hari ke-{offset + 1} dari {cycle.duration.typical}. Fase{" "}
        <strong>{stage.name}</strong>
        {stage.isCritical ? " (kritis)" : ""}, berakhir {stage.endDate}.
      </span>
    );
  }

  if (now > cycle.harvest.latest) {
    return <span>Siklus pada rencana ini sudah lewat masa panen.</span>;
  }

  return (
    <span>
      Hari ini hari ke-{offset + 1}. Tidak ada tahap yang dinyatakan rulebook untuk hari ini.
    </span>
  );
}

function stageStatus(stage: CropCycle["stages"][number]): string {
  const todayDate = today();
  if (todayDate < stage.startDate) return "belum";
  if (todayDate > stage.endDate) return "selesai";
  return "berjalan";
}

function today(): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date());
}

function addDaysIso(isoDate: string, days: number): string {
  const ms = utcMidnight(isoDate) + days * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((utcMidnight(to) - utcMidnight(from)) / 86_400_000);
}

function utcMidnight(isoDate: string): number {
  const [year, month, day] = isoDate.split("-").map(Number) as [number, number, number];
  return Date.UTC(year, month - 1, day);
}
