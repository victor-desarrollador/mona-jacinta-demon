// Pilot Pricing V2 catalog price presentation for the seller catalog.
//
// ProductVariant.cashPrice is the canonical retail CASH base. ProductVariant.price is the legacy/transitional LIST value and is
// NEVER a fallback: a variant whose cashPrice is NULL is "not configured" — the server rejects selling it (CASH_PRICE_MISSING),
// so the UI must not present it as sellable at the legacy amount. No server field carries a derived LIST price for sellers, so
// none is computed here; the amount a sale actually charges always comes from the server's SaleItem.unitPrice for the sale's
// price mode.
export type CatalogPrice = { configured: true; cents: string } | { configured: false };

export function catalogCashPrice(variant: { cashPrice: string | null }): CatalogPrice {
  const value = variant.cashPrice;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value) || BigInt(value) <= BigInt(0)) return { configured: false };
  return { configured: true, cents: value };
}
