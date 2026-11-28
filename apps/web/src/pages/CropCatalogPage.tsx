import { useState } from "react";

import { api } from "../api.js";
import { IconArrowRight } from "../icons.js";
import { Link } from "../router.js";
import {
  Empty,
  ErrorNotice,
  Loading,
  Notice,
  PageGuide,
  Tag,
  comparatorLabel,
  cropCategoryLabel,
  dimensionLabel,
  gradeLabel,
  severityLabel,
} from "../ui.js";
import { useAsync } from "../useAsync.js";

export function CropCatalogPage({ slug }: { readonly slug?: string }) {
  if (slug === undefined) return <CropList />;
  return <CropDetail slug={slug} />;
}

function CropList() {
  const state = useAsync("crops", () => api.listCrops());

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  if (state.data.crops.length === 0) {
    return (
      <div className="stack">
        <PageGuide
          storageKey="catalog"
          title="Tentang Panduan Tanaman"
          summary="Halaman ini berisi daftar komoditas, varietas, fase tumbuh, dan syarat lingkungan yang menjadi acuan evaluasi."
          steps={[
            {
              title: "Pilih Komoditas",
              detail:
                "Klik salah satu kartu komoditas untuk melihat daftar varietas yang tersedia.",
            },
            {
              title: "Periksa Fase & Syarat Tumbuh",
              detail:
                "Buka versi panduan untuk melihat lama fase tumbuh dan ambang curah hujan/suhu.",
            },
            {
              title: "Simulasikan Jadwal Panen",
              detail: "Ubah tanggal tanam untuk memperkirakan rentang waktu panen tiap varietas.",
            },
          ]}
        />
        <Empty>Belum ada data panduan tanaman yang tersedia saat ini.</Empty>
      </div>
    );
  }

  return (
    <div className="stack">
      <PageGuide
        storageKey="catalog"
        title="Tentang Panduan Tanaman"
        summary="Halaman ini berisi referensi varietas, lama masa tanam, dan batas kebutuhan iklim/tanah yang dipakai saat menilai kecocokan lahan."
        steps={[
          {
            title: "Pilih Komoditas",
            detail: "Klik salah satu komoditas di bawah untuk melihat varietas unggulannya.",
          },
          {
            title: "Lihat Syarat Tumbuh",
            detail:
              "Buka versi panduan berstatus Aktif untuk memeriksa fase kritis dan ambang batas.",
          },
          {
            title: "Hitung Perkiraan Panen",
            detail:
              "Gunakan simulator tanggal tanam di dalam detail varietas untuk melihat perkiraan panen.",
          },
        ]}
        tip="Catatan: Panduan ini menunjukkan syarat umum tanaman, bukan rekomendasi tanam untuk lahan tertentu. Untuk menilai lahan Anda, gunakan menu Rencana Tanam."
      />

      <div className="crop-grid">
        {state.data.crops.map((crop) => (
          <Link key={crop.id} to={`/katalog/${crop.slug}`} className="crop-card">
            <div className="spread">
              <Tag tone="accent">{cropCategoryLabel(crop.category)}</Tag>
              <IconArrowRight size={16} className="muted" />
            </div>
            <h3>{crop.nameId}</h3>
            <span className="muted" style={{ fontSize: "0.875rem" }}>
              {crop.nameEn}
            </span>
          </Link>
        ))}
      </div>
    </div>
  );
}

