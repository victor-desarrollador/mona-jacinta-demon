import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createSalesController } from './sales.controller.js';
import { createDraftSaleDto, saleIdDto } from './dto/sale.dto.js';
import { addSaleItemDto, saleItemParamsDto, updateSaleItemDto } from './dto/sale-item.dto.js';

export function createSalesRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createSalesController(database);
  const createPermission = requirePermission(PERMISSIONS.SALE_CREATE);
  const viewPermission = requirePermission(PERMISSIONS.SALE_VIEW);
  router.get('/', viewPermission, controller.list);
  router.post('/', validate(createDraftSaleDto), createPermission, controller.create);
  router.get('/:saleId', validate(saleIdDto, 'params'), viewPermission, controller.get);
  router.post('/:saleId/items', validate(saleIdDto, 'params'), validate(addSaleItemDto), createPermission, controller.addItem);
  router.patch('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), validate(updateSaleItemDto), createPermission, controller.updateItem);
  router.delete('/:saleId/items/:itemId', validate(saleItemParamsDto, 'params'), createPermission, controller.removeItem);
  return router;
}