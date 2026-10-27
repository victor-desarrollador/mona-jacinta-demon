import { type FormEvent, useId, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type CatalogVariant, type UpdateVariantPriceBody, type VariantPricing } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { centsToPesosInput, pesosToCents } from '../lib/money';
import { adjustmentLabel, derivedListCents } from '../lib/pricing';
import { formatARS } from '../lib/utils';

type Props = {
  variant: CatalogVariant;
  // Company LIST adjustment in basis points (GET /pricing/config, PRICE_MANAGE); null when not loaded/available.
  listBps: number | null;
  onSaved: (message: string) => void;
};

// Pilot Pricing V2: the editable commercial prices are the CASH base (cashPrice) and the wholesale CASH base. LIST is NOT
// typed here: it is derived (CASH base + the company LIST adjustment) and only previewed read-only. ProductVariant.price is
// the legacy/transitional LIST value kept for compatibility; it is shown and editable only as such, never as the active
// price. Block 1: list + wholesale price management. The current prices come from
// the management read GET /api/v1/variants/:id/pricing (PRICE_MANAGE,
// COMPANY-required server side) — the ordinary catalog never carries the
// wholesale price. Changes go to PATCH /api/v1/variants/:id/price with only
// the fields that changed; an empty wholesale field clears it (null). The
// API is the only judge of the rules (positive, wholesale <= list); costPrice
// is never sent here.
export function PriceEditor({ variant, listBps, onSaved }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [current, setCurrent] = useState<VariantPricing | null>(null);
  const [cashValue, setCashValue] = useState('');
  const [legacyValue, setLegacyValue] = useState('');
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
      setCashValue(pricing.cashPrice === null ? '' : centsToPesosInput(pricing.cashPrice));
      setLegacyValue(centsToPesosInput(pricing.price));
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
    const cash = pesosToCents(cashValue, { allowZero: false });
    if (!cash.ok) return setError(`Precio efectivo: ${cash.error}`);
    const legacy = pesosToCents(legacyValue, { allowZero: false });
    if (!legacy.ok) return setError(`Precio legacy: ${legacy.error}`);
    let wholesale: string | null = null;
    if (wholesaleValue.trim()) {
      const parsed = pesosToCents(wholesaleValue, { allowZero: false });
      if (!parsed.ok) return setError(`Precio mayorista: ${parsed.error}`);
      wholesale = parsed.value;
    }
    const body: UpdateVariantPriceBody = {};
    if (cash.value !== current.cashPrice) body.cashPrice = cash.value;
    if (legacy.value !== current.price) body.price = legacy.value;
    if (wholesale !== current.wholesalePrice) body.wholesalePrice = wholesale;
    if (Object.keys(body).length === 0) return setCurrent(null);
    setSubmitting(true);
    setError('');
    try {
      const { variant: updated } = await api.updateVariantPrice(token, variant.id, body, logout);
      setCurrent(null);
      const wholesaleLabel = (cents: string | null) => (cents === null ? 'sin precio mayorista' : formatARS(cents));
      const cashLabel = updated.cashPrice === null ? 'sin precio efectivo configurado' : formatARS(updated.cashPrice);
      const list = derivedListCents(updated.cashPrice, listBps);
      const listLabel = list === null ? 'lista no disponible' : `lista derivada ${formatARS(list)}`;
      onSaved(
        `Precios de ${updated.sku}: efectivo base ${cashLabel}, ${listLabel}, mayorista ${wholesaleLabel(updated.wholesalePrice)}. Legacy ${formatARS(updated.price)}.`,
      );
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudieron actualizar los precios.'));
    } finally {
      setSubmitting(false);
    }
  }

  // Read-only preview of LIST = CASH base + company LIST adjustment (informational; the server decides every real price).
  const typedCash = cashValue.trim() ? pesosToCents(cashValue, { allowZero: false }) : null;
  const previewList = typedCash && typedCash.ok ? derivedListCents(typedCash.value, listBps) : null;
  const listPreview =
    typedCash === null || !typedCash.ok
      ? 'Precio lista derivado: cargá el precio efectivo base para calcularlo (no se usa el precio legacy).'
      : listBps === null || previewList === null
        ? 'Precio lista derivado: no disponible (falta la configuración de ajustes).'
        : `Precio lista derivado: ${formatARS(previewList)} (efectivo base ${adjustmentLabel(listBps)} de ajuste lista).`;

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
      <label htmlFor={`${id}-cash`}>Precio efectivo base (ARS)</label>
      <input
        id={`${id}-cash`}
        value={cashValue}
        inputMode="decimal"
        autoFocus
        aria-invalid={Boolean(error)}
        onChange={(event) => setCashValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setCurrent(null);
        }}
      />
      <p className="muted" id={`${id}-list-preview`}>{listPreview}</p>
      <label htmlFor={`${id}-wholesale`}>Precio mayorista efectivo (ARS)</label>
      <input
        id={`${id}-wholesale`}
        value={wholesaleValue}
        inputMode="decimal"
        placeholder="Sin precio mayorista"
        aria-invalid={Boolean(error)}
        onChange={(event) => setWholesaleValue(event.target.value)}
      />
      <label htmlFor={`${id}-legacy`}>Precio legacy transitorio (ARS) — no es el precio lista activo</label>
      <input
        id={`${id}-legacy`}
        value={legacyValue}
        inputMode="decimal"
        aria-invalid={Boolean(error)}
        onChange={(event) => setLegacyValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setCurrent(null);
        }}
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
