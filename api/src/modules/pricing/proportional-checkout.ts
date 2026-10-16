// R3 rev. 2 — pure proportional checkout engine (design ETAPA B §2 formulas,
// §3 Hamilton distribution). No database, no I/O, no clock: given the sale's
// line snapshots, the company adjustment basis points and the cashier's fixed
// tenders, it returns the full price per method, the balance, the total and the
// exact per-method/per-line allocation.
//
// Money is centavos in BigInt only. Computed values (unit prices, full prices,
// balance, total and allocations) are bounded to int8 so they are persistable;
// the intermediates D, S and the balance numerator are arbitrary-precision
// BigInt by design (they can exceed int8 — see §2 of the design).
import { AppError } from '../../shared/errors.js';

export const PESO = 100n;
export const BASIS_POINTS = 10_000n;
export const MAX_INT8 = 9_223_372_036_854_775_807n;

// Opening policy (§5 of the design): CARD_CREDIT and QR are not part of R3.
export const PROPORTIONAL_METHODS = ['CASH', 'TRANSFER', 'CARD_DEBIT'] as const;
export type ProportionalMethod = (typeof PROPORTIONAL_METHODS)[number];

export type ProportionalLineInput = {
  saleItemId: string;
  sku: string;
  quantity: bigint;
  baseUnitPrice: bigint;
};

export type ProportionalPricingSnapshot = {
  bankTransferAdjustmentBps: number;
  debitCardAdjustmentBps: number;
};

export type ProportionalTenderInput = {
  method: ProportionalMethod;
  amount: bigint;
};

export type ProportionalQuoteInput = {
  lines: readonly ProportionalLineInput[];
  // `null` means the company has no pricing configuration: only CASH is available.
  pricing: ProportionalPricingSnapshot | null;
  tenders: readonly ProportionalTenderInput[];
  balanceMethod: ProportionalMethod;
};

export type ProportionalLineAllocation = {
  saleItemId: string;
  sku: string;
  amount: bigint;
};

export type ProportionalMethodQuote = {
  method: ProportionalMethod;
  role: 'FIXED' | 'BALANCE';
  fullPrice: bigint;
  amount: bigint;
  allocations: ProportionalLineAllocation[];
};

export type ProportionalLineResult = {
  saleItemId: string;
  sku: string;
  finalAmount: bigint;
};

export type ProportionalQuote = {
  fullPrices: Record<ProportionalMethod, bigint | null>;
  // Per-line per-method full price (quantity * rounded unit price), aligned with
  // `lines`. `null` for a method with no pricing configuration.
  lineFullPrices: Record<ProportionalMethod, bigint[] | null>;
  balance: { method: ProportionalMethod; amount: bigint };
  total: bigint;
  methods: ProportionalMethodQuote[];
  lines: ProportionalLineResult[];
};

function invalidState(message: string): AppError {
  return new AppError(500, 'CHECKOUT_STATE_INCONSISTENT', message);
}

function assertFitsInt8(value: bigint): bigint {
  if (value < 0n || value > MAX_INT8) {
    throw new AppError(409, 'AMOUNT_OVERFLOW', 'El importe excede el rango de BIGINT.');
  }
  return value;
}

// Public-boundary type guard: a JS consumer or a bad cast can hand us a Number,
// string or other non-BigInt. Fail closed with a domain error instead of letting
// BigInt arithmetic throw a TypeError or silently coercing the value.
function assertMoney(value: unknown, field: string): asserts value is bigint {
  if (typeof value !== 'bigint') {
    throw new AppError(400, 'INVALID_MONEY_TYPE', `${field} debe ser un importe en centavos (BigInt).`);
  }
}

// R(N, D) = round-half-up of N/D to the nearest whole peso, in centavos.
export function roundPeso(numerator: bigint, denominator: bigint): bigint {
  assertMoney(numerator, 'numerator');
  assertMoney(denominator, 'denominator');
  if (numerator < 0n || denominator <= 0n) {
    throw invalidState('roundPeso exige numerador no negativo y denominador positivo.');
  }
  return ((numerator + 50n * denominator) / (100n * denominator)) * PESO;
}

function assertMethod(method: string): void {
  if (!(PROPORTIONAL_METHODS as readonly string[]).includes(method)) {
    throw new AppError(400, 'PAYMENT_METHOD_NOT_ENABLED', `El medio ${method} no está habilitado para el cobro proporcional.`);
  }
}

