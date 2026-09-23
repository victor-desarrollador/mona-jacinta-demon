import { LockKeyhole } from 'lucide-react';
import { Fragment, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router';
import { CreateProductForm } from '../components/CreateProductForm';
import { CreateVariantForm } from '../components/CreateVariantForm';
import { type Feedback, FormFeedback } from '../components/FormFeedback';
import { PriceEditor } from '../components/PriceEditor';
import { useAuth } from '../hooks/useAuth';
import { ApiError, api, type CatalogProduct, type CatalogRef } from '../lib/api';
import { canCreateProducts, canCreateVariants, canLoadInitialStock, canManagePrices } from '../lib/auth';
import { errorMessage } from '../lib/errors';
import { formatARS, formatVariant } from '../lib/utils';

const LIMIT = 20;
// GET /products caps limit at 100; the variant form's product selector reads
// the first 100 active products by name.
const OPTIONS_LIMIT = '100';

export function Products() {
  const { token, logout, user } = useAuth();
  const mayCreateProduct = canCreateProducts(user);
  const mayCreateVariant = canCreateVariants(user);
  const mayEditPrice = canManagePrices(user);

  const [items, setItems] = useState<CatalogProduct[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [blocked, setBlocked] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  const [flash, setFlash] = useState<Feedback>(null);

  const [options, setOptions] = useState<CatalogProduct[]>([]);
  const [categories, setCategories] = useState<CatalogRef[]>([]);
  const [brands, setBrands] = useState<CatalogRef[]>([]);
  const [referenceError, setReferenceError] = useState('');
  const [variantProductId, setVariantProductId] = useState('');

  const params = useMemo(() => {
    const query = new URLSearchParams({ limit: LIMIT.toString(), page: page.toString() });
    if (search.trim()) query.set('search', search.trim());
    return query;
  }, [page, search]);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    setError('');
    api
      .products(token, params, logout)
      .then((response) => {
        setItems(response.items);
        setTotal(response.pagination.total);
      })
      .catch((cause) => {
        if (cause instanceof ApiError && cause.status === 403) return setBlocked(true);
        setError(errorMessage(cause, 'No se pudieron cargar los productos.'));
      })
      .finally(() => setLoading(false));
  }, [token, params, logout, reloadKey]);

  useEffect(() => {
    if (!token || !mayCreateVariant) return;
    api
      .products(token, new URLSearchParams({ limit: OPTIONS_LIMIT }), logout)
      .then((response) => setOptions(response.items))
      .catch(() => setOptions([]));
  }, [token, logout, mayCreateVariant, reloadKey]);

  useEffect(() => {
    if (!token || !mayCreateProduct) return;
    Promise.all([api.categories(token, logout), api.brands(token, logout)])
      .then(([categoryResponse, brandResponse]) => {
        setCategories(categoryResponse.items);
        setBrands(brandResponse.items);
        setReferenceError('');
      })
      .catch((cause) => setReferenceError(errorMessage(cause, 'No se pudieron cargar categorías y marcas.')));
  }, [token, logout, mayCreateProduct]);

  const reload = () => setReloadKey((key) => key + 1);

  if (blocked) {
    return (
      <section className="empty-card">
        <LockKeyhole size={24} />
        <p className="eyebrow">Productos</p>
        <h2>Sin permiso para ver el catálogo</h2>
        <p>El backend no habilita la lectura del catálogo para la sesión actual.</p>
      </section>
    );
  }

  const readOnly = !mayCreateProduct && !mayCreateVariant && !mayEditPrice;

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Catálogo</p>
          <h2>Productos y variantes</h2>
        </div>
        <Link className="secondary-button" to="/inventario">
          {canLoadInitialStock(user) ? 'Ir a stock inicial' : 'Ver inventario'}
        </Link>
      </div>

      {readOnly ? (
        <p className="muted">Vista de solo lectura: tu sesión no tiene permisos para modificar el catálogo.</p>
      ) : null}

      {mayCreateProduct || mayCreateVariant ? (
        <div className="form-panels">
          {mayCreateProduct ? (
            <CreateProductForm
              categories={categories}
              brands={brands}
              referenceError={referenceError}
              onCreated={(product) => {
                setVariantProductId(product.id);
                setSearch('');
                setPage(1);
                reload();
              }}
            />
          ) : null}
          {mayCreateVariant ? (
            <CreateVariantForm
              products={options}
              productId={variantProductId}
              onProductChange={setVariantProductId}
              onCreated={reload}
            />
          ) : null}
        </div>
      ) : null}

      <div className="filters">
        <label htmlFor="product-search">
          Buscar
          <input
            id="product-search"
            value={search}
            onChange={(event) => { setSearch(event.target.value); setPage(1); }}
            placeholder="Producto, SKU o código de barras"
          />
        </label>
      </div>

      <FormFeedback feedback={flash} />
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      {loading ? <p className="muted" role="status">Cargando productos...</p> : null}

      {!loading && !error && items.length === 0 ? (
        <section className="empty-card">
          <h2>Sin productos</h2>
          <p>No hay productos activos para la búsqueda actual.</p>
        </section>
      ) : (
        <div className="table-card">
          <table>
            <thead>
              <tr>
                <th>Variante</th>
                <th>SKU</th>
                <th>Código de barras</th>
                <th>Precio de venta</th>
                {mayEditPrice ? <th><span className="sr-only">Acciones</span></th> : null}
              </tr>
            </thead>
            <tbody>
              {items.map((product) => (
                <Fragment key={product.id}>
                  <tr className="group-row">
                    <th scope="rowgroup" colSpan={mayEditPrice ? 5 : 4}>
                      <span>{product.name}</span>
                      <small>
                        {product.brand.name} · {product.category.name} · {product.variants.length}{' '}
                        {product.variants.length === 1 ? 'variante' : 'variantes'}
                      </small>
                      {mayCreateVariant ? (
                        <button
                          type="button"
                          className="link-button"
                          onClick={() => {
                            setVariantProductId(product.id);
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          Agregar variante
                        </button>
                      ) : null}
                    </th>
                  </tr>
                  {product.variants.length === 0 ? (
                    <tr>
                      <td colSpan={mayEditPrice ? 5 : 4} className="muted">Sin variantes activas.</td>
                    </tr>
                  ) : (
                    product.variants.map((variant) => (
                      <tr key={variant.id}>
                        <td>{formatVariant(variant.color, variant.size)}</td>
                        <td>{variant.sku}</td>
                        <td>{variant.barcode}</td>
                        <td>{formatARS(variant.price)}</td>
                        {mayEditPrice ? (
                          <td>
                            <PriceEditor
                              variant={variant}
                              onSaved={(message) => {
                                setFlash({ kind: 'success', message });
                                reload();
                              }}
                            />
                          </td>
                        ) : null}
                      </tr>
                    ))
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="pager">
        <button type="button" className="secondary-button" disabled={page === 1} onClick={() => setPage(page - 1)}>
          Anterior
        </button>
        <span>Página {page} de {Math.max(1, Math.ceil(total / LIMIT))}</span>
        <button type="button" className="secondary-button" disabled={page * LIMIT >= total} onClick={() => setPage(page + 1)}>
          Siguiente
        </button>
      </div>
    </div>
  );
}
