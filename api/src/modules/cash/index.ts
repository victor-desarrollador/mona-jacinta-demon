// Public surface of the cash module for OTHER domain modules (dependency-cruiser `modules-via-public-index`). Deliberately
// minimal: only the two pure helpers the post-payment sale void reuses instead of duplicating cash logic —
//   projectExpectedCash      the drawer an OPEN session can give back (same arithmetic as the close, SALE_REFUND included)
//   reconciliationRefusal    the fixed, detail-free 409 a refused reconciliation maps to
// Everything else in cash.service.ts stays internal; widen this file only with a reason.
export { projectExpectedCash, reconciliationRefusal } from './cash.service.js';
