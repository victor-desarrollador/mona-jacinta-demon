import { type FormEvent, useId, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type CatalogProduct } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { pesosToCents } from '../lib/money';
import { formatARS } from '../lib/utils';
import { type Feedback, FormFeedback } from './FormFeedback';

type Props = {
  products: CatalogProduct[];
  productId: string;
  onProductChange: (productId: string) => void;
  onCreated: () => void;
};

// POST /api/v1/variants (PRODUCT_VARIANT_MANAGE, COMPANY-required server
// side). Required: productId, sku, barcode, price (> 0), costPrice (>= 0);
// color/size optional. Money leaves this form as integer-cent strings.
export function CreateVariantForm({ products, productId, onProductChange, onCreated }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [sku, setSku] = useState('');
  const [barcode, setBarcode] = useState('');
  const [color, setColor] = useState('');
  const [size, setSize] = useState('');
  const [price, setPrice] = useState('');
  const [costPrice, setCostPrice] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    if (!productId) return setFeedback({ kind: 'error', message: 'Seleccioná el producto.' });
    if (!sku.trim() || !barcode.trim()) {
      return setFeedback({ kind: 'error', message: 'SKU y código de barras son obligatorios.' });
    }
    const priceCents = pesosToCents(price, { allowZero: false });
    if (!priceCents.ok) return setFeedback({ kind: 'error', message: `Precio de venta: ${priceCents.error}` });
    const costCents = pesosToCents(costPrice, { allowZero: true });
    if (!costCents.ok) return setFeedback({ kind: 'error', message: `Costo: ${costCents.error}` });

    setSubmitting(true);
    setFeedback(null);
    try {
      const { variant } = await api.createVariant(
        token,
        {
          productId,
          sku: sku.trim(),
          barcode: barcode.trim(),
          ...(color.trim() ? { color: color.trim() } : {}),
          ...(size.trim() ? { size: size.trim() } : {}),
          price: priceCents.value,
          costPrice: costCents.value,
        },
        logout,
      );
      setFeedback({
        kind: 'success',
        message: `Variante ${variant.sku} creada a ${formatARS(variant.price)}. Cargá su stock inicial en Inventario.`,
      });
      setSku('');
      setBarcode('');
      setColor('');
      setSize('');
      setPrice('');
      setCostPrice('');
      onCreated();
    } catch (cause) {
      setFeedback({ kind: 'error', message: errorMessage(cause, 'No se pudo crear la variante.') });
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} aria-labelledby={`${id}-title`} noValidate>
      <div>
        <p className="eyebrow">Paso 2</p>
        <h3 id={`${id}-title`}>Nueva variante</h3>
      </div>
      <label htmlFor={`${id}-product`}>
        Producto
        <select id={`${id}-product`} value={productId} required onChange={(event) => onProductChange(event.target.value)}>
          <option value="">Seleccioná…</option>
          {products.map((product) => (
            <option key={product.id} value={product.id}>
              {product.name} · {product.brand.name}
            </option>
          ))}
        </select>
      </label>
      <div className="form-row">
        <label htmlFor={`${id}-sku`}>
          SKU
          <input id={`${id}-sku`} value={sku} maxLength={64} required onChange={(event) => setSku(event.target.value)} placeholder="VES-LIN-M" />
        </label>
        <label htmlFor={`${id}-barcode`}>
          Código de barras
          <input
            id={`${id}-barcode`}
            value={barcode}
            maxLength={64}
            required
            onChange={(event) => setBarcode(event.target.value)}
            placeholder="7790000000000"
          />
        </label>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-color`}>
          Color (opcional)
          <input id={`${id}-color`} value={color} maxLength={60} onChange={(event) => setColor(event.target.value)} />
        </label>
        <label htmlFor={`${id}-size`}>
          Talle (opcional)
          <input id={`${id}-size`} value={size} maxLength={30} onChange={(event) => setSize(event.target.value)} />
        </label>
      </div>
      <div className="form-row">
        <label htmlFor={`${id}-price`}>
          Precio de venta (ARS)
          <input
            id={`${id}-price`}
            value={price}
            inputMode="decimal"
            required
            aria-describedby={`${id}-money-hint`}
            onChange={(event) => setPrice(event.target.value)}
            placeholder="45000,00"
          />
        </label>
        <label htmlFor={`${id}-cost`}>
          Costo (ARS)
          <input
            id={`${id}-cost`}
            value={costPrice}
            inputMode="decimal"
            required
            aria-describedby={`${id}-money-hint`}
            onChange={(event) => setCostPrice(event.target.value)}
            placeholder="25000,00"
          />
        </label>
      </div>
      <span className="field-hint" id={`${id}-money-hint`}>
        Importes en pesos, sin separador de miles, hasta 2 decimales. El costo puede ser 0.
      </span>
      <FormFeedback feedback={feedback} />
      <button type="submit" className="primary-button" disabled={submitting || products.length === 0}>
        {submitting ? 'Creando…' : 'Crear variante'}
      </button>
    </form>
  );
}
