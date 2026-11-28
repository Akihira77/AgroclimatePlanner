import type { RegisteredUser } from "@agroclimate/contracts";
import { useEffect, useState } from "react";

import { api, onSessionLost } from "./api.js";
import { Link, navigate, useRoute } from "./router.js";
import { ActivitiesPage } from "./pages/ActivitiesPage.js";
import { AuthPage } from "./pages/AuthPage.js";
import { ClimatePage } from "./pages/ClimatePage.js";
import { CropCatalogPage } from "./pages/CropCatalogPage.js";
import { DashboardPage } from "./pages/DashboardPage.js";
import { FarmsPage } from "./pages/FarmsPage.js";
import { PlanPage } from "./pages/PlanPage.js";
import { ErrorNotice, Loading } from "./ui.js";

type Session =
  | { readonly state: "loading" }
  | { readonly state: "anonymous" }
  | { readonly state: "authenticated"; readonly user: RegisteredUser }
  | { readonly state: "failed"; readonly error: unknown };

export function App() {
  const [session, setSession] = useState<Session>({ state: "loading" });
  const [logoutError, setLogoutError] = useState<unknown>(null);
  const route = useRoute();

  // A session that expires while the user works must leave the shell, not paint
  // "Sesi berakhir" over a page it can no longer load.
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
        // Anything but a 401 is a real failure, not "logged out": showing the form
        // would hide a broken API behind a login screen.
        if (isStatus(error, 401)) setSession({ state: "anonymous" });
        else setSession({ state: "failed", error });
      },
    );
    return () => {
      alive = false;
    };
  }, []);

  /**
   * Only a revoked session is a logout. A failed call leaves the cookie and the
   * server-side row in place, so claiming success would leave a shared machine
   * signed in while the screen said otherwise.
   */
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
        <Loading label="Memeriksa sesi…" />
      </div>
    );
  }

  if (session.state === "failed") {
    return (
      <div className="auth-shell">
        <div className="auth-card">
          <h1>Tidak dapat menghubungi API</h1>
          <ErrorNotice error={session.error} />
          <p className="muted">
            Periksa alamat API dan apakah prosesnya berjalan. Layar masuk tidak ditampilkan karena
            masalahnya bukan sesi.
          </p>
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
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [section, ...rest] = route.segments;
  const slug = rest[0];
  const current = section ?? "ringkasan";

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <strong>Agroclimate</strong>
          <span>Planner</span>
        </div>

        <nav className="nav" aria-label="Navigasi utama">
          <Link to="/" className={navClass(current === "ringkasan")}>
            Ringkasan
          </Link>
          <Link to="/lahan" className={navClass(current === "lahan")}>
            Lahan
          </Link>
          <Link to="/katalog" className={navClass(current === "katalog")}>
            Katalog
          </Link>
          <Link to="/rencana" className={navClass(current === "rencana")}>
            Rencana
          </Link>
          <Link to="/aktivitas" className={navClass(current === "aktivitas")}>
            Aktivitas
          </Link>
          <Link to="/iklim" className={navClass(current === "iklim")}>
            Iklim
          </Link>
        </nav>

        <div className="sidebar-foot">
          <span className="email">{user.email}</span>
          <div className="btn-row">
            <button className="btn btn-quiet" type="button" onClick={onLogout}>
              Keluar
            </button>
            {!confirmDelete ? (
              <button
                className="btn btn-danger"
                type="button"
                onClick={() => setConfirmDelete(true)}
              >
                Hapus akun
              </button>
            ) : (
              <>
                <button
                  className="btn btn-danger"
                  type="button"
                  onClick={() => void onDeleteAccount()}
                >
                  Konfirmasi hapus
                </button>
                <button
                  className="btn btn-quiet"
                  type="button"
                  onClick={() => setConfirmDelete(false)}
                >
                  Batal
                </button>
              </>
            )}
          </div>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="stack-tight">
            <span className="eyebrow">{sectionTitle(current)}</span>
            <h1>{headline(current)}</h1>
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
    </div>
  );
}

function navClass(active: boolean): string {
  return active ? "nav-link is-active" : "nav-link";
}

function sectionTitle(section: string): string {
  switch (section) {
    case "lahan":
      return "Kebun dan lahan";
    case "katalog":
      return "Katalog komoditas";
    case "iklim":
      return "Horizon iklim";
    case "rencana":
      return "Rencana & evaluasi tanam";
    case "aktivitas":
      return "Catatan aktivitas lapangan";
    default:
      return "Ringkasan";
  }
}

function headline(section: string): string {
  if (section === "katalog") return "Katalog";
  if (section === "lahan") return "Lahan";
  if (section === "iklim") return "Iklim";
  if (section === "rencana") return "Rencana";
  if (section === "aktivitas") return "Aktivitas";
  return "Ringkasan";
}
