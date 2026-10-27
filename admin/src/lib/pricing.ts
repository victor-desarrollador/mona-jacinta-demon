// Pricing V2 display helpers (admin). The SERVER is the only authority for prices: nothing here is ever sent to the API or
// used to charge a sale. No API response carries a derived LIST price today, and the company LIST adjustment is readable only
// with PRICE_MANAGE (GET /pricing/config), so the admin shows an INFORMATIONAL preview of
//   LIST = CASH base + company LIST adjustment, rounded half-up to the centavo
// (the same rule as api/src/modules/pricing/pricing.ts roundHalfUpBps). When either input is unavailable the preview is
// absent, never substituted with the legacy ProductVariant.price.

const BASIS_POINTS = 10_000n;
const MAX_BPS = 10_000;

// `cashCents` is the API's integer-centavo string (or null when the variant has no CASH base yet); `listBps` is the company
// LIST adjustment in basis points (or null when the viewer cannot read the pricing config).
export function derivedListCents(cashCents: string | null, listBps: number | null): string | null {
  if (cashCents === null || listBps === null) return null;
  if (!/^\d+$/.test(cashCents) || !Number.isInteger(listBps) || listBps < 0 || listBps > MAX_BPS) return null;
  const base = BigInt(cashCents);
  if (base <= 0n) return null;
  return ((base * (BASIS_POINTS + BigInt(listBps)) + BASIS_POINTS / 2n) / BASIS_POINTS).toString();
}

// "+0 %", "+20 %", "+12,5 %" — the adjustment applied on top of the CASH base.
export function adjustmentLabel(bps: number): string {
  const percent = bps / 100;
  const text = Number.isInteger(percent) ? percent.toString() : percent.toFixed(2).replace(/0+$/, '').replace('.', ',');
  return `+${text} %`;
}
