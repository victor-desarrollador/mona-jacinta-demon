// Dinero del POS: centavos exactos en BigInt (nunca Number). Movido tal cual desde page.tsx para que más de un módulo
// (p. ej. ExchangeWorkspace) lo use sin importar de una `page`. Ninguna lógica cambió; lib/money.test.ts fija su comportamiento.

const money = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  maximumFractionDigits: 0,
});
const moneyWithCentavos = new Intl.NumberFormat("es-AR", {
  style: "currency",
  currency: "ARS",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});
export const ZERO = BigInt(0);
export const ONE = BigInt(1);
export const ONE_HUNDRED = BigInt(100);

export function cents(value: string) {
  return BigInt(value);
}

// H1: exact display of BigInt centavos. Whole pesos keep the "$ 9.500" format; an amount with
// centavos always shows them ("$ 1.209,40"). The pesos are formatted as a BigInt (never a
// Number, so no precision loss) and the fraction digits come from the remainder itself.
export function formatMoney(value: string) {
  const amount = cents(value);
  const absolute = amount < ZERO ? -amount : amount;
  const pesos = absolute / ONE_HUNDRED;
  const centavos = absolute % ONE_HUNDRED;
  const text =
    centavos === ZERO
      ? money.format(pesos)
      : moneyWithCentavos
          .formatToParts(pesos)
          .map((part) => (part.type === "fraction" ? centavos.toString().padStart(2, "0") : part.value))
          .join("");
  return amount < ZERO ? `-${text}` : text;
}

export function formatSignedMoney(value: string) {
  return formatMoney(value);
}

export function arsToCents(input: string) {
  const normalized = input.trim().replace(/\s/g, "");
  if (!normalized) return null;
  if (!/^[0-9.,]+$/.test(normalized)) return null;

  const comma = normalized.lastIndexOf(",");
  const dot = normalized.lastIndexOf(".");
  const decimalIndex = comma > dot ? comma : dot;
  const hasDecimal = decimalIndex >= 0 && normalized.length - decimalIndex - 1 <= 2;

  const wholePart = hasDecimal ? normalized.slice(0, decimalIndex) : normalized;
  const decimalPart = hasDecimal ? normalized.slice(decimalIndex + 1) : "";
  const wholeDigits = wholePart.replace(/[.,]/g, "");

  if (!/^\d+$/.test(wholeDigits) || (decimalPart && !/^\d{1,2}$/.test(decimalPart))) {
    return null;
  }

  return (BigInt(wholeDigits) * ONE_HUNDRED + BigInt(decimalPart.padEnd(2, "0") || "0")).toString();
}

// H2: exact prefill for the amount inputs ("1209,40", "0,01"; whole pesos stay "1209"), the
// inverse of arsToCents, so a prefilled balance is never truncated into a short payment.
export function centsToArsInput(value: string) {
  const amount = cents(value);
  const absolute = amount < ZERO ? -amount : amount;
  const pesos = (absolute / ONE_HUNDRED).toString();
  const centavos = absolute % ONE_HUNDRED;
  const text = centavos === ZERO ? pesos : `${pesos},${centavos.toString().padStart(2, "0")}`;
  return amount < ZERO ? `-${text}` : text;
}