function assertAdjustmentBps(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new AppError(400, 'INVALID_PRICE_ADJUSTMENT', `${field} debe estar entre 0 y 10000 bps.`);
  }
}

function allocate(input: {
  amount: bigint;
  methodFullPrice: bigint;
  perLine: readonly bigint[];
  lines: readonly ProportionalLineInput[];
}): ProportionalLineAllocation[] {
  const { amount, methodFullPrice, perLine, lines } = input;
  if (methodFullPrice <= 0n) {
    throw invalidState('No se puede distribuir un medio sin precio completo.');
  }
  // Whole-peso tenders are distributed in whole pesos; tenders that carry
  // centavos are distributed to the centavo so the received money is never
  // rounded (§3 of the design).
  const unit = amount % PESO === 0n ? PESO : 1n;
  const units = amount / unit;
  const rows = lines.map((line, index) => {
    const weight = perLine[index]!;
    const product = units * weight;
    return {
      index,
      weight,
      quotient: product / methodFullPrice,
      remainder: product % methodFullPrice,
      sku: line.sku,
      saleItemId: line.saleItemId,
    };
  });
  let residue = units - rows.reduce((sum, row) => sum + row.quotient, 0n);
  // Deterministic Hamilton tie-break: remainder desc, weight desc, sku asc, id asc.
  rows.sort((left, right) => {
    if (left.remainder !== right.remainder) return left.remainder > right.remainder ? -1 : 1;
    if (left.weight !== right.weight) return left.weight > right.weight ? -1 : 1;
    if (left.sku !== right.sku) return left.sku < right.sku ? -1 : 1;
    return left.saleItemId < right.saleItemId ? -1 : 1;
  });
  const allocated = new Array<bigint>(lines.length);
  for (const row of rows) {
    const extra = residue > 0n ? 1n : 0n;
    residue -= extra;
    const value = (row.quotient + extra) * unit;
    if (value > perLine[row.index]!) {
      throw invalidState('Una asignación supera el precio completo del renglón.');
    }
    allocated[row.index] = value;
  }
  return lines.map((line, index) => ({ saleItemId: line.saleItemId, sku: line.sku, amount: allocated[index]! }));
}

