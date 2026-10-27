// Exact conversions between what an operator types and the API's
// integer-cent / integer-unit string contracts (api/src/modules/products/dto/money.dto.ts,
// api/src/modules/inventory/initial-stock.service.ts). String and BigInt
// operations only: no Number/parseFloat is ever involved, so values beyond
// Number.MAX_SAFE_INTEGER stay exact.

const MAX_BIGINT = 9223372036854775807n;

export type ParseResult = { ok: true; value: string } | { ok: false; error: string };

// Accepts pesos with an optional decimal separator ("," or ".") and at most
// two decimals: "4500", "4500,5", "4500.50". Thousand separators are
// rejected on purpose — "1.234" is ambiguous (1234 pesos or 1,234?), so the
// operator must type it unambiguously.
const PESOS_PATTERN = /^(\d+)(?:[.,](\d{1,2}))?$/;

export function pesosToCents(input: string, { allowZero }: { allowZero: boolean }): ParseResult {
  const trimmed = input.trim();
  if (!trimmed) return { ok: false, error: 'Ingresá un importe.' };
  const match = PESOS_PATTERN.exec(trimmed);
  if (!match) {
    return {
      ok: false,
      error: 'Importe inválido: usá solo números, sin separador de miles y con hasta 2 decimales (ej. 4500,50).',
    };
  }
  const [, whole, fraction = ''] = match;
  const digits = `${whole}${fraction.padEnd(2, '0')}`.replace(/^0+(?=\d)/, '');
  const cents = BigInt(digits);
  if (cents > MAX_BIGINT) return { ok: false, error: 'El importe es demasiado grande.' };
  if (!allowZero && cents === 0n) return { ok: false, error: 'El importe debe ser mayor que cero.' };
  return { ok: true, value: cents.toString() };
}

// Inverse of pesosToCents for prefilling an input ("4500000" -> "45000,00").
export function centsToPesosInput(cents: string) {
  const value = BigInt(cents);
  return `${value / 100n},${(value % 100n).toString().padStart(2, '0')}`;
}

// Positive integer units, same bound as the API (1..18 digits, no leading zero).
export function parseQuantity(input: string): ParseResult {
  const trimmed = input.trim();
  if (!/^[1-9]\d{0,17}$/.test(trimmed)) {
    return { ok: false, error: 'La cantidad debe ser un número entero mayor que cero (sin decimales).' };
  }
  return { ok: true, value: trimmed };
}
