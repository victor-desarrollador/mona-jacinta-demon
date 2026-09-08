import { LockKeyhole } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { ApiError, api, type BackofficeUser } from '../lib/api';
import { roleLabel } from '../lib/utils';

export function Users({ forbidden = false }: { forbidden?: boolean }) {
  const { token, logout } = useAuth();
  const [users, setUsers] = useState<BackofficeUser[]>([]);
  const [loading, setLoading] = useState(!forbidden);
  const [blocked, setBlocked] = useState(forbidden);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token || forbidden) return;
    setLoading(true);
    setError('');
    api
      .users(token, logout)
      .then(({ items }) => setUsers(items))
      .catch((cause) => {
        if (cause instanceof ApiError && cause.status === 403) {
          setBlocked(true);
          return;
        }
        setError(cause instanceof Error ? cause.message : 'No se pudieron cargar usuarios.');
      })
      .finally(() => setLoading(false));
  }, [token, logout, forbidden]);

  if (blocked) {
    return (
      <section className="empty-card">
        <LockKeyhole size={24} />
        <p className="eyebrow">Usuarios</p>
        <h2>Sin permiso USER_MANAGE</h2>
        <p>El backend no habilita esta pantalla para la sesión actual.</p>
      </section>
    );
  }

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Administración</p>
          <h2>Usuarios</h2>
        </div>
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="muted">Cargando usuarios...</p> : null}
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Correo</th>
              <th>Estado</th>
              <th>Roles</th>
              <th>Sucursales</th>
            </tr>
          </thead>
          <tbody>
            {users.map((user) => (
              <tr key={user.id}>
                <td>{user.name}</td>
                <td>{user.email}</td>
                <td>{user.isActive ? 'Activo' : 'Inactivo'}</td>
                <td>{user.roles.map((role) => roleLabel(role.code)).join(', ')}</td>
                <td>{user.branches.map((branch) => branch.code).join(', ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