export function computeProportionalQuote(input: ProportionalQuoteInput): ProportionalQuote {
  const { lines, pricing, tenders, balanceMethod } = input;

  assertMethod(balanceMethod);
  if (lines.length === 0) {
    throw new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', 'La venta no tiene renglones para cotizar.');
  }
  for (const line of lines) {
    assertMoney(line.quantity, 'line.quantity');
    assertMoney(line.baseUnitPrice, 'line.baseUnitPrice');
    if (line.quantity <= 0n || line.baseUnitPrice <= 0n) {
      throw new AppError(409, 'PRICING_SNAPSHOT_INCONSISTENT', 'Un renglón tiene cantidad o precio base inválido.');
    }
  }

  const adjustmentsBps: Record<ProportionalMethod, number | null> = { CASH: 0, TRANSFER: null, CARD_DEBIT: null };
  if (pricing !== null) {
    assertAdjustmentBps(pricing.bankTransferAdjustmentBps, 'bankTransferAdjustmentBps');
    assertAdjustmentBps(pricing.debitCardAdjustmentBps, 'debitCardAdjustmentBps');
    adjustmentsBps.TRANSFER = pricing.bankTransferAdjustmentBps;
    adjustmentsBps.CARD_DEBIT = pricing.debitCardAdjustmentBps;
  }

  const fixed = new Map<ProportionalMethod, bigint>();
  for (const tender of tenders) {
    assertMethod(tender.method);
    assertMoney(tender.amount, 'tender.amount');
    if (fixed.has(tender.method)) {
      throw new AppError(409, 'DUPLICATE_TENDER_METHOD', `El medio ${tender.method} aparece más de una vez.`);
    }
    if (tender.amount <= 0n) {
      throw new AppError(409, 'FIXED_TENDER_NOT_POSITIVE', 'Un importe fijo debe ser mayor que cero.');
    }
    // An amount beyond int8 is not persistable: reject it before deciding
    // whether it covers the sale, so the failure reason is the overflow.
    assertFitsInt8(tender.amount);
    fixed.set(tender.method, tender.amount);
  }
  if (fixed.has(balanceMethod)) {
    throw new AppError(409, 'BALANCE_METHOD_ALSO_FIXED', 'El medio de saldo no puede ser también un importe fijo.');
  }
  for (const method of PROPORTIONAL_METHODS) {
    if ((fixed.has(method) || method === balanceMethod) && adjustmentsBps[method] === null) {
      throw new AppError(409, 'PRICING_CONFIG_MISSING', `Falta la configuración de precios para ${method}.`);
    }
  }

  // Full price per method: one rounding per unit, lines and method totals bounded.
  const lineFullPrices: Record<ProportionalMethod, bigint[] | null> = { CASH: null, TRANSFER: null, CARD_DEBIT: null };
  const fullPrices: Record<ProportionalMethod, bigint | null> = { CASH: null, TRANSFER: null, CARD_DEBIT: null };
  for (const method of PROPORTIONAL_METHODS) {
    const bps = adjustmentsBps[method];
    if (bps === null) continue;
    const perLine = lines.map((line) => {
      const unitPrice = assertFitsInt8(roundPeso(line.baseUnitPrice * (BASIS_POINTS + BigInt(bps)), BASIS_POINTS));
      return assertFitsInt8(line.quantity * unitPrice);
    });
    lineFullPrices[method] = perLine;
    fullPrices[method] = assertFitsInt8(perLine.reduce((sum, value) => sum + value, 0n));
  }

  // D and S are arbitrary-precision; only their ratio reaches a bounded value.
  let denominator = 1n;
  for (const method of PROPORTIONAL_METHODS) {
    if (fixed.has(method)) denominator *= fullPrices[method]!;
  }
  let covered = 0n;
  for (const method of PROPORTIONAL_METHODS) {
    if (!fixed.has(method)) continue;
    let term = fixed.get(method)!;
    for (const other of PROPORTIONAL_METHODS) {
      if (other !== method && fixed.has(other)) term *= fullPrices[other]!;
    }
    covered += term;
  }
  if (covered >= denominator) {
    throw new AppError(409, 'FIXED_TENDERS_COVER_SALE', 'Los importes fijos cubren la venta completa.');
  }

  const balance = assertFitsInt8(roundPeso(fullPrices[balanceMethod]! * (denominator - covered), denominator));
  if (balance < PESO) {
    throw new AppError(409, 'BALANCE_TOO_SMALL', 'El saldo es menor a un peso.');
  }

  const amounts = new Map<ProportionalMethod, bigint>();
  for (const method of PROPORTIONAL_METHODS) {
    if (fixed.has(method)) amounts.set(method, fixed.get(method)!);
  }
  amounts.set(balanceMethod, balance);
  const total = assertFitsInt8([...amounts.values()].reduce((sum, value) => sum + value, 0n));

  const methods: ProportionalMethodQuote[] = [];
  const linesResult: ProportionalLineResult[] = lines.map((line) => ({
    saleItemId: line.saleItemId,
    sku: line.sku,
    finalAmount: 0n,
  }));
  for (const method of PROPORTIONAL_METHODS) {
    if (!amounts.has(method)) continue;
    const amount = amounts.get(method)!;
    const methodFullPrice = fullPrices[method]!;
    const allocations = allocate({ amount, methodFullPrice, perLine: lineFullPrices[method]!, lines });
    const methodSum = allocations.reduce((sum, entry) => sum + entry.amount, 0n);
    if (methodSum !== amount) throw invalidState(`La distribución de ${method} no concilia con su importe.`);
    for (let index = 0; index < allocations.length; index += 1) {
      linesResult[index]!.finalAmount += allocations[index]!.amount;
    }
    methods.push({
      method,
      role: method === balanceMethod ? 'BALANCE' : 'FIXED',
      fullPrice: methodFullPrice,
      amount,
      allocations,
    });
  }

  const lineSum = linesResult.reduce((sum, line) => sum + line.finalAmount, 0n);
  if (lineSum !== total) throw invalidState('La distribución por renglón no concilia con el total.');

  return {
    fullPrices,
    lineFullPrices,
    balance: { method: balanceMethod, amount: balance },
    total,
    methods,
    lines: linesResult,
  };
}
