import { Eye } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type Branch, type SaleDetail, type SaleSummary } from '../lib/api';
import { cn, formatARS, formatDateTime, paymentMethodLabel, statusBadge, statusLabel } from '../lib/utils';

const LIMIT = 20;

export function SalesHistory() {
  const { token, logout } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [sales, setSales] = useState<SaleSummary[]>([]);
  const [selected, setSelected] = useState<SaleDetail | null>(null);
  const [branchId, setBranchId] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [offset, setOffset] = useState(0);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');

  const params = useMemo(() => {
    const query = new URLSearchParams({ limit: LIMIT.toString(), offset: offset.toString() });
    if (branchId) query.set('branchId', branchId);
    if (dateFrom) query.set('dateFrom', dateFrom);
    if (dateTo) query.set('dateTo', dateTo);
    return query;
  }, [branchId, dateFrom, dateTo, offset]);

  useEffect(() => {
    if (!token) return;
    api.branches(token, logout).then(({ items }) => setBranches(items)).catch(() => undefined);
  }, [token, logout]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    api
      .sales(token, params, logout)
      .then(({ items }) => setSales(items))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudieron cargar ventas.'))
      .finally(() => setLoading(false));
  }, [token, params, logout]);

  async function openDetail(id: string) {
    if (!token) return;
    setDetailLoading(true);
    setError('');
    try {
      const response = await api.saleDetail(token, id, logout);
      setSelected(response.sale);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo cargar el detalle.');
    } finally {
      setDetailLoading(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Historial</p>
          <h2>Ventas</h2>
        </div>
      </div>

      <div className="filters">
        <label>
          Sucursal
          <select value={branchId} onChange={(event) => { setBranchId(event.target.value); setOffset(0); }}>
            <option value="">Todas autorizadas</option>
            {branches.map((branch) => (
              <option value={branch.id} key={branch.id}>
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        </label>
        <label>
          Desde
          <input type="date" value={dateFrom} onChange={(event) => { setDateFrom(event.target.value); setOffset(0); }} />
        </label>
        <label>
          Hasta
          <input type="date" value={dateTo} onChange={(event) => { setDateTo(event.target.value); setOffset(0); }} />
        </label>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="muted">Cargando ventas...</p> : null}

      {!loading && sales.length === 0 ? (
        <section className="empty-card">
          <h2>Sin ventas</h2>
          <p>No hay ventas para los filtros seleccionados.</p>
        </section>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Venta</th>
                <th>Fecha</th>
                <th>Sucursal</th>
                <th>Vendedor</th>
                <th>Estado</th>
                <th>Total</th>
                <th>Pagos</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sales.map((sale) => (
                <tr key={sale.id} className={sale.status === 'COMPLETED' ? 'completed-row' : undefined}>
                  <td>{sale.saleNumber ?? sale.id.slice(0, 8)}</td>
                  <td>{formatDateTime(sale.createdAt)}</td>
                  <td>{sale.branch.name}</td>
                  <td>{sale.seller.name}</td>
                  <td><StatusBadge status={sale.status} /></td>
                  <td>{formatARS(sale.total)}</td>
                  <td>
                    {formatARS(sale.paymentSummary.paidAmount)}
                    <small>{sale.paymentSummary.methods.map(paymentMethodLabel).join(', ') || 'Sin pagos'}</small>
                  </td>
                  <td>
                    <button className="icon-button" onClick={() => openDetail(sale.id)} aria-label="Ver detalle">
                      <Eye size={17} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <button className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
          Anterior
        </button>
        <span>Página {Math.floor(offset / LIMIT) + 1}</span>
        <button className="secondary-button" disabled={sales.length < LIMIT} onClick={() => setOffset(offset + LIMIT)}>
          Siguiente
        </button>
      </div>

      {selected ? (
        <SaleDetailPanel sale={selected} loading={detailLoading} onClose={() => setSelected(null)} />
      ) : null}
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  return <span className={cn(statusBadge({ status: status as never }))}>{statusLabel(status)}</span>;
}

function SaleDetailPanel({
  sale,
  loading,
  onClose,
}: {
  sale: SaleDetail;
  loading: boolean;
  onClose: () => void;
}) {
  return (
    <section className="detail-panel">
      <div className="detail-panel-header">
        <div>
          <p className="eyebrow">Detalle de venta</p>
          <h2>{sale.saleNumber ?? sale.id}</h2>
        </div>
        <button className="secondary-button" onClick={onClose}>Cerrar</button>
      </div>
      {loading ? <p className="muted">Cargando detalle...</p> : null}
      <div className="detail-meta">
        <span>{sale.branch.name}</span>
        <span>{sale.seller.name}</span>
        <StatusBadge status={sale.status} />
        <strong>{formatARS(sale.total)}</strong>
      </div>
      <div className="split-grid">
        <section>
          <h3>Artículos</h3>
          {sale.items.map((item) => (
            <div className="line-row" key={item.id}>
              <span>
                <strong>{item.productName}</strong>
                <small>{item.variantName} | {item.sku}</small>
              </span>
              <span>{item.quantity} x {formatARS(item.unitPrice)}</span>
              <strong>{formatARS(item.subtotal)}</strong>
            </div>
          ))}
        </section>
        <section>
          <h3>Pagos</h3>
          {sale.payments.length === 0 ? <p className="muted">Sin pagos registrados.</p> : null}
          {sale.payments.map((payment) => (
            <div className="line-row" key={payment.id}>
              <span>
                <strong>{paymentMethodLabel(payment.method)}</strong>
                <small>{formatDateTime(payment.paidAt)}</small>
              </span>
              <strong>{formatARS(payment.amount)}</strong>
            </div>
          ))}
        </section>
      </div>
    </section>
  );
}
