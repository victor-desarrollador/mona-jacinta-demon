import { useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../lib/api';
import { useAuth } from '../hooks/useAuth';

// USER-MGMT-01 U5 — the only screen an account with a pending password change (mustChangePassword) can reach. The backend already refuses everything
// else with 403 PASSWORD_CHANGE_REQUIRED; this is the UX that follows. Only presence and confirmation are checked here: the password POLICY is the
// backend's, and its own Spanish message is shown when it refuses.
export function ForcedPasswordChange() {
  const { token, logout, adoptAccessToken } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // The barrier against a double submit is this ref (synchronous); `busy` only drives the disabled button, which React updates a render later.
  const inFlight = useRef(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlight.current || !token) return;
    if (next !== again) {
      setError('Las contraseñas nuevas no coinciden.');
      return;
    }
    inFlight.current = true;
    setBusy(true);
    setError('');
    try {
      const result = await api.changePassword(token, { currentPassword: current, newPassword: next }, logout);
      await adoptAccessToken(result.accessToken);
    } catch (cause) {
      setError(cause instanceof ApiError ? (cause.status >= 500 ? 'Ocurrió un error en el servidor. Intentá nuevamente.' : cause.message) : 'No se pudo cambiar la contraseña. Revisá la conexión e intentá nuevamente.');
      inFlight.current = false;
      setBusy(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-panel" aria-labelledby="forced-title">
        <div className="brand-mark">MJ</div>
        <p className="eyebrow">Mona Jacinta Administración</p>
        <h1 id="forced-title">Cambiar contraseña</h1>
        <p>Necesitás cambiar tu contraseña antes de continuar.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            Contraseña actual
            <input type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} required />
          </label>
          <label>
            Nueva contraseña
            <input type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} required aria-describedby="forced-hint" />
          </label>
          <label>
            Repetir nueva contraseña
            <input type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} required />
          </label>
          <p id="forced-hint" className="muted">Elegí una contraseña que no hayas usado antes. El servidor valida sus requisitos.</p>
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <button type="submit" className="primary-button" disabled={busy}>{busy ? 'Cambiando...' : 'Cambiar contraseña'}</button>
          <button type="button" className="secondary-button" onClick={logout}>Cerrar sesión</button>
        </form>
      </section>
    </main>
  );
}
