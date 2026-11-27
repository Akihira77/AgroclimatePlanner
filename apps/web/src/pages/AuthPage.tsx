import type { RegisteredUser } from "@agroclimate/contracts";
import { useState } from "react";

import { ApiError, api } from "../api.js";
import { ErrorNotice, Notice } from "../ui.js";

type Mode = "login" | "register";

/**
 * Login and registration, one form, because they differ by one call.
 *
 * Registration does not issue a session (`IG-3`), so a successful registration
 * immediately logs in with the same credentials — one visible step for the user,
 * and the cookie comes from the endpoint that is allowed to set it.
 */
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
        setNotice("Akun dibuat. Masuk dengan kata sandi yang sama…");
      }
      const user = await api.login(email, password);
      onAuthenticated(user);
    } catch (failure) {
      // `CONFLICT` is the code for "this email exists" and for "this farm still has
      // fields" alike, so the wording belongs to the screen that knows which.
      setError(
        mode === "register" && failure instanceof ApiError && failure.code === "CONFLICT"
          ? new Error("Alamat email sudah terdaftar.")
          : failure,
      );
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="stack-tight">
          <span className="eyebrow">Agroclimate Planner</span>
          <h1>{mode === "login" ? "Masuk" : "Buat akun"}</h1>
          <p className="lede">
            Catat lahan, lihat horizon iklim 0–45 hari dan 12 bulan, dan periksa katalog komoditas
            yang dipakai mesin agronomi.
          </p>
        </div>

        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="email">Email</label>
            <input
              id="email"
              name="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label htmlFor="password">Kata sandi</label>
            <input
              id="password"
              name="password"
              type="password"
              autoComplete={mode === "login" ? "current-password" : "new-password"}
              required
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {mode === "register" ? <span className="hint">Minimal 12 karakter.</span> : null}
          </div>

          {error !== null ? <ErrorNotice error={error} /> : null}
          {notice !== null ? <Notice>{notice}</Notice> : null}

          <button className="btn btn-primary" type="submit" disabled={busy}>
            {busy ? "Memproses…" : mode === "login" ? "Masuk" : "Buat akun dan masuk"}
          </button>
        </form>

        <p className="auth-switch">
          {mode === "login" ? (
            <>
              Belum punya akun?{" "}
              <button type="button" onClick={() => setMode("register")}>
                Daftar
              </button>
            </>
          ) : (
            <>
              Sudah punya akun?{" "}
              <button type="button" onClick={() => setMode("login")}>
                Masuk
              </button>
            </>
          )}
        </p>
      </div>
    </div>
  );
}
