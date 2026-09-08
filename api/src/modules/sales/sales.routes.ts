import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createSalesController } from './sales.controller.js';
import { createCancellationRouter } from './cancellation.routes.js';
import { createDraftSaleDto, saleIdDto } from './dto/sale.dto.js';
import { addSaleItemDto, saleItemParamsDto, updateSaleItemDto } from './dto/sale-item.dto.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';

export function createSalesRouter(database: PrismaClient, realtime?: RealtimeEmitter): Router {
  const router = Router();
  const controller = createSalesController(database, realtime);
  router.use('/', createCancellationRouter(database, realtime));
  const createPermission = requirePermission(PERMISSIONS.SALE_CREATE);
  const viewPermission = requirePermission(PERMISSIONS.SALE_VIEW);
  const sendPermission = requirePermission(PERMISSIONS.SALE_CREATE, {
    branchScope: 'own',
    resolveResourceBranch: async (req) =>
      (await database.sale.findUnique({
        where: { id: String(req.params.saleId) },
        select: { branchId: true },
      }))?.branchId,
  });
  router.get('/', viewPermission, controller.list);
  router.get('/pending', requirePermission(PERMISSIONS.SALE_QUEUE_VIEW), controller.pending);
  router.post('/', validate(createDraftSaleDto), createPermission, controller.create);
  router.get('/:saleId', validate(saleIdDto, 'params'), viewPermission, controller.get);
  router.post('/:saleId/items', validate(saleIdDto, 'params'), validate(addSaleItemDto), createPermission, controller.addItem);
  router.patch('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), validate(updateSaleItemDto), createPermission, controller.updateItem);
  router.delete('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), createPermission, controller.removeItem);
  router.post('/:saleId/send-to-cashier', validate(saleIdDto, 'params'), sendPermission, controller.sendToCashier);
  router.post('/:saleId/complete', validate(saleIdDto, 'params'), requirePermission(PERMISSIONS.SALE_COMPLETE), controller.complete);
  return router;
}
