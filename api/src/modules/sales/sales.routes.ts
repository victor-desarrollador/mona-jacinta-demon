import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createSalesController } from './sales.controller.js';
import { createCancellationRouter } from './cancellation.routes.js';
import { activateWholesaleDto, createDraftSaleDto, saleIdDto } from './dto/sale.dto.js';
import { updateSalePriceModeDto } from '../pricing/pricing.dto.js';
import type { WholesaleCodeVerifier } from './wholesale-authorization.service.js';
import { AppError } from '../../shared/errors.js';
import { addSaleItemDto, saleItemParamsDto, updateSaleItemDto } from './dto/sale-item.dto.js';
import { correctPendingSaleDto } from './dto/pending-correction.dto.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

// Block 1: brute-force brake on the wholesale code, per authenticated user.
// Only failed attempts count (successful activations are not limited).
// In-memory store: per API process.
function createWholesaleAttemptLimiter() {
  return rateLimit({
    windowMs: 15 * 60_000,
    limit: 10,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: (req) => `wholesale:${req.auth!.userId}`,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', 'Demasiados intentos de código mayorista. Intentá nuevamente más tarde.'));
    },
  });
}

export function createSalesRouter(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { wholesaleVerifier?: WholesaleCodeVerifier } = {},
): Router {
  const router = Router();
  const controller = createSalesController(database, realtime, options);
  router.use('/', createCancellationRouter(database, realtime));
  const createPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_CREATE);
  const viewPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_VIEW);
  const sendPermission = requirePermission(PRODUCTION_PERMISSIONS.SALE_CREATE, {
    branchScope: 'own',
    resolveResourceBranch: async (req) =>
      (await database.sale.findUnique({
        where: { id: String(req.params.saleId) },
        select: { branchId: true },
      }))?.branchId,
  });
  router.get('/', viewPermission, controller.list);
  router.get('/pending', requirePermission(PRODUCTION_PERMISSIONS.SALE_QUEUE_VIEW), controller.pending);
  router.post('/', validate(createDraftSaleDto), createPermission, controller.create);
  router.get('/:saleId', validate(saleIdDto, 'params'), viewPermission, controller.get);
  router.post('/:saleId/items', validate(saleIdDto, 'params'), validate(addSaleItemDto), createPermission, controller.addItem);
  router.patch('/:saleId/price-mode', validate(saleIdDto, 'params'), validate(updateSalePriceModeDto), createPermission, controller.updatePriceMode);
  router.patch('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), validate(updateSaleItemDto), createPermission, controller.updateItem);
  router.delete('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), createPermission, controller.removeItem);
  // Block 1: SELLER enables wholesale on its own DRAFT sale (the service
  // re-checks SALE_CREATE at the sale's location and seller ownership);
  // CASHIER confirms it (SALE_CHARGE at the sale's location, re-checked
  // under the Sale lock). WAREHOUSE holds neither permission.
  router.post(
    '/:saleId/wholesale', validate(saleIdDto, 'params'), createPermission,
    createWholesaleAttemptLimiter(), validate(activateWholesaleDto), controller.activateWholesale,
  );
  router.post(
    '/:saleId/wholesale/confirm', validate(saleIdDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_CHARGE), controller.confirmWholesale,
  );
  router.post('/:saleId/send-to-cashier', validate(saleIdDto, 'params'), sendPermission, controller.sendToCashier);
  // Pilot P0.2-A: global gate here; the service re-checks the same
  // permission against the sale's persisted branch under the Sale lock.
  router.post('/:saleId/correct', validate(saleIdDto, 'params'), validate(correctPendingSaleDto), requirePermission(PRODUCTION_PERMISSIONS.SALE_CORRECT_PENDING), controller.correct);
  router.post('/:saleId/complete', validate(saleIdDto, 'params'), requirePermission(PRODUCTION_PERMISSIONS.SALE_COMPLETE), controller.complete);
  return router;
}
