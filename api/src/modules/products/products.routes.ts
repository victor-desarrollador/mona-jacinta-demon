import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { validate } from '../../middleware/validation.js';
import { createProductsController } from './products.controller.js';
import { productIdSchema, productQuerySchema } from './dto/product.dto.js';
import { variantIdSchema, variantQuerySchema } from './dto/variant.dto.js';

export function createProductsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  const inventoryRead = requirePermission(PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'global',
  });
  router.get('/', inventoryRead, validate(productQuerySchema, 'query'), controller.listProducts);
  router.get('/:id', inventoryRead, validate(productIdSchema, 'params'), controller.getProduct);
  return router;
}

export function createVariantsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  const inventoryRead = requirePermission(PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'global',
  });
  router.get('/', inventoryRead, validate(variantQuerySchema, 'query'), controller.listVariants);
  router.get('/:id', inventoryRead, validate(variantIdSchema, 'params'), controller.getVariant);
  return router;
}