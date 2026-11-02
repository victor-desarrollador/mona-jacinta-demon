"use client";

import { useRef, useState } from "react";
import { CodedApiError, apiRequestCoded } from "../lib/api";

// USER-MGMT-01 U5 — the only screen an account with a pending password change (mustChangePassword) can reach. The backend refuses everything else with
// 403 PASSWORD_CHANGE_REQUIRED; this is the UX that follows. Only presence and confirmation are checked here: the password POLICY belongs to the
// backend, whose own Spanish message is shown when it refuses. On success the NEW access token is handed to the page, which replaces the old one.
export default function ForcedPasswordChange({
  token,
  onChanged,
  onLogout,
}: {
  token: string | null;
  onChanged: (accessToken: string) => Promise<void>;
  onLogout: () => void;
}) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  // The barrier against a double submit is this ref (synchronous); `busy` only drives the disabled button, which React updates a render later.
  const inFlight = useRef(false);

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !token) return;
    if (next !== again) {
      setError("Las contraseñas nuevas no coinciden.");
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const result = (await apiRequestCoded("/auth/change-password", token, {
        method: "POST",
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      })) as { accessToken: string };
      await onChanged(result.accessToken);
    } catch (cause) {
      setError(
        cause instanceof CodedApiError
          ? (cause.status !== null && cause.status >= 500 ? "Ocurrió un error en el servidor. Intentá nuevamente." : cause.message)
          : "No se pudo cambiar la contraseña. Revisá la conexión e intentá nuevamente.",
      );
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="auth-shell">
      <section className="auth-panel" aria-labelledby="forced-title">
        <div className="brand-mark">MJ</div>
        <p className="eyebrow">Mona Jacinta Operaciones</p>
        <h1 id="forced-title">Cambiar contraseña</h1>
        <p className="muted">Necesitás cambiar tu contraseña antes de continuar.</p>
        <form className="login-form" onSubmit={submit}>
          <label>
            Contraseña actual
            <input autoComplete="current-password" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required />
          </label>
          <label>
            Nueva contraseña
            <input autoComplete="new-password" type="password" value={next} onChange={(event) => setNext(event.target.value)} required aria-describedby="forced-hint" />
          </label>
          <label>
            Repetir nueva contraseña
            <input autoComplete="new-password" type="password" value={again} onChange={(event) => setAgain(event.target.value)} required />
          </label>
          <p id="forced-hint" className="muted">Elegí una contraseña que no hayas usado antes. El servidor valida sus requisitos.</p>
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <button className="primary-button" type="submit" disabled={busy}>{busy ? "Cambiando..." : "Cambiar contraseña"}</button>
          <button className="text-button" type="button" onClick={onLogout}>Salir</button>
        </form>
      </section>
    </main>
  );
}
