import { useEffect, useMemo, useState } from 'react';
import { InitialStockForm } from '../components/InitialStockForm';
import { useAuth } from '../hooks/useAuth';
import { api, type Branch, type InventoryRow } from '../lib/api';
import { canLoadInitialStock } from '../lib/auth';
import { cn, formatARS, formatVariant, isLowStock } from '../lib/utils';

const LIMIT = 50;

export function Inventory() {
  const { token, logout, user } = useAuth();
  const mayLoadStock = canLoadInitialStock(user);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [items, setItems] = useState<InventoryRow[]>([]);
  const [branchId, setBranchId] = useState('');
  const [search, setSearch] = useState('');
  const [offset, setOffset] = useState(0);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [reloadKey, setReloadKey] = useState(0);

  const params = useMemo(() => {
    const query = new URLSearchParams({ limit: LIMIT.toString(), offset: offset.toString() });
    if (branchId) query.set('branchId', branchId);
    if (search.trim()) query.set('search', search.trim());
    return query;
  }, [branchId, search, offset]);

  useEffect(() => {
    if (!token) return;
    api.branches(token, logout).then(({ items }) => setBranches(items)).catch(() => undefined);
  }, [token, logout]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    api
      .inventory(token, params, logout)
      .then((response) => {
        setItems(response.items);
        setTotal(response.pagination.total);
      })
      .catch((cause) => setError(cause instanceof Error ? cause.message : 'No se pudo cargar inventario.'))
      .finally(() => setLoading(false));
  }, [token, params, logout, reloadKey]);

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Stock</p>
          <h2>Inventario por sucursal</h2>
        </div>
      </div>

      {mayLoadStock ? (
        <InitialStockForm
          branches={branches}
          onLoaded={(target) => {
            // Re-read the server state for the loaded row instead of
            // patching it locally.
            setBranchId(target.branchId);
            setSearch(target.sku);
            setOffset(0);
            setReloadKey((key) => key + 1);
          }}
        />
      ) : null}

      <div className="filters">
        <label htmlFor="inventory-branch">
          Sucursal
          <select id="inventory-branch" value={branchId} onChange={(event) => { setBranchId(event.target.value); setOffset(0); }}>
            <option value="">Todas autorizadas</option>
            {branches.map((branch) => (
              <option value={branch.id} key={branch.id}>
                {branch.name} ({branch.code})
              </option>
            ))}
          </select>
        </label>
        <label htmlFor="inventory-search">
          Buscar
          <input
            id="inventory-search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setOffset(0); }}
            placeholder="Producto, SKU, color o talle"
          />
        </label>
      </div>

      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="muted">Cargando inventario...</p> : null}

      {!loading && items.length === 0 ? (
        <section className="empty-card">
          <h2>Sin inventario</h2>
          <p>No hay resultados para los filtros seleccionados.</p>
        </section>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Sucursal</th>
                <th>Producto</th>
                <th>Variante</th>
                <th>SKU</th>
                <th>Precio</th>
                <th>Fisico</th>
                <th>Reservado</th>
                <th>Disponible</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id}>
                  <td>{item.branch.name}</td>
                  <td>{item.product.name}</td>
                  <td>{formatVariant(item.variant.color, item.variant.size)}</td>
                  <td>{item.variant.sku}</td>
                  <td>{formatARS(item.variant.price)}</td>
                  <td>{item.physical}</td>
                  <td>{item.reserved}</td>
                  <td>
                    <span className={cn('stock-pill', isLowStock(item.available) && 'low')}>
                      {item.available}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <button type="button" className="secondary-button" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - LIMIT))}>
          Anterior
        </button>
        <span>{offset + items.length} de {total}</span>
        <button type="button" className="secondary-button" disabled={offset + LIMIT >= total} onClick={() => setOffset(offset + LIMIT)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}
