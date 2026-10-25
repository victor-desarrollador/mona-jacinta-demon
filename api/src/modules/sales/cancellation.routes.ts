import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requireAnyPermission, requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { saleIdDto } from './dto/sale.dto.js';
import { cancelSaleDto } from './dto/cancel-sale.dto.js';
import { voidSaleDto } from './dto/void-sale.dto.js';
import { createCancellationController } from './cancellation.controller.js';
import { createSaleVoidController } from './sale-void.controller.js';
import type { SaleVoidService } from './sale-void.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

// `saleVoidService` is a test seam (the HTTP tests inject a recorder); production builds the real service.
export function createCancellationRouter(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { saleVoidService?: SaleVoidService } = {},
): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  // Pilot P0.2-B: coarse gate only; cancelSale decides DRAFT (own, SALE_CREATE)
  // vs PENDING_PAYMENT (SALE_CANCEL_PENDING) on the locked, persisted sale.
  router.post(
    '/:saleId/cancel',
    validate(saleIdDto, 'params'),
    validate(cancelSaleDto),
    requireAnyPermission([PRODUCTION_PERMISSIONS.SALE_CREATE, PRODUCTION_PERMISSIONS.SALE_CANCEL_PENDING]),
    controller.cancel,
  );
  // Sale void v1: the post-payment void, a route of its own (never /cancel). Params are validated first, then
  // the coarse SALE_VOID gate (an unauthenticated or unauthorized caller learns nothing about the body), then the
  // strict body. The definitive decision (OWNER / COMPANY-scoped ADMIN at the sale's persisted branch) is the
  // service's, not this gate's.
  const voidController = createSaleVoidController(database, realtime, options);
  router.post(
    '/:saleId/void',
    validate(saleIdDto, 'params'),
    requirePermission(PRODUCTION_PERMISSIONS.SALE_VOID),
    validate(voidSaleDto),
    voidController.voidSale,
  );
  return router;
}

export function createReservationAdminRouter(database: PrismaClient, realtime?: RealtimeEmitter): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  router.post('/reservations/release-expired', requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_MANAGE), controller.releaseExpired);
  return router;
}
