import { type FormEvent, useId, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type CatalogVariant, type UpdateVariantPriceBody, type VariantPricing } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { centsToPesosInput, pesosToCents } from '../lib/money';
import { formatARS } from '../lib/utils';

type Props = {
  variant: CatalogVariant;
  onSaved: (message: string) => void;
};

// Block 1: list + wholesale price management. The current prices come from
// the management read GET /api/v1/variants/:id/pricing (PRICE_MANAGE,
// COMPANY-required server side) — the ordinary catalog never carries the
// wholesale price. Changes go to PATCH /api/v1/variants/:id/price with only
// the fields that changed; an empty wholesale field clears it (null). The
// API is the only judge of the rules (positive, wholesale <= list); costPrice
// is never sent here.
export function PriceEditor({ variant, onSaved }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [current, setCurrent] = useState<VariantPricing | null>(null);
  const [listValue, setListValue] = useState('');
  const [wholesaleValue, setWholesaleValue] = useState('');
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  async function open() {
    if (!token || loading) return;
    setLoading(true);
    setError('');
    try {
      const { pricing } = await api.variantPricing(token, variant.id, logout);
      setListValue(centsToPesosInput(pricing.price));
      setWholesaleValue(pricing.wholesalePrice === null ? '' : centsToPesosInput(pricing.wholesalePrice));
      setCurrent(pricing);
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudieron cargar los precios.'));
    } finally {
      setLoading(false);
    }
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !current || submitting) return;
    const list = pesosToCents(listValue, { allowZero: false });
    if (!list.ok) return setError(`Precio de lista: ${list.error}`);
    let wholesale: string | null = null;
    if (wholesaleValue.trim()) {
      const parsed = pesosToCents(wholesaleValue, { allowZero: false });
      if (!parsed.ok) return setError(`Precio mayorista: ${parsed.error}`);
      wholesale = parsed.value;
    }
    const body: UpdateVariantPriceBody = {};
    if (list.value !== current.price) body.price = list.value;
    if (wholesale !== current.wholesalePrice) body.wholesalePrice = wholesale;
    if (Object.keys(body).length === 0) return setCurrent(null);
    setSubmitting(true);
    setError('');
    try {
      const { variant: updated } = await api.updateVariantPrice(token, variant.id, body, logout);
      setCurrent(null);
      const wholesaleLabel = (cents: string | null) => (cents === null ? 'sin precio mayorista' : formatARS(cents));
      onSaved(
        `Precios de ${updated.sku}: lista ${formatARS(updated.price)}, mayorista ${wholesaleLabel(updated.wholesalePrice)}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudieron actualizar los precios.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!current) {
    return (
      <>
        <button
          type="button"
          className="secondary-button compact"
          onClick={open}
          disabled={loading}
          aria-label={`Cambiar precios de ${variant.sku}`}
        >
          {loading ? 'Cargando…' : 'Cambiar precio'}
        </button>
        {error ? <p className="inline-error" role="alert">{error}</p> : null}
      </>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-list`}>Precio de lista (ARS)</label>
      <input
        id={`${id}-list`}
        value={listValue}
        inputMode="decimal"
        autoFocus
        aria-invalid={Boolean(error)}
        onChange={(event) => setListValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setCurrent(null);
        }}
      />
      <label htmlFor={`${id}-wholesale`}>Precio mayorista (ARS)</label>
      <input
        id={`${id}-wholesale`}
        value={wholesaleValue}
        inputMode="decimal"
        placeholder="Sin precio mayorista"
        aria-invalid={Boolean(error)}
        onChange={(event) => setWholesaleValue(event.target.value)}
      />
      <button type="submit" className="primary-button compact" disabled={submitting}>
        {submitting ? 'Guardando…' : 'Guardar'}
      </button>
      <button type="button" className="secondary-button compact" disabled={submitting} onClick={() => setCurrent(null)}>
        Cancelar
      </button>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
    </form>
  );
}
