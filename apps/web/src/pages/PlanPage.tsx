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
import { CustomSelect } from "../components/CustomSelect.js";
import { DatePicker } from "../components/DatePicker.js";
import {
  ConstraintCheckList,
  EvaluationVisualSummary,
  GrowthStageTimeline,
} from "../components/Visuals.js";
import { IconCalendar, IconSparkles } from "../icons.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  FieldLabel,
  Loading,
  Mono,
  Notice,
  PageGuide,
  Tag,
  dataClassLabel,
  irrigationLabel,
  monthLabel,
  notifyDataChanged,
  plantingStatusLabel,
  plantingStatusTone,
  severityLabel,
  suitabilityLabel,
  suitabilityTone,
  translateEvaluationDetail,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

const BASELINE_HASH_PLACEHOLDER = "0".repeat(64);

type PlanTab = "evaluation" | "briefing" | "schedule";

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

  const [tab, setTab] = useState<PlanTab>("evaluation");
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
      api.getFieldAgronomy(field.id).catch(() => null),
    ]).then(
      ([run, latestBriefing, agronomy]) => {
        if (!alive) return;
        setSuitabilityRun(run);
        setBriefing(latestBriefing);
        if (
          agronomy?.irrigationAvailability !== null &&
          agronomy?.irrigationAvailability !== undefined
        ) {
          setIrrigation(agronomy.irrigationAvailability);
        }
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
      <Empty>Data panduan tanaman belum tersedia saat ini. Silakan periksa kembali nanti.</Empty>
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
        throw new Error(`Belum ada panduan aktif untuk komoditas ${crop.nameId}.`);
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
      setTab("evaluation");
      notifyDataChanged();
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
      <PageGuide
        storageKey="plan"
        title="Panduan Rencana Tanam"
        summary="Uji apakah tanggal tanam dan komoditas pilihan Anda sesuai dengan kondisi pengairan lahan dan pola cuaca."
        steps={[
          {
            title: "1. Pilih Lahan & Komoditas",
            detail: "Tentukan lahan, jenis tanaman, rencana tanggal mulai, dan kondisi pengairan.",
          },
          {
            title: "2. Jalankan Evaluasi Kesesuaian",
            detail:
              "Klik Evaluasi kesesuaian untuk melihat status kecocokan, alasan, dan kalender tanam.",
          },
          {
            title: "3. Tanya Asisten AI",
            detail:
              "Buka tab Asisten AI untuk meminta ringkasan risiko dan penjelasan dalam bahasa sederhana.",
          },
        ]}
        glossary={[
          { term: "Sesuai", meaning: "Kondisi iklim & air mendukung tanam" },
          { term: "Sesuai bersyarat", meaning: "Dapat ditanam dengan catatan/pengairan tambahan" },
          { term: "Kurang sesuai", meaning: "Risiko tinggi terhadap cuaca/kekeringan" },
          { term: "Data belum cukup", meaning: "Sebagian aspek belum memiliki data lengkap" },
        ]}
      />

      {actionError !== null ? <ErrorNotice error={actionError} /> : null}

      <form className="panel" onSubmit={(event) => event.preventDefault()}>
        <div className="panel-head">
          <h3>Parameter Evaluasi Tanam</h3>
        </div>
        <div className="panel-body form-grid">
          <div className="field">
            <FieldLabel htmlFor="plan-field" label="Pilih Lahan" />
            {fields.length === 0 ? (
              <p className="muted">
                Belum ada lahan. <Link to="/lahan">Buat lahan</Link> terlebih dahulu.
              </p>
            ) : (
              <CustomSelect
                id="plan-field"
                value={field?.id ?? ""}
                onChange={setFieldId}
                options={fields.map((entry) => ({
                  value: entry.id,
                  label: `${entry.name} · ${entry.areaHa.toFixed(2)} ha`,
                }))}
              />
            )}
          </div>

          <div className="field">
            <FieldLabel htmlFor="plan-crop" label="Komoditas" />
            <CustomSelect
              id="plan-crop"
              value={crop?.slug ?? ""}
              onChange={setCropSlug}
              options={crops.map((entry) => ({
                value: entry.slug,
                label: entry.nameId,
              }))}
            />
          </div>

          <div className="field">
            <FieldLabel htmlFor="plan-date" label="Rencana Tanggal Mulai Tanam" />
            <DatePicker id="plan-date" value={date} onChange={setDate} />
          </div>

          <div className="field">
            <FieldLabel
              htmlFor="plan-irrigation"
              label="Ketersediaan Pengairan"
              tooltip="Otomatis mengikuti profil agronomi lahan jika sudah diisi di Kebun & Lahan."
            />
            <CustomSelect
              id="plan-irrigation"
              value={irrigation}
              onChange={(val) => setIrrigation(val as IrrigationAvailability)}
              options={[
                { value: "irrigated", label: irrigationLabel("irrigated") },
                { value: "partial_irrigation", label: irrigationLabel("partial_irrigation") },
                { value: "rainfed", label: irrigationLabel("rainfed") },
                { value: "unknown", label: irrigationLabel("unknown") },
              ]}
            />
          </div>

          <div className="field">
            <FieldLabel
              htmlFor="plan-basis"
              label="Sumber Data Cuaca"
              tooltip="Pola iklim rata-rata menghasilkan status maksimal 'Sesuai bersyarat'; pilih 'Prakiraan cuaca harian' jika seluruh data syarat terpenuhi untuk status 'Sesuai'."
            />
            <CustomSelect
              id="plan-basis"
              value={basis}
              onChange={(val) => setBasis(val as SingleValueEvaluationBasis)}
              options={[
                { value: "climatology", label: "Pola iklim rata-rata (jangka panjang)" },
                { value: "daily", label: "Prakiraan cuaca harian" },
              ]}
            />
          </div>

          <div className="form-actions">
            <button
              type="button"
              className="btn btn-primary"
              disabled={actionBusy || field === undefined}
              onClick={() => void runEvaluation()}
            >
              {actionBusy ? "Mengevaluasi…" : "Evaluasi kesesuaian"}
            </button>
          </div>
        </div>
      </form>

      <div className="tabs" role="tablist" aria-label="Bagian Rencana Tanam">
        <button
          type="button"
          role="tab"
          aria-selected={tab === "evaluation"}
          className={`tab-btn${tab === "evaluation" ? " is-active" : ""}`}
          onClick={() => setTab("evaluation")}
        >
          <IconCalendar size={16} />
          <span>Evaluasi &amp; Kalender</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "briefing"}
          className={`tab-btn${tab === "briefing" ? " is-active" : ""}`}
          onClick={() => setTab("briefing")}
        >
          <IconSparkles size={16} />
          <span>Asisten AI</span>
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === "schedule"}
          className={`tab-btn${tab === "schedule" ? " is-active" : ""}`}
          onClick={() => setTab("schedule")}
        >
          <span>Jadwal Fase Tanam</span>
        </button>
      </div>

      {tab === "evaluation" ? (
        <div className="stack">
          {field !== undefined ? (
            <section className="section">
              <div className="section-head">
                <h2>Hasil Evaluasi Kesesuaian · {field.name}</h2>
                {suitabilityRun !== null ? (
                  <Tag tone="accent">
                    {irrigationLabel(suitabilityRun.fieldSnapshot.irrigationAvailability)}
                  </Tag>
                ) : null}
              </div>

              {suitabilityLoading ? (
                <Loading label="Memuat hasil evaluasi terakhir…" />
              ) : suitabilityRun === null ? (
                <Empty>
                  Belum ada evaluasi tersimpan untuk {field.name}. Klik &ldquo;Evaluasi
                  kesesuaian&rdquo; di atas untuk memulai.
                </Empty>
              ) : (
                <div className="panel">
                  <div className="panel-body stack">
                    <EvaluationVisualSummary run={suitabilityRun} />

                    {suitabilityRun.plantingWindows.map((w) => (
                      <div key={w.id} className="panel">
                        <div className="panel-head">
                          <strong>
                            Jendela Tanam: {w.windowStart} s.d. {w.windowEnd}
                          </strong>
                          <div className="row">
                            <Tag tone={suitabilityTone(w.suitability)}>
                              {suitabilityLabel(w.suitability)}
                            </Tag>
                            <Tag>{dataClassLabel(w.weakestEvidenceClass)}</Tag>
                            {w.mixedEvidence ? <Tag tone="warn">Sumber data campuran</Tag> : null}
                          </div>
                        </div>
                        <div className="panel-body stack">
                          <ConstraintCheckList items={w.constraintsEvaluated} />
                          {w.explanations.length > 0 ? (
                            <ul className="stack-tight">
                              {w.explanations.map((exp, idx) => (
                                <li key={idx}>
                                  {typeof exp["detail"] === "string"
                                    ? translateEvaluationDetail(exp["detail"])
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
              <h2>Kalender &amp; Peluang Tanam</h2>
              <div className="row" style={{ minWidth: 230 }}>
                <CustomSelect
                  id="filter-verdict"
                  ariaLabel="Saring status kalender tanam"
                  value={verdictFilter}
                  onChange={(val) => setVerdictFilter(val as "all" | SuitabilityVerdict)}
                  options={[
                    { value: "all", label: "Semua status" },
                    { value: "suitable", label: "Sesuai" },
                    { value: "conditional", label: "Sesuai bersyarat" },
                    { value: "unsuitable", label: "Kurang sesuai" },
                    { value: "insufficient_data", label: "Data belum cukup" },
                  ]}
                />
              </div>
            </div>

            <CalendarView windows={filteredWindows} plantings={fieldPlantings} />
          </section>
        </div>
      ) : null}

      {tab === "briefing" && field !== undefined ? (
        <section className="section">
          <div className="section-head">
            <h2>Ringkasan Asisten AI · {field.name}</h2>
            {briefing !== null ? (
              <Tag tone={briefing.body.sourceMode === "llm" ? "accent" : "warn"}>
                {briefing.body.sourceMode === "llm" ? "Analisis AI" : "Ringkasan Otomatis"}
              </Tag>
            ) : null}
          </div>

          <div className="panel">
            <div className="panel-body stack">
              <div className="form-grid">
                <div className="field">
                  <FieldLabel
                    htmlFor="briefing-question"
                    label="Tanyakan sesuatu tentang rencana ini (opsional)"
                  />
                  <input
                    id="briefing-question"
                    maxLength={500}
                    placeholder="Contoh: Apa risiko utama bila menanam pada tanggal ini?"
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
                    Buat Ringkasan Analisis
                  </button>
                  <button
                    type="button"
                    className="btn btn-quiet"
                    disabled={actionBusy || suitabilityRun === null}
                    onClick={() => void handleGenerateBriefing(true)}
                  >
                    Perbarui Analisis
                  </button>
                </div>
              </div>

              {suitabilityRun === null ? (
                <Notice tone="warn">
                  Jalankan <strong>Evaluasi kesesuaian</strong> terlebih dahulu sebelum meminta
                  ringkasan Asisten AI.
                </Notice>
              ) : briefing === null ? (
                <p className="muted">
                  Belum ada ringkasan untuk lahan ini. Klik &ldquo;Buat Ringkasan Analisis&rdquo;
                  untuk mendapatkan penjelasan cuaca dan risikonya.
                </p>
              ) : (
                <BriefingCard briefing={briefing} />
              )}
            </div>
          </div>
        </section>
      ) : null}

      {tab === "schedule" && crop !== undefined ? (
        <section className="section">
          <h2>Jadwal Fase Tanam · {crop.nameId}</h2>
          <CropPlan slug={crop.slug} date={date} fieldName={field?.name} />
        </section>
      ) : null}
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
        <p>
          Belum ada jendela tanam atau catatan penanaman untuk saringan ini. Jalankan evaluasi di
          atas atau catat penanaman di <Link to="/aktivitas">Aktivitas &amp; Panen</Link>.
        </p>
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
                <span className="muted">{dataClassLabel(w.weakestEvidenceClass)}</span>
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
        <h4>Ringkasan Utama</h4>
        <p>{body.summary}</p>
      </div>
      <div className="briefing-section">
        <h4>Kondisi Cuaca &amp; Iklim</h4>
        <p>{body.weatherInterpretation}</p>
      </div>
      <div className="briefing-section">
        <h4>Alasan Penilaian</h4>
        <p>{body.suitabilityExplanation}</p>
      </div>
      {body.questionAnswer !== null ? (
        <div className="briefing-section">
          <h4>Jawaban Pertanyaan Anda</h4>
          <p>{body.questionAnswer}</p>
        </div>
      ) : null}
      {body.riskHighlights.length > 0 ? (
        <div className="briefing-section">
          <h4>Hal yang Perlu Diwaspadai</h4>
          <ul className="stack-tight">
            {body.riskHighlights.map((r, i) => (
              <li key={i}>
                <Tag
                  tone={
                    r.severity === "high" ? "danger" : r.severity === "warning" ? "warn" : "neutral"
                  }
                >
                  {severityLabel(r.severity)}
                </Tag>{" "}
                {r.message}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {body.missingDataCaveats.length > 0 ? (
        <div className="briefing-section">
          <h4>Catatan Kelengkapan Data</h4>
          <ul className="stack-tight">
            {body.missingDataCaveats.map((c, i) => (
              <li key={i} className="muted">
                {c}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="tech-details">
        <summary>Lihat detail teknis &amp; referensi data</summary>
        <div className="stack-tight">
          <div className="segment-chips">
            {body.evidenceSegmentIds.map((id) => (
              <Mono key={id}>{id}</Mono>
            ))}
          </div>
          <p className="faint">
            Model: {briefing.modelId} · Versi prompt: {briefing.promptVersion} · Snapshot:{" "}
            {briefing.inputSnapshotHash.slice(0, 12)}
          </p>
        </div>
      </details>
    </div>
  );
}

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
        Belum ada panduan aktif untuk {state.data.nameId} sehingga jadwal belum bisa dihitung.
      </Empty>
    );
  }

  if (date === "") {
    return <p className="muted">Pilih rencana tanggal mulai untuk melihat jadwal fase.</p>;
  }

  return (
    <div className="stack">
      {fieldName === undefined ? null : (
        <p className="muted">
          Perkiraan jadwal fase untuk lahan <strong>{fieldName}</strong> bila mulai tanam pada{" "}
          <strong>{date}</strong>.
        </p>
      )}
      {options.map(({ cultivar, version }) => (
        <section className="panel" key={version.id}>
          <div className="panel-body stack">
            <div className="section-head">
              <h3>{cultivar.name}</h3>
              <Tag>Panduan v{version.ruleVersion}</Tag>
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

  if (state.loading) return <div className="loading">Menghitung jadwal fase…</div>;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const cycle = state.data;
  const position = locate(cycle);

  return (
    <>
      <p>
        Perkiraan panen utama: <strong>{cycle.harvest.typical}</strong>
        <span className="muted">
          {" "}
          (rentang {cycle.harvest.earliest} – {cycle.harvest.latest}, durasi {cycle.duration.min}–
          {cycle.duration.max} hari)
        </span>
      </p>

      <Notice tone="info">{position}</Notice>

      <GrowthStageTimeline
        stages={cycle.stages.map((s) => ({
          id: s.stageId,
          name: s.name,
          startDayOffset: s.startDayOffset,
          endDayOffset: s.endDayOffset,
          isCritical: s.isCritical,
          subtitle: `${s.startDate} s.d. ${s.endDate} • ${stageStatus(s)}`,
        }))}
        totalDays={cycle.duration.typical}
        todayOffset={
          today() >= cycle.cycleStartDate && today() <= cycle.harvest.latest
            ? daysBetween(cycle.cycleStartDate, today())
            : null
        }
      />

      <div className="table-wrap">
        <table className="table">
          <thead>
            <tr>
              <th>Fase Pertumbuhan</th>
              <th className="numeric">Hari ke-</th>
              <th>Mulai</th>
              <th>Selesai</th>
              <th>Status Saat Ini</th>
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
                      <Tag tone="warn">Fase kritis</Tag>
                    </>
                  ) : null}
                </td>
                <td className="numeric">
                  {stage.startDayOffset}–{stage.endDayOffset}
                </td>
                <td className="numeric">{stage.startDate}</td>
                <td className="numeric">
                  {stage.endDate}
                  {stage.clipped ? <Tag>Disesuaikan</Tag> : null}
                </td>
                <td className="muted">{stageStatus(stage)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="faint">
        Jadwal untuk {cultivarName} dihitung berdasarkan durasi rata-rata {cycle.duration.typical}{" "}
        hari. Untuk menilai risiko cuaca, gunakan tab Evaluasi &amp; Kalender.
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
        Belum dimulai: {days} hari lagi menuju tanggal tanam {start}.
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
        Hari ini hari ke-{offset + 1} dari {cycle.duration.typical}. Sedang berada di fase{" "}
        <strong>{stage.name}</strong>
        {stage.isCritical ? " (fase kritis)" : ""}, berakhir pada {stage.endDate}.
      </span>
    );
  }

  if (now > cycle.harvest.latest) {
    return <span>Siklus pada jadwal ini sudah melewati masa panen.</span>;
  }

  return <span>Hari ini hari ke-{offset + 1}.</span>;
}

function stageStatus(stage: CropCycle["stages"][number]): string {
  const todayDate = today();
  if (todayDate < stage.startDate) return "Belum mulai";
  if (todayDate > stage.endDate) return "Selesai";
  return "Sedang berjalan";
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
