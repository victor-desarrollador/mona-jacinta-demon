// R3-A4.3 S7: HTTP boundary of the supervised stock recovery (T-S). It hands
// the already-validated request to the service (the only authority: it locks,
// checks the supervisor role at the sale's persisted branch, writes, audits and
// commits) and serialises the result. A recovery that changed the coverage and
// one that found it already valid are both 200. No realtime emission in S7.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCheckoutStockRecoveryService, type CheckoutStockRecoveryService } from './checkout-stock-recovery.service.js';
import type { CheckoutStockRecoveryRequest } from './dto/checkout-stock-recovery.dto.js';

export function createCheckoutStockRecoveryController(database: PrismaClient, options: { service?: CheckoutStockRecoveryService } = {}) {
  const service = options.service ?? createCheckoutStockRecoveryService(database);
  return {
    recover: (async (req, res) => {
      const result = await service.recover(req, String(req.params.saleId), req.body as CheckoutStockRecoveryRequest);
      sendJson(res.status(200), result);
    }) as RequestHandler,
  };
}
