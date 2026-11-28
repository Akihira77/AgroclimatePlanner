import { api } from "../api.js";
import { Link } from "../router.js";
import { ErrorNotice, Empty, Loading, Tag } from "../ui.js";
import { useAsync } from "../useAsync.js";

/**
 * The one screen that answers "where am I". Counts first, then the three things a
 * user came to do; no chart that has no data behind it yet.
 */
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

  return (
    <div className="stack">
      <div className="stats">
        <div className="stat">
          <span className="value">{farms.length}</span>
          <span className="label">Kebun tercatat</span>
        </div>
        <div className="stat">
          <span className="value">{fields.length}</span>
          <span className="label">Lahan dengan geometri</span>
        </div>
        <div className="stat">
          <span className="value">{activePlantings}</span>
          <span className="label">Penanaman aktif</span>
        </div>
        <div className="stat">
          <span className="value">{windows.length}</span>
          <span className="label">Jendela tanam aktif</span>
        </div>
      </div>

      <section className="section">
        <div className="section-head">
          <h2>Kebun terbaru</h2>
          <Link to="/lahan">Kelola lahan</Link>
        </div>

        {newest.length === 0 ? (
          <Empty>
            Belum ada kebun. <Link to="/lahan">Buat kebun pertama</Link> untuk mulai mencatat lahan.
          </Empty>
        ) : (
          <div className="panel">
            <table className="table">
              <thead>
                <tr>
                  <th>Nama</th>
                  <th>Wilayah</th>
                  <th>Lahan</th>
                  <th>Dibuat</th>
                </tr>
              </thead>
              <tbody>
                {newest.map((farm) => {
                  const count = fields.filter((field) => field.farmId === farm.id).length;
                  return (
                    <tr key={farm.id}>
                      <td>{farm.name}</td>
                      <td className="muted">{farm.region ?? "—"}</td>
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
        <h2>Langkah berikutnya</h2>
        <div className="card-stack">
          <div className="card spread">
            <div>
              <h3>Catat penanaman &amp; observasi</h3>
              <p className="muted">
                Kelola siklus tanam aktual, hasil panen, dan pengamatan curah hujan atau tanah.
              </p>
            </div>
            <Link className="btn btn-quiet" to="/aktivitas">
              Buka aktivitas
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Evaluasi &amp; briefing AI</h3>
              <p className="muted">
                Jalankan evaluasi kesesuaian lahan, lihat kalender tanam, dan buat briefing AI.
              </p>
            </div>
            <Link className="btn btn-quiet" to="/rencana">
              Buka rencana
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Baca horizon iklim</h3>
              <p className="muted">
                Dua belas bulan materialisasi dan 0–45 hari langsung dari catatan cuaca,
                masing-masing dengan kelas datanya.
              </p>
            </div>
            <Link className="btn btn-quiet" to="/iklim">
              Buka iklim
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Periksa rulebook komoditas</h3>
              <p className="muted">
                Tahap pertumbuhan, ambang batas, dan kutipan yang mendukung tiap ambang.
              </p>
            </div>
            <Link className="btn btn-quiet" to="/katalog">
              Buka katalog
            </Link>
          </div>

          <div className="card spread">
            <div>
              <h3>Gerbang data</h3>
              <p className="muted">
                Nilai iklim berasal dari baris fixture sampai grid produksi divalidasi.
              </p>
            </div>
            <Tag tone="warn">OPEN-18</Tag>
          </div>
        </div>
      </section>
    </div>
  );
}