function CropDetail({ slug }: { readonly slug: string }) {
  const state = useAsync(`crop:${slug}`, () => api.cropDetail(slug));
  const [openVersionId, setOpenVersionId] = useState<string | null>(null);

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const crop = state.data;

  return (
    <div className="stack">
      <div className="spread">
        <div className="stack-tight">
          <span className="eyebrow">{cropCategoryLabel(crop.category)}</span>
          <h2>{crop.nameId}</h2>
          <p className="muted">{crop.nameEn}</p>
        </div>
        <Link className="btn btn-quiet" to="/katalog">
          Semua komoditas
        </Link>
      </div>

      {crop.cultivars.length === 0 ? (
        <Empty>Belum ada varietas tercatat untuk komoditas ini.</Empty>
      ) : (
        <div className="stack">
          {crop.cultivars.map((cultivar) => (
            <section className="cultivar" key={cultivar.id}>
              <header>
                <div>
                  <h3>{cultivar.name}</h3>
                  <p className="muted" style={{ fontSize: "0.875rem" }}>
                    Umur panen {cultivar.durationDaysMin}–{cultivar.durationDaysMax} hari · mulai
                    dari {cultivar.cycleStart === "sowing" ? "tanam benih" : "pindah tanam"}
                    {cultivar.nurseryDays === null
                      ? ""
                      : ` · masa semai ${cultivar.nurseryDays} hari`}
                  </p>
                </div>
                <Tag>{cultivar.profileVersions.length} versi panduan</Tag>
              </header>

              {cultivar.profileVersions.length === 0 ? (
                <div className="panel-body muted">
                  Belum ada data syarat tumbuh untuk varietas ini.
                </div>
              ) : (
                <div className="version-list">
                  {cultivar.profileVersions.map((version) => (
                    <button
                      key={version.id}
                      type="button"
                      className="version-row"
                      aria-pressed={openVersionId === version.id}
                      onClick={() =>
                        setOpenVersionId(openVersionId === version.id ? null : version.id)
                      }
                    >
                      <span className="row">
                        <strong>Versi {version.ruleVersion}</strong>
                        <Tag tone={version.status === "published" ? "accent" : undefined}>
                          {version.status === "draft"
                            ? "Draf"
                            : version.status === "published"
                              ? "Aktif dipakai"
                              : "Arsip lama"}
                        </Tag>
                      </span>
                      <span className="faint numeric">
                        {version.publishedAt === null
                          ? "Belum diterbitkan"
                          : `Terbit ${version.publishedAt.slice(0, 10)}`}
                      </span>
                    </button>
                  ))}
                </div>
              )}

              {openVersionId !== null &&
              cultivar.profileVersions.some((version) => version.id === openVersionId) ? (
                <VersionDetail id={openVersionId} cycleStart={cultivar.cycleStart} />
              ) : null}
            </section>
          ))}
        </div>
      )}
    </div>
  );
}

