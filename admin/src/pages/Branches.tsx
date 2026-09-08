import { MapPin } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type Branch } from '../lib/api';

export function Branches() {
  const { token, logout } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .branches(token, logout)
      .then(({ items }) => setBranches(items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudieron cargar sucursales.'))
      .finally(() => setLoading(false));
  }, [token, logout]);

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Alcance</p>
          <h2>Sucursales autorizadas</h2>
        </div>
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="muted">Cargando sucursales...</p> : null}
      <div className="card-grid">
        {branches.map((branch) => (
          <article className="branch-card" key={branch.id}>
            <MapPin size={20} />
            <h3>{branch.name}</h3>
            <p>{branch.address ?? 'Sin domicilio informado'}</p>
            <div>
              <span>{branch.code}</span>
              <span>Punto {branch.pointOfSaleNumber ?? '-'}</span>
            </div>
          </article>
        ))}
      </div>
    </div>
  );
}
