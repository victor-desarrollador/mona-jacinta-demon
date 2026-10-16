// R3-A4.3 S2: HTTP contract of POST /sales/:saleId/checkout/stock-recovery (T-S).
// C1–C5 §4.2 declared `reserveKey` optional for the variant (b); the last-REVISE
// §2 removed that variant (T-S recovers ONLY a RESERVED attempt by its original
// reserveKey; T-RR replaces (b)), so reserveKey is required here.
import { z } from 'zod';
import { boundedText, canonicalUuid } from './checkout-fields.js';

export { saleIdParams as checkoutStockRecoveryParamsDto } from './checkout-fields.js';

export type CheckoutStockRecoveryRequest = { reserveKey: string; reason: string; evidence: string };

export const checkoutStockRecoveryDto = z.object({
  reserveKey: canonicalUuid,
  reason: boundedText(10, 500),
  evidence: boundedText(3, 200),
}).strict();
