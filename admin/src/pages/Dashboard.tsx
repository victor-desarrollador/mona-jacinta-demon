import { AlertTriangle, Banknote, Clock3, ReceiptText } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type DashboardSummary } from '../lib/api';
import { formatARS } from '../lib/utils';

export function Dashboard() {
  const { token, logout } = useAuth();
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api
      .dashboard(token, logout)
      .then(setSummary)
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudo cargar el panel principal.'))
      .finally(() => setLoading(false));
  }, [token, logout]);

  if (loading) return <p className="muted">Cargando panel principal...</p>;
  if (error) return <p className="error-banner">{error}</p>;
  if (!summary) return <p className="muted">Sin datos disponibles.</p>;

  const cards = [
    { label: 'Ventas de hoy', value: summary.salesToday.toString(), icon: ReceiptText },
    { label: 'Ventas pendientes', value: summary.pendingSalesCount.toString(), icon: Clock3 },
    { label: 'Ingresos de hoy', value: formatARS(summary.revenueToday), icon: Banknote },
    { label: 'Stock bajo', value: summary.lowStockCount.toString(), icon: AlertTriangle },
  ];

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Resumen</p>
          <h2>Operación actual</h2>
        </div>
      </div>
      <div className="metric-grid">
        {cards.map((card) => (
          <article className="metric-card" key={card.label}>
            <card.icon size={22} />
            <span>{card.label}</span>
            <strong>{card.value}</strong>
          </article>
        ))}
      </div>
    </div>
  );
}
