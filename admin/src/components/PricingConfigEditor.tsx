import { type FormEvent, useEffect, useState } from 'react';
import { useAuth } from '../hooks/useAuth';
import { api, type PriceMode, type PricingConfig } from '../lib/api';
import { errorMessage } from '../lib/errors';
import { type Feedback, FormFeedback } from './FormFeedback';

const MODES: Array<{ mode: Exclude<PriceMode, 'CASH'>; label: string }> = [
  { mode: 'LIST', label: 'Lista' },
  { mode: 'CREDIT_CARD', label: 'Tarjeta crédito' },
  { mode: 'DEBIT_CARD', label: 'Tarjeta débito' },
  { mode: 'BANK_TRANSFER', label: 'Transferencia' },
  { mode: 'QR', label: 'QR' },
];

function percentToBps(value: string) {
  const normalized = value.trim().replace(',', '.');
  if (!/^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$/.test(normalized)) return null;
  const [whole, decimal = ''] = normalized.split('.');
  const bps = Number(whole) * 100 + Number(decimal.padEnd(2, '0'));
  return Number.isSafeInteger(bps) && bps >= 0 && bps <= 10000 ? bps : null;
}

function bpsToPercent(value: number) {
  return (value / 100).toFixed(value % 100 === 0 ? 0 : 2);
}

export function PricingConfigEditor({ onSaved }: { onSaved?: () => void } = {}) {
  const { token, logout } = useAuth();
  const [config, setConfig] = useState<PricingConfig | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState<Feedback>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) return;
    setLoading(true);
    api.pricingConfig(token, logout)
      .then(({ config: next }) => {
        setConfig(next);
        setValues(Object.fromEntries(MODES.map(({ mode }) => [mode, bpsToPercent(next.adjustmentsBps[mode])])));
      })
      .catch((cause) => setFeedback({ kind: 'error', message: errorMessage(cause, 'No se pudo cargar la configuración de precios.') }))
      .finally(() => setLoading(false));
  }, [token, logout]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!token || !config) return;
    const body: Partial<Record<Exclude<PriceMode, 'CASH'>, number>> = {};
    for (const { mode } of MODES) {
      const bps = percentToBps(values[mode] ?? '');
      if (bps === null) return setFeedback({ kind: 'error', message: 'Usá porcentajes entre 0 y 100 con hasta 2 decimales.' });
      if (bps !== config.adjustmentsBps[mode]) body[mode] = bps;
    }
    if (Object.keys(body).length === 0) return setFeedback({ kind: 'success', message: 'La configuración no cambió.' });
    setLoading(true);
    setFeedback(null);
    try {
      const { config: next } = await api.updatePricingConfig(token, body, logout);
      setConfig(next);
      setValues(Object.fromEntries(MODES.map(({ mode }) => [mode, bpsToPercent(next.adjustmentsBps[mode])])));
      setFeedback({ kind: 'success', message: 'Porcentajes actualizados.' });
      onSaved?.();
    } catch (cause) {
      setFeedback({ kind: 'error', message: errorMessage(cause, 'No se pudo actualizar la configuración.') });
    } finally {
      setLoading(false);
    }
  }

  return (
    <form className="form-card" onSubmit={submit} noValidate>
      <div>
        <p className="eyebrow">Precios</p>
        <h3>Modos de venta</h3>
      </div>
      <p className="muted">Efectivo es la base 0%. Lista y los demás modos se derivan del precio efectivo de cada variante (efectivo + ajuste); el precio legacy no interviene.</p>
      <div className="form-row">
        {MODES.map(({ mode, label }) => (
          <label key={mode}>
            {label} (%)
            <input
              value={values[mode] ?? ''}
              inputMode="decimal"
              disabled={loading || !config}
              onChange={(event) => setValues((current) => ({ ...current, [mode]: event.target.value }))}
            />
          </label>
        ))}
      </div>
      <FormFeedback feedback={feedback} />
      <button type="submit" className="primary-button" disabled={loading || !config}>
        {loading ? 'Cargando…' : 'Guardar porcentajes'}
      </button>
    </form>
  );
}
