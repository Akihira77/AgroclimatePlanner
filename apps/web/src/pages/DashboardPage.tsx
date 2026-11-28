import { api } from "../api.js";
import {
  IconArrowRight,
  IconBook,
  IconCalendar,
  IconCheck,
  IconClipboard,
  IconCloud,
  IconMap,
  IconSparkles,
} from "../icons.js";
import { Link } from "../router.js";
import { Empty, ErrorNotice, Loading, Notice, PageGuide } from "../ui.js";
import { useAsync } from "../useAsync.js";

export function DashboardPage() {
  const state = useAsync("dashboard", async () => {
    const [farms, fields, plantings, windows] = await Promise.all([
      api.listFarms(),
      api.listFields(),
      api.listPlantings(),
      api.listPlantingWindows(),
    ]);
    return { farms, fields, plantings, windows };
  });

  if (state.loading) return <Loading />;
  if (state.error !== null) return <ErrorNotice error={state.error} />;
  if (state.data === null) return null;

  const { farms, fields, plantings, windows } = state.data;
  const activePlantings = plantings.filter((p) => p.status === "active").length;
  const newest = [...farms].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 4);

  const checklist = [
    {
      done: farms.length > 0 && fields.length > 0,
      title: "Buat kebun & batas lahan",
      detail: "Daftarkan minimal satu kebun dan gambar area lahannya.",
      to: "/lahan",
      cta: "Buka Kebun & Lahan",
    },
    {
      done: fields.length > 0 && windows.length > 0,
      title: "Lengkapi kondisi tanah & pengairan",
      detail: "Buka Detail lahan di menu Kebun & Lahan agar analisis lebih akurat.",
      to: "/lahan",
      cta: "Isi Profil Tanah",
    },
    {
      done: windows.length > 0,
      title: "Jalankan Rencana Tanam & AI",
      detail: "Uji kecocokan tanggal tanam dan baca ringkasan Asisten AI.",
      to: "/rencana",
      cta: "Buat Rencana",
    },
    {
      done: plantings.length > 0,
      title: "Catat penanaman atau panen",
      detail: "Rekam jadwal tanam aktual serta pengamatan curah hujan di lahan.",
      to: "/aktivitas",
      cta: "Catat Aktivitas",
    },
  ];

  const completedCount = checklist.filter((step) => step.done).length;
  const progressPercent = Math.round((completedCount / checklist.length) * 100);

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
      />

      <section className="onboarding-card" aria-label="Panduan mulai cepat">
        <div className="spread">
          <div>
            <h2>Mulai dalam 4 Langkah</h2>
            <p className="muted">
              {completedCount === checklist.length
                ? "Semua langkah dasar sudah selesai! Anda siap merencanakan musim tanam."
                : `Kemajuan awal Anda: ${completedCount} dari ${checklist.length} langkah selesai.`}
            </p>
          </div>
          <span
            className="tag"
            data-tone={completedCount === checklist.length ? "accent" : undefined}
          >
            {progressPercent}% selesai
          </span>
        </div>

        <div className="progress-track" aria-hidden="true">
          <div className="progress-fill" style={{ width: `${progressPercent}%` }} />
        </div>

        <div className="onboarding-steps">
          {checklist.map((item, idx) => (
            <div
              className="onboarding-step"
              key={item.title}
              data-done={item.done ? "true" : "false"}
            >
              <div className="onboarding-step-head">
                <span className="step-badge">{item.done ? <IconCheck size={14} /> : idx + 1}</span>
                <div>
                  <strong style={{ fontSize: "0.9rem" }}>{item.title}</strong>
                  <p className="faint" style={{ marginTop: 2 }}>
                    {item.detail}
                  </p>
                </div>
              </div>
              <Link className="btn btn-quiet btn-sm" to={item.to}>
                <span>{item.cta}</span>
                <IconArrowRight size={14} />
              </Link>
            </div>
          ))}
        </div>
      </section>

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
                  <th>Nama Kebun</th>
                  <th>Wilayah</th>
                  <th className="numeric">Jumlah Lahan</th>
                  <th>Tanggal Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {newest.map((farm) => {
                  const count = fields.filter((field) => field.farmId === farm.id).length;
                  return (
                    <tr key={farm.id}>
                      <td>
                        <strong>{farm.name}</strong>
                      </td>
                      <td className="muted">{farm.region ?? "Belum diisi"}</td>
                      <td className="numeric">{count}</td>
                      <td className="muted numeric">{farm.createdAt.slice(0, 10)}</td>
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
          <div className="card spread">
            <div>
              <h3>Rencana Tanam &amp; Asisten AI</h3>
              <p className="muted">
                Periksa apakah tanggal tanam pilihan Anda cocok dengan curah hujan dan kondisi
                lahan.
              </p>
            </div>
            <Link className="btn btn-primary btn-sm" to="/rencana">
              Buka Rencana
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Aktivitas &amp; Panen</h3>
              <p className="muted">
                Catat penanaman baru, hasil panen bertahap, serta pengamatan curah hujan atau tanah.
              </p>
            </div>
            <Link className="btn btn-quiet btn-sm" to="/aktivitas">
              <IconClipboard size={15} />
              <span>Buka Aktivitas</span>
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Cuaca &amp; Iklim</h3>
              <p className="muted">
                Lihat grafik curah hujan bulanan (12 bulan) dan prakiraan harian 0–45 hari ke depan.
              </p>
            </div>
            <Link className="btn btn-quiet btn-sm" to="/iklim">
              <IconCloud size={15} />
              <span>Lihat Cuaca</span>
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Panduan Tanaman</h3>
              <p className="muted">
                Baca daftar komoditas, fase pertumbuhan, dan syarat batas iklim yang digunakan
                sistem.
              </p>
            </div>
            <Link className="btn btn-quiet btn-sm" to="/katalog">
              <IconBook size={15} />
              <span>Buka Panduan</span>
            </Link>
          </div>
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
