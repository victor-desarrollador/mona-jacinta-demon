import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { saleIdDto } from './dto/sale.dto.js';
import { createCancellationController } from './cancellation.controller.js';

export function createCancellationRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createCancellationController(database);
  router.post('/:saleId/cancel', validate(saleIdDto, 'params'), requirePermission(PERMISSIONS.SALE_CREATE), controller.cancel);
  return router;
}

export function createReservationAdminRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createCancellationController(database);
  router.post('/reservations/release-expired', requirePermission(PERMISSIONS.INVENTORY_MANAGE), controller.releaseExpired);
  return router;
}