function VersionDetail({
  id,
  cycleStart,
}: {
  readonly id: string;
  readonly cycleStart: "sowing" | "transplant";
}) {
  const state = useAsync(`profile:${id}`, () => api.profileVersion(id));

  if (state.loading) return <div className="panel-body loading">Memuat detail syarat tumbuh…</div>;
  if (state.error !== null) {
    return (
      <div className="panel-body">
        <ErrorNotice error={state.error} />
      </div>
    );
  }
  if (state.data === null) return null;

  const profile = state.data;
  const dimensions = ["climate", "water", "soil", "timing", "risk"] as const;
  const presentDimensions = new Set(profile.constraints.map((c) => c.dimension));

  return (
    <div className="panel-body stack">
      <section className="stack-tight">
        <h4>Kelengkapan Aspek Penilaian</h4>
        <div className="row">
          {dimensions.map((dim) => (
            <Tag key={dim} tone={presentDimensions.has(dim) ? "accent" : "warn"}>
              {dimensionLabel(dim)}: {presentDimensions.has(dim) ? "Tersedia" : "Belum lengkap"}
            </Tag>
          ))}
        </div>
      </section>

      <section className="stack-tight">
        <h4>Fase Pertumbuhan</h4>
        {profile.growthStages.length === 0 ? (
          <p className="muted">Tidak ada rincian fase pertumbuhan.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama Fase</th>
                  <th className="numeric">Rentang Hari</th>
                  <th>Prioritas</th>
                  <th>Kebutuhan Khusus</th>
                </tr>
              </thead>
              <tbody>
                {profile.growthStages.map((stage) => (
                  <tr key={stage.id}>
                    <td>{stage.name}</td>
                    <td className="numeric">
                      Hari ke-{stage.startDayOffset} s.d. {stage.endDayOffset}
                    </td>
                    <td>{stage.isCritical ? <Tag tone="warn">Fase kritis</Tag> : "Normal"}</td>
                    <td className="muted">{stage.requirementProfile ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <CycleProjection id={id} cycleStart={cycleStart} />

      <section className="stack-tight">
        <h4>Ambang Batas Syarat Tumbuh</h4>
        {profile.constraints.length === 0 ? (
          <p className="muted">Belum ada ambang batas tercatat.</p>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Aspek</th>
                  <th>Jenis Batas</th>
                  <th className="numeric">Nilai Ideal</th>
                  <th>Berlaku Pada Fase</th>
                  <th>Tingkat Rujukan</th>
                  <th>Sifat Aturan</th>
                </tr>
              </thead>
              <tbody>
                {profile.constraints.map((constraint) => {
                  const stage = profile.growthStages.find(
                    (candidate) => candidate.id === constraint.growthStageId,
                  );
                  return (
                    <tr key={constraint.id}>
                      <td>{dimensionLabel(constraint.dimension)}</td>
                      <td className="muted">{comparatorLabel(constraint.comparator)}</td>
                      <td className="numeric">{thresholdLabel(constraint)}</td>
                      <td className="muted">{stage?.name ?? "Seluruh masa tanam"}</td>
                      <td>
                        <Tag tone={constraint.grade === "A" ? "accent" : undefined}>
                          {gradeLabel(constraint.grade)}
                        </Tag>
                      </td>
                      <td>
                        <Tag tone={constraint.severity === "hard" ? "warn" : undefined}>
                          {severityLabel(constraint.severity)}
                        </Tag>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="stack-tight">
        <h4>Sumber Rujukan Ilmiah</h4>
        {profile.sourceRefs.length === 0 ? (
          <p className="muted">Tidak ada sumber rujukan tercatat.</p>
        ) : (
          <ul className="stack-tight">
            {profile.sourceRefs.map((source) => (
              <li key={source.id}>
                <span>{source.title}</span>
                <span className="muted">
                  {" "}
                  — {source.authors ?? "Tanpa nama penulis"}, {source.publisher}{" "}
                  {source.publicationYear}
                </span>{" "}
                <a href={source.url} target="_blank" rel="noreferrer">
                  Buka rujukan
                </a>{" "}
                <Tag tone={source.grade === "A" ? "accent" : undefined}>
                  {gradeLabel(source.grade)}
                </Tag>
              </li>
            ))}
          </ul>
        )}
      </section>

      <Notice tone="info">
        <span>
          Data di atas adalah acuan standar varietas. Untuk memeriksa kecocokan terhadap kondisi
          cuaca di lahan Anda, jalankan evaluasi di halaman <Link to="/rencana">Rencana Tanam</Link>
          .
        </span>
      </Notice>
    </div>
  );
}

function CycleProjection({
  id,
  cycleStart,
}: {
  readonly id: string;
  readonly cycleStart: "sowing" | "transplant";
}) {
  const [date, setDate] = useState(() =>
    new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Jakarta" }).format(new Date()),
  );

  const startLabel = cycleStart === "sowing" ? "tanam benih" : "pindah tanam";

  return (
    <section className="stack-tight">
      <h4>Simulasi Perkiraan Tanggal Panen</h4>
      <p className="muted">
        Pilih rencana tanggal {startLabel} untuk melihat perkiraan tanggal tiap fase pertumbuhan.
      </p>
      <div className="field" style={{ maxWidth: 260 }}>
        <label htmlFor={`cycle-${id}`}>Rencana tanggal {startLabel}</label>
        <input
          id={`cycle-${id}`}
          type="date"
          value={date}
          onChange={(event) => setDate(event.target.value)}
        />
      </div>
      {date === "" ? (
        <p className="muted">Pilih tanggal untuk melihat perkiraan jadwal.</p>
      ) : (
        <CycleTable id={id} date={date} />
      )}
    </section>
  );
}

function CycleTable({ id, date }: { readonly id: string; readonly date: string }) {
  const state = useAsync(`cycle:${id}:${date}`, () => api.cropCycle(id, date));

  if (state.loading) return <div className="loading">Menghitung jadwal fase…</div>;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const cycle = state.data;

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
      {cycle.stages.length === 0 ? (
        <p className="muted">Tidak ada rincian fase untuk varietas ini.</p>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>Fase</th>
                <th className="numeric">Hari</th>
                <th>Mulai</th>
                <th>Selesai</th>
                <th>Prioritas</th>
              </tr>
            </thead>
            <tbody>
              {cycle.stages.map((stage) => (
                <tr key={stage.stageId}>
                  <td>{stage.name}</td>
                  <td className="numeric">
                    {stage.startDayOffset}–{stage.endDayOffset}
                  </td>
                  <td className="numeric">{stage.startDate}</td>
                  <td className="numeric">
                    {stage.endDate}
                    {stage.clipped ? <Tag>Disesuaikan</Tag> : null}
                  </td>
                  <td>{stage.isCritical ? <Tag tone="warn">Fase kritis</Tag> : "Normal"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function thresholdLabel(constraint: {
  readonly comparator: string;
  readonly thresholdLower: number | null;
  readonly thresholdUpper: number | null;
  readonly thresholdCount: number | null;
  readonly unit: string | null;
}): string {
  const unit = constraint.unit ?? "";
  switch (constraint.comparator) {
    case "min":
      return `≥ ${constraint.thresholdLower ?? "?"} ${unit}`;
    case "max":
      return `≤ ${constraint.thresholdUpper ?? "?"} ${unit}`;
    case "range":
      return `${constraint.thresholdLower ?? "?"}–${constraint.thresholdUpper ?? "?"} ${unit}`;
    case "count":
      return `${constraint.thresholdCount ?? "?"}×`;
    default:
      return "—";
  }
}
