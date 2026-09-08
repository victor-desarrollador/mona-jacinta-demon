import { FormEvent, useState } from 'react';
import { Navigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';

export function Login() {
  const { user, loading, login } = useAuth();
  const [email, setEmail] = useState('manager01@demo.local');
  const [password, setPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  if (!loading && user) return <Navigate to="/" replace />;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await login(email, password);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo iniciar sesión.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="login-screen">
      <section className="login-panel">
        <div className="brand-mark">MJ</div>
        <p className="eyebrow">Mona Jacinta Administración</p>
        <h1>Ingreso gerencial</h1>
        <p>Usá tu usuario de gerente o administrador para consultar ventas, inventario y sucursales.</p>
        <form onSubmit={submit} className="login-form">
          <label>
            Correo
            <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" required />
          </label>
          <label>
            Contraseña
            <input
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              type="password"
              required
            />
          </label>
          {error ? <p className="error-banner">{error}</p> : null}
          <button className="primary-button" disabled={submitting}>
            {submitting ? 'Ingresando...' : 'Ingresar'}
          </button>
        </form>
      </section>
    </main>
  );
}
