import { RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type Branch, type ExternalCollection } from '../lib/api';
import { canRefundExternalCollection } from '../lib/auth';
import { formatARS, formatDateTime, paymentMethodLabel } from '../lib/utils';

const LIMIT = 100;

const STATUS_LABEL: Record<string, string> = {
  UNAPPLIED: 'Sin imputar',
  APPLIED: 'Aplicado',
  REFUNDED: 'Devuelto',
};

// A `datetime-local` value (local time, no zone) as the ISO-8601 instant the
// API requires; null when the operator has not chosen a valid instant.
function localToIso(value: string): string | null {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function defaultLocalNow(): string {
  const now = new Date();
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function ExternalCollections() {
  const { token, user, logout } = useAuth();
  const [branches, setBranches] = useState<Branch[]>([]);
  const [branchId, setBranchId] = useState('');
  const [status, setStatus] = useState('');
  const [items, setItems] = useState<ExternalCollection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [selected, setSelected] = useState<ExternalCollection | null>(null);
  const [refundReference, setRefundReference] = useState('');
  const [externalRefundedAt, setExternalRefundedAt] = useState(defaultLocalNow);
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!token) return;
    api
      .branches(token, logout)
      .then(({ items: authorized }) => {
        setBranches(authorized);
        setBranchId((current) => current || authorized[0]?.id || '');
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudieron cargar sucursales.'));
  }, [token, logout]);

  const params = useMemo(() => {
    const query = new URLSearchParams({ limit: String(LIMIT) });
    if (branchId) query.set('branchId', branchId);
    if (status) query.set('status', status);
    return query;
  }, [branchId, status]);

  const load = useCallback(() => {
    if (!token || !branchId) {
      setItems([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError('');
    api
      .externalCollections(token, params, logout)
      .then(({ items: rows }) => setItems(rows))
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudieron cargar los cobros externos.'))
      .finally(() => setLoading(false));
  }, [token, branchId, params, logout]);

  useEffect(() => { load(); }, [load]);

  function openRefund(collection: ExternalCollection) {
    setSelected(collection);
    setNotice('');
    setError('');
    setRefundReference('');
    setExternalRefundedAt(defaultLocalNow());
    setReason('');
  }

  async function submitRefund() {
    if (!token || !selected) return;
    const iso = localToIso(externalRefundedAt);
    if (!iso) {
      setError('Elegí una fecha y hora válidas para la devolución.');
      return;
    }
    if (reason.trim().length < 10) {
      setError('El motivo debe tener al menos 10 caracteres.');
      return;
    }
    setSaving(true);
    setError('');
    try {
      const result = await api.refundExternalCollection(token, selected.id, {
        refundReference: refundReference.trim(),
        externalRefundedAt: iso,
        reason: reason.trim(),
      }, logout);
      setNotice(result.replayed ? 'La devolución ya estaba registrada; no se modificó nada.' : 'Devolución registrada.');
      setSelected(null);
      load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'No se pudo registrar la devolución.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Cobros</p>
          <h2>Cobros externos</h2>
        </div>
      </div>

      <div className="filters">
        <label>
          Sucursal
          <select value={branchId} onChange={(event) => setBranchId(event.target.value)}>
            {branches.map((branch) => (
              <option value={branch.id} key={branch.id}>
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        </label>
        <label>
          Estado
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="">Todos</option>
            <option value="UNAPPLIED">Sin imputar</option>
            <option value="APPLIED">Aplicado</option>
            <option value="REFUNDED">Devuelto</option>
          </select>
        </label>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {notice ? <p className="muted">{notice}</p> : null}
      {loading ? <p className="muted">Cargando cobros externos...</p> : null}

      {!loading && items.length === 0 ? (
        <section className="empty-card">
          <h2>Sin cobros externos</h2>
          <p>No hay cobros externos para los filtros seleccionados.</p>
        </section>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Referencia</th>
                <th>Medio</th>
                <th>Importe</th>
                <th>Estado</th>
                <th>Registrado</th>
                <th>Devolución</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {items.map((collection) => (
                <tr key={collection.id}>
                  <td>{collection.reference}</td>
                  <td>
                    {paymentMethodLabel(collection.method)}
                    {collection.institution ? <small>{collection.institutionOther ?? collection.institution}</small> : null}
                  </td>
                  <td>{formatARS(collection.amount)}</td>
                  <td>{STATUS_LABEL[collection.status] ?? collection.status}</td>
                  <td>{formatDateTime(collection.recordedAt)}</td>
                  <td>
                    {collection.status === 'REFUNDED'
                      ? `${collection.refundReference ?? ''} · ${collection.externalRefundedAt ? formatDateTime(collection.externalRefundedAt) : ''}`
                      : '—'}
                  </td>
                  <td>
                    {collection.status === 'UNAPPLIED' && canRefundExternalCollection(user, collection.branchId) ? (
                      <button className="icon-button" onClick={() => openRefund(collection)} aria-label="Registrar devolución">
                        <RotateCcw size={17} />
                      </button>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected ? (
        <section className="detail-panel">
          <div className="detail-panel-header">
            <div>
              <p className="eyebrow">Devolución externa</p>
              <h2>{selected.reference}</h2>
            </div>
            <button className="secondary-button" onClick={() => setSelected(null)}>Cerrar</button>
          </div>
          <div className="detail-meta">
            <span>{paymentMethodLabel(selected.method)}</span>
            <strong>{formatARS(selected.amount)}</strong>
          </div>
          <div className="filters">
            <label>
              Fecha y hora de la devolución
              <input type="datetime-local" value={externalRefundedAt} onChange={(event) => setExternalRefundedAt(event.target.value)} />
            </label>
            <label>
              Referencia de la devolución
              <input value={refundReference} onChange={(event) => setRefundReference(event.target.value)} placeholder="Ej.: DV-2026-001" />
            </label>
          </div>
          <label>
            Motivo
            <textarea value={reason} onChange={(event) => setReason(event.target.value)} rows={3} />
          </label>
          <div className="pager">
            <button className="secondary-button" onClick={() => setSelected(null)} disabled={saving}>Cancelar</button>
            <button className="secondary-button" onClick={submitRefund} disabled={saving}>
              {saving ? 'Registrando...' : 'Registrar devolución'}
            </button>
          </div>
        </section>
      ) : null}
    </div>
  );
}
