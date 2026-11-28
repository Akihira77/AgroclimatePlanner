import type { RegisteredUser } from "@agroclimate/contracts";
import { useState } from "react";

import { ApiError, api } from "../api.js";
import { IconCalendar, IconClipboard, IconLeaf, IconMap } from "../icons.js";
import { ErrorNotice, Notice } from "../ui.js";

type Mode = "login" | "register";

export function AuthPage({
  onAuthenticated,
}: {
  readonly onAuthenticated: (user: RegisteredUser) => void;
}) {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    setNotice(null);

    try {
      if (mode === "register") {
        await api.register(email, password);
        setNotice("Akun berhasil dibuat. Sedang masuk ke aplikasi…");
      }
      const user = await api.login(email, password);
      onAuthenticated(user);
    } catch (failure) {
      setError(
        mode === "register" && failure instanceof ApiError && failure.code === "CONFLICT"
          ? new Error(
              "Alamat email ini sudah terdaftar. Silakan masuk menggunakan kata sandi Anda.",
            )
          : failure,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-split">
        <section className="auth-hero" aria-label="Pengenalan Agroclimate Planner">
          <div className="brand">
            <span className="brand-mark">
              <IconLeaf size={20} />
            </span>
            <div className="brand-text">
              <strong>Agroclimate Planner</strong>
              <span>Asisten Tanam &amp; Iklim</span>
            </div>
          </div>

          <div className="stack">
            <h2>Rencanakan waktu tanam lebih tenang berdasarkan kondisi iklim lahan Anda.</h2>
            <ul className="auth-hero-list">
              <li>
                <IconMap size={18} />
                <span>Petakan batas kebun, jenis tanah, dan ketersediaan irigasi tiap lahan.</span>
              </li>
              <li>
                <IconCalendar size={18} />
                <span>
                  Uji kecocokan tanggal tanam terhadap prakiraan hujan dan minta penjelasan Asisten
                  AI.
                </span>
              </li>
              <li>
                <IconClipboard size={18} />
                <span>Catat penanaman, hasil panen bertahap, dan pengamatan cuaca harian.</span>
              </li>
            </ul>
          </div>

          <p style={{ fontSize: "0.8125rem", color: "var(--sidebar-muted)" }}>
            Dirancang untuk petani, pendamping lapang, dan pengelola kebun.
          </p>
        </section>

        <section className="auth-card">
          <div className="stack-tight">
            <span className="eyebrow">
              {mode === "login" ? "Selamat datang kembali" : "Mulai gratis"}
            </span>
            <h1>{mode === "login" ? "Masuk ke Akun" : "Buat Akun Baru"}</h1>
            <p className="muted">
              {mode === "login"
                ? "Masukkan email dan kata sandi Anda untuk membuka data kebun dan rencana tanam."
                : "Daftarkan email Anda untuk mulai mencatat kebun dan menilai jadwal tanam."}
            </p>
          </div>

          <form onSubmit={submit}>
            <div className="field">
              <label htmlFor="email">Alamat Email</label>
              <input
                id="email"
                name="email"
                type="email"
                autoComplete="email"
                placeholder="nama@contoh.com"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            </div>

            <div className="field">
              <label htmlFor="password">Kata Sandi</label>
              <input
                id="password"
                name="password"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                placeholder={mode === "register" ? "Minimal 12 karakter" : "Masukkan kata sandi"}
                required
                value={password}
                onChange={(event) => setPassword(event.target.value)}
              />
              {mode === "register" ? (
                <span className="hint">Gunakan minimal 12 karakter agar akun aman.</span>
              ) : null}
            </div>

            {error !== null ? <ErrorNotice error={error} /> : null}
            {notice !== null ? <Notice tone="success">{notice}</Notice> : null}

            <button className="btn btn-primary" type="submit" disabled={busy}>
              {busy ? "Memproses…" : mode === "login" ? "Masuk" : "Buat akun dan masuk"}
            </button>
          </form>

          <p className="auth-switch">
            {mode === "login" ? (
              <>
                Belum punya akun?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("register");
                    setError(null);
                  }}
                >
                  Daftar di sini
                </button>
              </>
            ) : (
              <>
                Sudah punya akun?{" "}
                <button
                  type="button"
                  onClick={() => {
                    setMode("login");
                    setError(null);
                  }}
                >
                  Masuk di sini
                </button>
              </>
            )}
          </p>
        </section>
      </div>
    </div>
  );
}
