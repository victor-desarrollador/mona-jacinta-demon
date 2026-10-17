// R3-A4.3 S6: HTTP boundary of the close/declaration (T-X). It hands the
// already-validated request to the service (the only authority: it locks,
// checks, writes and commits) and serialises the result. A fresh close and an
// identical replay are both 200. No realtime emission in S6: a close notifies
// no client.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCheckoutCloseService, type CheckoutCloseService } from './checkout-close.service.js';
import type { CheckoutCloseRequest } from './dto/checkout-close.dto.js';

export function createCheckoutCloseController(database: PrismaClient, options: { service?: CheckoutCloseService } = {}) {
  const service = options.service ?? createCheckoutCloseService(database);
  return {
    close: (async (req, res) => {
      const result = await service.close(
        req,
        String(req.params.saleId),
        String(req.params.reserveKey),
        req.body as CheckoutCloseRequest,
      );
      sendJson(res.status(200), result);
    }) as RequestHandler,
  };
}
