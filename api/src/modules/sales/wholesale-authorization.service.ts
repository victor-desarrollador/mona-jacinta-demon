import type { PriceType } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { verifyPassword } from '../auth/password.js';

// Block 1: sale-scoped wholesale pricing rules, kept free of database access
// so sales, pending-correction and payments share exactly one definition.
//
// Flow: the sale's own SELLER submits the wholesale code for ONE DRAFT sale;
// the server verifies it against a bcrypt hash configured out-of-band
// (WHOLESALE_AUTH_CODE_HASH) and switches only that sale to WHOLESALE. A
// CASHIER at the sale's location must then confirm the wholesale buyer
// before the sale accepts a payment or completes. The raw code is never
// stored, logged, audited or returned: only the verification outcome is used.

// bcrypt only reads the first 72 bytes, so a longer input could verify by
// prefix. Reject it instead of truncating.
const BCRYPT_MAX_BYTES = 72;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

// Surrounding whitespace is trimmed (copy/paste artefacts); everything else,
// including letter case, must match exactly. Returns null when nothing
// usable remains.
export function normalizeWholesaleCode(raw: string): string | null {
  const code = raw.trim();
  return code.length === 0 ? null : code;
}

function invalidFormat() {
  return new AppError(400, 'WHOLESALE_CODE_FORMAT', 'El código mayorista no tiene un formato válido.');
}

// Throws for input that can never be a valid code; never echoes it.
export function parseWholesaleCode(raw: string): string {
  const code = normalizeWholesaleCode(raw);
  if (code === null || CONTROL_CHARACTERS.test(code) || Buffer.byteLength(code, 'utf8') > BCRYPT_MAX_BYTES) {
    throw invalidFormat();
  }
  return code;
}

export type WholesaleCodeVerifier = {
  readonly configured: boolean;
  verify(code: string): Promise<boolean>;
};

// No hash configured => wholesale is unavailable (fails closed). A hash that
// bcrypt cannot parse verifies nothing rather than throwing.
export function createWholesaleCodeVerifier(codeHash: string | undefined): WholesaleCodeVerifier {
  if (!codeHash) return { configured: false, verify: async () => false };
  return {
    configured: true,
    async verify(code) {
      try {
        return await verifyPassword(code, codeHash);
      } catch {
        return false;
      }
    },
  };
}

// The authoritative unit price for a new SaleItem: always read from the
// catalog row by the server, never from the client.
export function unitPriceFor(
  mode: PriceType,
  variant: { id: string; price: bigint; wholesalePrice: bigint | null },
): bigint {
  if (mode === 'LIST') return variant.price;
  if (variant.wholesalePrice === null) {
    throw new AppError(409, 'WHOLESALE_PRICE_MISSING', 'La variante no tiene precio mayorista.', { variantId: variant.id });
  }
  return variant.wholesalePrice;
}

// Payment and completion gate, evaluated under the Sale row lock. Same rule
// as the DB CHECK chk_sale_wholesale_confirmed_when_paid: a WHOLESALE sale
// needs both confirmation columns before it can become PAID or COMPLETED.
export function assertPricingFinalizable(sale: {
  pricingMode: PriceType; wholesaleConfirmedAt: Date | null; wholesaleConfirmedById: string | null;
}): void {
  if (sale.pricingMode === 'WHOLESALE' && (sale.wholesaleConfirmedAt === null || sale.wholesaleConfirmedById === null)) {
    throw new AppError(409, 'WHOLESALE_CONFIRMATION_REQUIRED', 'Caja debe confirmar la venta mayorista antes de cobrarla.');
  }
}
