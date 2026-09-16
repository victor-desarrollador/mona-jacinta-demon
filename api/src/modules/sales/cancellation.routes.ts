import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { saleIdDto } from './dto/sale.dto.js';
import { createCancellationController } from './cancellation.controller.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

export function createCancellationRouter(database: PrismaClient, realtime?: RealtimeEmitter): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  router.post('/:saleId/cancel', validate(saleIdDto, 'params'), requirePermission(PRODUCTION_PERMISSIONS.SALE_CREATE), controller.cancel);
  return router;
}

export function createReservationAdminRouter(database: PrismaClient, realtime?: RealtimeEmitter): Router {
  const router = Router();
  const controller = createCancellationController(database, realtime);
  router.post('/reservations/release-expired', requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_MANAGE), controller.releaseExpired);
  return router;
}
