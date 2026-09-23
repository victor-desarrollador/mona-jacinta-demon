import { type FormEvent, useId, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type CatalogVariant } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { centsToPesosInput, pesosToCents } from '../lib/money';
import { formatARS } from '../lib/utils';

type Props = {
  variant: CatalogVariant;
  onSaved: (message: string) => void;
};

// PATCH /api/v1/variants/:id/price (PRICE_MANAGE, COMPANY-required server
// side). Changes the SELL price only; the API rejects costPrice here.
export function PriceEditor({ variant, onSaved }: Props) {
  const { token, logout } = useAuth();
  const id = useId();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  function open() {
    setValue(centsToPesosInput(variant.price));
    setError('');
    setEditing(true);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || submitting) return;
    const cents = pesosToCents(value, { allowZero: false });
    if (!cents.ok) return setError(cents.error);
    if (cents.value === variant.price) return setEditing(false);
    setSubmitting(true);
    setError('');
    try {
      const { variant: updated } = await api.updateVariantPrice(token, variant.id, cents.value, logout);
      setEditing(false);
      onSaved(`Precio de venta de ${updated.sku}: ${formatARS(variant.price)} → ${formatARS(updated.price)}.`);
    } catch (cause) {
      setError(errorMessage(cause, 'No se pudo actualizar el precio.'));
    } finally {
      setSubmitting(false);
    }
  }

  if (!editing) {
    return (
      <button type="button" className="secondary-button compact" onClick={open} aria-label={`Cambiar precio de venta de ${variant.sku}`}>
        Cambiar precio
      </button>
    );
  }

  return (
    <form className="inline-form" onSubmit={submit} noValidate>
      <label htmlFor={`${id}-price`} className="sr-only">
        Nuevo precio de venta de {variant.sku} (ARS)
      </label>
      <input
        id={`${id}-price`}
        value={value}
        inputMode="decimal"
        autoFocus
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setEditing(false);
        }}
      />
      <button type="submit" className="primary-button compact" disabled={submitting}>
        {submitting ? 'Guardando…' : 'Guardar'}
      </button>
      <button type="button" className="secondary-button compact" disabled={submitting} onClick={() => setEditing(false)}>
        Cancelar
      </button>
      {error ? <p className="inline-error" id={`${id}-error`} role="alert">{error}</p> : null}
    </form>
  );
}
