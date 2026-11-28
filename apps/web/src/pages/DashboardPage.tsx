import { api } from "../api.js";
import { FarmAreaBarChart, PlantingProgressList } from "../components/Visuals.js";
import {
  IconAlert,
  IconBook,
  IconCalendar,
  IconClipboard,
  IconCloud,
  IconMap,
  IconSparkles,
} from "../icons.js";
import { Link } from "../router.js";
import { Empty, ErrorNotice, Loading, Notice, PageGuide, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

export function DashboardPage() {
  const state = useAsync("dashboard", async () => {
    const [farms, fields, plantings, windows, advisory] = await Promise.all([
      api.listFarms(),
      api.listFields(),
      api.listPlantings(),
      api.listPlantingWindows(),
      api.dashboardAdvisory().catch(() => null),
    ]);
    return { farms, fields, plantings, windows, advisory };
  });

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const { farms, fields, plantings, windows, advisory } = state.data;
  const activePlantings = plantings.filter((p) => p.status === "active").length;
  const newest = [...farms].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);

  return (
    <div className="stack">
      <PageGuide
        storageKey="dashboard"
        title="Panduan Singkat Aplikasi"
        summary="Agroclimate Planner membantu Anda menilai waktu tanam terbaik berdasarkan lokasi lahan, ketersediaan air, dan prakiraan curah hujan."
        steps={[
          {
            title: "1. Petakan Kebun & Lahan",
            detail: "Catat nama kebun, gambar batas lahan, lalu lengkapi jenis tanah dan irigasi.",
          },
          {
            title: "2. Uji Jadwal di Rencana Tanam",
            detail:
              "Pilih tanaman dan rencana tanggal mulai untuk melihat kecocokan serta saran AI.",
          },
          {
            title: "3. Pantau & Catat Aktivitas",
            detail: "Catat penanaman aktual, hasil panen bertahap, serta pengamatan hujan harian.",
          },
        ]}
        tip="Tips: Gunakan tombol mengambang 'Panduan Mulai' di pojok kanan bawah kapan saja untuk memantau progres langkah Anda."
      />

      {advisory !== null ? (
        <section className="panel advisory-hero" aria-label="Himbauan Iklim dan Fokus Minggu Ini">
          <div className="advisory-hero-head">
            <div className="stack" style={{ gap: 4 }}>
              <div className="row" style={{ gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                <IconCloud size={20} />
                <h2 style={{ margin: 0 }}>Himbauan Iklim &amp; Fokus Minggu Ini</h2>
                <Tag tone="accent">Himbauan Indikatif</Tag>
              </div>
              <p className="muted" style={{ margin: 0 }}>
                {advisory.currentMonthSeason.summaryId}
              </p>
            </div>
            <div className="btn-row">
              <Link className="btn btn-quiet btn-sm" to="/iklim">
                <IconCloud size={15} />
                <span>Cuaca &amp; Iklim</span>
              </Link>
              <Link className="btn btn-primary btn-sm" to="/rencana">
                <IconCalendar size={15} />
                <span>Rekomendasi Tanam</span>
              </Link>
            </div>
          </div>

          <div className="advisory-hero-body">
            {advisory.criticalStageAlerts.length > 0 ? (
              <div className="advisory-alerts">
                <strong className="advisory-subhead">
                  <IconAlert size={15} />
                  <span>Peringatan Siklus Tanam Aktif (Fase Kritis)</span>
                </strong>
                <div className="advisory-alert-list">
                  {advisory.criticalStageAlerts.map((alert) => (
                    <div className="advisory-alert-item" key={alert.plantingId}>
                      <div className="spread" style={{ gap: 8 }}>
                        <strong>
                          {alert.cropNameId} ({alert.cultivarName}) · {alert.fieldName}
                        </strong>
                        <Tag tone={alert.status === "in_critical" ? "danger" : "warn"}>
                          {alert.status === "in_critical"
                            ? "Sedang Fase Kritis"
                            : `H-${alert.daysUntilStart} Fase Kritis`}
                        </Tag>
                      </div>
                      <p className="muted" style={{ margin: "4px 0 0" }}>
                        {alert.weatherSummaryId}
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            {advisory.fieldWeather.length === 0 ? (
              <p className="muted" style={{ margin: 0 }}>
                Belum ada lahan terdaftar. <Link to="/lahan">Tambahkan lahan</Link> untuk memantau
                ringkasan cuaca 7–14 hari ke depan.
              </p>
            ) : (
              <div className="advisory-weather-grid">
                {advisory.fieldWeather.map((fw) => (
                  <div className="advisory-weather-card" key={fw.fieldId}>
                    <div className="spread" style={{ gap: 8 }}>
                      <div>
                        <strong>{fw.fieldName}</strong>
                        <span className="faint" style={{ marginLeft: 6, fontSize: "0.82rem" }}>
                          {fw.farmName}
                        </span>
                      </div>
                      {fw.hasData && fw.totalRainMm !== null ? (
                        <Tag tone={fw.peakRainMm !== null && fw.peakRainMm >= 20 ? "warn" : "accent"}>
                          ~{Math.round(fw.totalRainMm)} mm / {fw.horizonDays} hr
                        </Tag>
                      ) : (
                        <Tag>Belum ada data cuaca</Tag>
                      )}
                    </div>
                    <p style={{ margin: "6px 0 0", fontSize: "0.9rem" }}>{fw.advisoryTextId}</p>
                    {!fw.hasData ? (
                      <div style={{ marginTop: 8 }}>
                        <Link className="btn btn-quiet btn-sm" to="/iklim">
                          Cek Cuaca &amp; Iklim
                        </Link>
                      </div>
                    ) : null}
                  </div>
                ))}
              </div>
            )}
          </div>
        </section>
      ) : null}

      <div className="stats">
        <div className="stat">
          <span className="stat-icon">
            <IconMap size={20} />
          </span>
          <div className="stat-body">
            <span className="value">{farms.length}</span>
            <span className="label">Kebun terdaftar</span>
          </div>
        </div>

        <div className="stat">
          <span className="stat-icon">
            <IconSparkles size={20} />
          </span>
          <div className="stat-body">
            <span className="value">{fields.length}</span>
            <span className="label">Total lahan dipetakan</span>
          </div>
        </div>

        <div className="stat">
          <span className="stat-icon">
            <IconClipboard size={20} />
          </span>
          <div className="stat-body">
            <span className="value">{activePlantings}</span>
            <span className="label">Penanaman berjalan</span>
          </div>
        </div>

        <div className="stat">
          <span className="stat-icon">
            <IconCalendar size={20} />
          </span>
          <div className="stat-body">
            <span className="value">{windows.length}</span>
            <span className="label">Jadwal tanam tersimpan</span>
          </div>
        </div>
      </div>

      <div className="visual-grid-2">
        <FarmAreaBarChart farms={farms} fields={fields} />
        <PlantingProgressList plantings={plantings} fields={fields} />
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Kebun Terbaru</h2>
          <Link className="btn btn-quiet btn-sm" to="/lahan">
            Kelola semua lahan
          </Link>
        </div>

        {newest.length === 0 ? (
          <Empty>
            <p>Belum ada kebun yang tercatat.</p>
            <Link className="btn btn-primary" to="/lahan">
              Buat kebun pertama Anda
            </Link>
          </Empty>
        ) : (
          <div className="panel table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="col-text">Nama Kebun</th>
                  <th className="col-text">Wilayah</th>
                  <th className="col-num">Jumlah Lahan</th>
                  <th className="col-date">Tanggal Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {newest.map((farm) => {
                  const count = fields.filter((field) => field.farmId === farm.id).length;
                  return (
                    <tr key={farm.id}>
                      <td className="col-text">
                        <strong>{farm.name}</strong>
                      </td>
                      <td className="col-text muted">{farm.region ?? "Belum diisi"}</td>
                      <td className="col-num">{count}</td>
                      <td className="col-date muted">{farm.createdAt.slice(0, 10)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section className="section">
        <h2>Menu Utama</h2>
        <div className="card-grid">
          <Link className="card spread" to="/rencana">
            <div>
              <h3>Rencana Tanam &amp; AI</h3>
              <p className="muted">Cek kecocokan tanggal tanam &amp; hujan.</p>
            </div>
            <span className="btn btn-primary btn-sm">
              <IconCalendar size={15} />
              <span>Buka</span>
            </span>
          </Link>

          <Link className="card spread" to="/aktivitas">
            <div>
              <h3>Aktivitas &amp; Panen</h3>
              <p className="muted">Catat tanam, panen, dan hujan lapangan.</p>
            </div>
            <span className="btn btn-quiet btn-sm">
              <IconClipboard size={15} />
              <span>Buka</span>
            </span>
          </Link>

          <Link className="card spread" to="/iklim">
            <div>
              <h3>Cuaca &amp; Iklim</h3>
              <p className="muted">Grafik hujan bulanan &amp; harian.</p>
            </div>
            <span className="btn btn-quiet btn-sm">
              <IconCloud size={15} />
              <span>Lihat</span>
            </span>
          </Link>

          <Link className="card spread" to="/katalog">
            <div>
              <h3>Panduan Tanaman</h3>
              <p className="muted">Fase tumbuh &amp; syarat iklim komoditas.</p>
            </div>
            <span className="btn btn-quiet btn-sm">
              <IconBook size={15} />
              <span>Buka</span>
            </span>
          </Link>
        </div>
      </section>

      <Notice tone="info">
        <span>
          <strong>Info Sumber Cuaca:</strong> Data cuaca saat ini menggunakan data simulasi untuk
          uji coba perencanaan sambil menunggu aktivasi koneksi satelit &amp; prakiraan cuaca
          produksi.
        </span>
      </Notice>
    </div>
  );
}
