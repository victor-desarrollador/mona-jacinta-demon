import { type FormEvent, useEffect, useId, useMemo, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type Branch, type CatalogProduct } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { parseQuantity } from '../lib/money';
import { formatVariant } from '../lib/utils';
import { type Feedback, FormFeedback } from './FormFeedback';

type Props = {
  branches: Branch[];
  onLoaded: (target: { branchId: string; sku: string }) => void;
};

type VariantOption = { id: string; sku: string; label: string };

// POST /api/v1/inventory/initial-stock (IMPORT_RUN, paired server side with
// the submitted branch). ADDS quantity to physical stock through one
// INITIAL_STOCK ledger movement — it never sets an absolute value, and the
// browser never writes Inventory itself.
export function InitialStockForm({ branches, onLoaded }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [products, setProducts] = useState<CatalogProduct[]>([]);
  const [optionsError, setOptionsError] = useState('');
  const [variantId, setVariantId] = useState('');
  const [branchId, setBranchId] = useState('');
  const [quantity, setQuantity] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    if (!token) return;
    // GET /products caps limit at 100: the first 100 active products by name.
    api
      .products(token, new URLSearchParams({ limit: '100' }), logout)
      .then((response) => {
        setProducts(response.items);
        setOptionsError('');
      })
      .catch((cause) => setOptionsError(errorMessage(cause, 'No se pudieron cargar las variantes.')));
  }, [token, logout]);

  const variants = useMemo<VariantOption[]>(
    () =>
      products.flatMap((product) =>
        product.variants.map((variant) => ({
          id: variant.id,
          sku: variant.sku,
          label: `${product.name} · ${formatVariant(variant.color, variant.size)} (${variant.sku})`,
        })),
      ),
    [products],
  );

  const effectiveBranchId = branchId || (branches.length === 1 ? branches[0].id : '');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    const variant = variants.find((option) => option.id === variantId);
    const branch = branches.find((option) => option.id === effectiveBranchId);
    if (!variant) return setFeedback({ kind: 'error', message: 'Seleccioná la variante.' });
    if (!branch) return setFeedback({ kind: 'error', message: 'Seleccioná la sucursal.' });
    const parsed = parseQuantity(quantity);
    if (!parsed.ok) return setFeedback({ kind: 'error', message: parsed.error });

    setSubmitting(true);
    setFeedback(null);
    try {
      const result = await api.loadInitialStock(
        token,
        { variantId: variant.id, branchId: branch.id, quantity: parsed.value },
        logout,
      );
      setFeedback({
        kind: 'success',
        message: `Se sumaron ${result.movement.quantityDelta} u. de ${variant.sku} en ${branch.name}. Stock físico actual: ${result.inventory.physical} (reservado: ${result.inventory.reserved}).`,
      });
      setQuantity('');
      onLoaded({ branchId: branch.id, sku: variant.sku });
    } catch (cause) {
      setFeedback({ kind: 'error', message: errorMessage(cause, 'No se pudo cargar el stock.') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <div>
        <p className="eyebrow">Paso 3</p>
        <h3 id={`${id}-title`}>Carga de stock inicial</h3>
        <p className="muted">La cantidad se suma al stock físico de la sucursal elegida.</p>
      </div>
      {optionsError ? <p className="error-banner" role="alert">{optionsError}</p> : null}
      <div className="form-row wide">
        <label htmlFor={`${id}-variant`}>
          Variante
          <select id={`${id}-variant`} value={variantId} required onChange={(event) => setVariantId(event.target.value)}>
            <option value="">Seleccioná…</option>
            {variants.map((variant) => (
              <option key={variant.id} value={variant.id}>{variant.label}</option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-branch`}>
          Sucursal
          <select id={`${id}-branch`} value={effectiveBranchId} required onChange={(event) => setBranchId(event.target.value)}>
            <option value="">Seleccioná…</option>
            {branches.map((branch) => (
              <option key={branch.id} value={branch.id}>{branch.name} ({branch.code})</option>
            ))}
          </select>
        </label>
        <label htmlFor={`${id}-quantity`}>
          Cantidad a sumar
          <input
            id={`${id}-quantity`}
            value={quantity}
            inputMode="numeric"
            required
            onChange={(event) => setQuantity(event.target.value)}
            placeholder="10"
          />
        </label>
      </div>
      <FormFeedback feedback={feedback} />
      <button type="submit" className="primary-button" disabled={submitting || variants.length === 0}>
        {submitting ? 'Cargando…' : 'Sumar stock'}
      </button>
    </form>
  );
}
