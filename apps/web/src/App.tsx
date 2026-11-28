import type { RegisteredUser } from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api, onSessionLost } from "./api.js";
import { OnboardingTracker } from "./components/OnboardingTracker.js";
import {
  IconBook,
  IconCalendar,
  IconClipboard,
  IconCloud,
  IconHome,
  IconLeaf,
  IconLogout,
  IconMap,
  IconSettings,
} from "./icons.js";
import { Link, navigate, useRoute } from "./router.js";
import { ActivitiesPage } from "./pages/ActivitiesPage.js";
import { AuthPage } from "./pages/AuthPage.js";
import { ClimatePage } from "./pages/ClimatePage.js";
import { CropCatalogPage } from "./pages/CropCatalogPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { FarmsPage } from "./pages/FarmsPage.js";
import { PlanPage } from "./pages/PlanPage.js";
import { ErrorNotice, FieldLabel, Loading, Notice } from "./ui.js";

type Session =
  | { readonly state: "loading" }
  | { readonly state: "anonymous" }
  | { readonly state: "authenticated"; readonly user: RegisteredUser }
  | { readonly state: "failed"; readonly error: unknown };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const route = useRoute();

  useEffect(() => {
    onSessionLost(() => setSession({ state: "anonymous" }));
    return () => onSessionLost(null);
  }, []);

  useEffect(() => {
    let alive = true;
    api.me().then(
      (user) => {
        if (alive) setSession({ state: "authenticated", user });
      },
      (error: unknown) => {
        if (!alive) return;
        if (isStatus(error, 401)) setSession({ state: "anonymous" });
        else setSession({ state: "failed", error });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  const logout = async () => {
    setLogoutError(null);
    try {
      await api.logout();
      setSession({ state: "anonymous" });
      navigate("/");
    } catch (error) {
      setLogoutError(error);
    }
  };

  const deleteAccount = async () => {
    setLogoutError(null);
    try {
      await api.deleteAccount();
      setSession({ state: "anonymous" });
      navigate("/");
    } catch (error) {
      setLogoutError(error);
    }
  };

  if (session.state === "loading") {
    return (
      <div className="auth-shell">
        <Loading label="Memeriksa sesi masuk…" />
      </div>
    );
  }

  if (session.state === "failed") {
    return (
      <div className="auth-shell">
        <div className="panel" style={{ maxWidth: 460, width: "100%" }}>
          <div className="panel-body stack">
            <h1>Layanan tidak dapat dijangkau</h1>
            <ErrorNotice error={session.error} />
            <p className="muted">
              Periksa koneksi atau pastikan server API sedang berjalan. Halaman masuk tidak
              ditampilkan karena kendala berasal dari sambungan layanan, bukan sesi Anda.
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (session.state === "anonymous") {
    return (
      <AuthPage
        onAuthenticated={(user) => {
          setSession({ state: "authenticated", user });
          navigate("/");
        }}
      />
    );
  }

  return (
    <Shell
      user={session.user}
      route={route}
      onLogout={logout}
      onDeleteAccount={deleteAccount}
      logoutError={logoutError}
    />
  );
}

function isStatus(error: unknown, status: number): boolean {
  return (
    typeof error === "object" && error !== null && "status" in error && error.status === status
  );
}

function Shell({
  user,
  route,
  onLogout,
  onDeleteAccount,
  logoutError,
}: {
  readonly user: RegisteredUser;
  readonly route: ReturnType<typeof useRoute>;
  readonly onLogout: () => void;
  readonly onDeleteAccount: () => Promise<void>;
  readonly logoutError: unknown;
}) {
  const [accountOpen, setAccountOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [passwordModalOpen, setPasswordModalOpen] = useState(false);
  const [section, ...rest] = route.segments;
  const slug = rest[0];
  const current = section ?? "ringkasan";

  const meta = pageMeta(current);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark">
            <IconLeaf size={20} />
          </span>
          <div className="brand-text">
            <strong>Agroclimate</strong>
            <span>Asisten Tanam &amp; Iklim</span>
          </div>
        </div>

        <nav className="nav" aria-label="Navigasi utama">
          <Link to="/" className={navClass(current === "ringkasan")}>
            <IconHome size={18} />
            <span>Beranda</span>
          </Link>
          <Link to="/lahan" className={navClass(current === "lahan")}>
            <IconMap size={18} />
            <span>Kebun &amp; Lahan</span>
          </Link>
          <Link to="/katalog" className={navClass(current === "katalog")}>
            <IconBook size={18} />
            <span>Panduan Tanaman</span>
          </Link>
          <Link to="/rencana" className={navClass(current === "rencana")}>
            <IconCalendar size={18} />
            <span>Rencana Tanam</span>
          </Link>
          <Link to="/aktivitas" className={navClass(current === "aktivitas")}>
            <IconClipboard size={18} />
            <span>Aktivitas &amp; Panen</span>
          </Link>
          <Link to="/iklim" className={navClass(current === "iklim")}>
            <IconCloud size={18} />
            <span>Cuaca &amp; Iklim</span>
          </Link>
        </nav>

        <div className="sidebar-foot">
          <div className="user-chip">
            <span className="user-avatar" aria-hidden="true">
              {user.email.slice(0, 1)}
            </span>
            <span className="user-email">{user.email}</span>
          </div>

          <div className="sidebar-actions">
            <button className="btn-sidebar" type="button" onClick={onLogout}>
              <IconLogout size={16} />
              <span>Keluar</span>
            </button>
            <button
              className="btn-sidebar"
              type="button"
              aria-expanded={accountOpen}
              onClick={() => {
                setAccountOpen((open) => !open);
                setConfirmDelete(false);
              }}
            >
              <IconSettings size={16} />
              <span>Kelola akun</span>
            </button>
          </div>

          {accountOpen ? (
            <div className="account-drawer">
              <button
                className="btn-sidebar"
                type="button"
                onClick={() => setPasswordModalOpen(true)}
              >
                Ubah kata sandi
              </button>
              <p>
                Menghapus akun akan menonaktifkan akses Anda. Email tetap bisa didaftarkan ulang di
                kemudian hari.
              </p>
              {!confirmDelete ? (
                <button
                  className="btn-sidebar btn-sidebar-danger"
                  type="button"
                  onClick={() => setConfirmDelete(true)}
                >
                  Hapus akun
                </button>
              ) : (
                <div className="btn-row">
                  <button
                    className="btn-sidebar btn-sidebar-danger"
                    type="button"
                    onClick={() => void onDeleteAccount()}
                  >
                    Konfirmasi hapus
                  </button>
                  <button
                    className="btn-sidebar"
                    type="button"
                    onClick={() => setConfirmDelete(false)}
                  >
                    Batal
                  </button>
                </div>
              )}
            </div>
          ) : null}
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-inner">
            <div>
              <span className="eyebrow">{meta.eyebrow}</span>
              <h1>{meta.title}</h1>
              <p className="topbar-sub">{meta.subtitle}</p>
            </div>
          </div>
        </header>

        <div className="content">
          {logoutError !== null ? <ErrorNotice error={logoutError} /> : null}
          {current === "rencana" ? (
            <PlanPage />
          ) : current === "aktivitas" ? (
            <ActivitiesPage />
          ) : current === "lahan" ? (
            <FarmsPage />
          ) : current === "katalog" ? (
            <CropCatalogPage {...(slug === undefined ? {} : { slug })} />
          ) : current === "iklim" ? (
            <ClimatePage />
          ) : (
            <DashboardPage />
          )}
        </div>
      </main>
      <OnboardingTracker />
      {passwordModalOpen ? (
        <ChangePasswordModal onClose={() => setPasswordModalOpen(false)} />
      ) : null}
    </div>
  );
}

function ChangePasswordModal({ onClose }: { readonly onClose: () => void }) {
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [success, setSuccess] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setSuccess(false);

    if (newPassword !== confirmPassword) {
      setError(new Error("Konfirmasi kata sandi baru tidak cocok."));
      return;
    }

    setBusy(true);
    try {
      await api.changePassword(currentPassword, newPassword);
      setSuccess(true);
      setCurrentPassword("");
      setNewPassword("");
      setConfirmPassword("");
    } catch (failure) {
      if (isStatus(failure, 401)) {
        setError(new Error("Kata sandi saat ini tidak sesuai."));
      } else {
        setError(failure);
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        className="modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="chg-pwd-title"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="spread">
          <h2 id="chg-pwd-title">Ubah Kata Sandi</h2>
          <button type="button" className="btn btn-quiet btn-sm" onClick={onClose}>
            Tutup
          </button>
        </div>

        <form className="stack" onSubmit={submit}>
          <div className="field">
            <FieldLabel htmlFor="chg-current-pwd" label="Kata sandi saat ini" />
            <input
              id="chg-current-pwd"
              type="password"
              autoComplete="current-password"
              required
              value={currentPassword}
              onChange={(e) => setCurrentPassword(e.target.value)}
            />
          </div>

          <div className="field">
            <FieldLabel
              htmlFor="chg-new-pwd"
              label="Kata sandi baru"
              tooltip="Minimal 12 karakter dan harus berbeda dari kata sandi saat ini."
            />
            <input
              id="chg-new-pwd"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
            />
          </div>

          <div className="field">
            <FieldLabel htmlFor="chg-confirm-pwd" label="Konfirmasi kata sandi baru" />
            <input
              id="chg-confirm-pwd"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
            />
          </div>

          {error !== null ? <ErrorNotice error={error} /> : null}
          {success ? (
            <Notice tone="success">
              Kata sandi berhasil diperbarui. Sesi di perangkat lain telah dikeluarkan.
            </Notice>
          ) : null}

          <div className="btn-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Menyimpan…" : "Simpan Kata Sandi"}
            </button>
            <button type="button" className="btn btn-quiet" onClick={onClose}>
              Batal
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

function navClass(active: boolean): string {
  return active ? "nav-link is-active" : "nav-link";
}

function pageMeta(section: string): {
  readonly eyebrow: string;
  readonly title: string;
  readonly subtitle: string;
} {
  switch (section) {
    case "lahan":
      return {
        eyebrow: "Pemetaan & Profil",
        title: "Kebun & Lahan",
        subtitle:
          "Atur daftar kebun, gambar batas area lahan, dan lengkapi kondisi tanah serta pengairan.",
      };
    case "katalog":
      return {
        eyebrow: "Referensi Komoditas",
        title: "Panduan Tanaman",
        subtitle: "Pelajari fase tumbuh, perkiraan durasi panen, dan syarat iklim tiap varietas.",
      };
    case "rencana":
      return {
        eyebrow: "Analisis & Jadwal",
        title: "Rencana Tanam",
        subtitle:
          "Uji kecocokan tanggal tanam, kelola kalender, dan minta ringkasan dari Asisten AI.",
      };
    case "aktivitas":
      return {
        eyebrow: "Catatan Lapangan",
        title: "Aktivitas & Panen",
        subtitle:
          "Catat jadwal penanaman yang sedang berjalan, hasil panen bertahap, dan pengamatan cuaca.",
      };
    case "iklim":
      return {
        eyebrow: "Data Curah Hujan",
        title: "Cuaca & Iklim",
        subtitle: "Pantau perkiraan curah hujan 12 bulan ke depan dan prakiraan harian 45 hari.",
      };
    default:
      return {
        eyebrow: "Ringkasan Usaha Tani",
        title: "Beranda",
        subtitle: "Pantau kesiapan kebun Anda dan ikuti panduan langkah demi langkah.",
      };
  }
}
