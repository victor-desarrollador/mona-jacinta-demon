// R3-A4.3 S4: /api/v1/checkout-attempts, mounted in app.ts after authentication
// and outside the /sales/:saleId router (C1–C5 §4.1). The route gate is the
// global SALE_CHARGE; the service decides scope and location.
import { Router, type RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { sendJson } from '../../shared/json-safe.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { checkoutAttemptsRecentQueryDto, type CheckoutAttemptsRecentQuery } from './dto/checkout-attempts-recent.dto.js';
import { createCheckoutAttemptsRecentService, type CheckoutAttemptsRecentService } from './checkout-attempts-recent.service.js';

export function createCheckoutAttemptsRouter(database: PrismaClient, options: { service?: CheckoutAttemptsRecentService } = {}): Router {
  const router = Router();
  const service = options.service ?? createCheckoutAttemptsRecentService(database);
  const recent: RequestHandler = async (req, res) => {
    sendJson(res.status(200), await service.recent(req, req.query as unknown as CheckoutAttemptsRecentQuery));
  };
  router.get('/recent', validate(checkoutAttemptsRecentQueryDto, 'query'), requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE), recent);
  return router;
}
