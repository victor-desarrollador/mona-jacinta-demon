import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { validate } from '../../middleware/validation.js';
import { createProductsController } from './products.controller.js';
import { createProductSchema, productIdSchema, productQuerySchema } from './dto/product.dto.js';
import {
  createVariantSchema,
  updateVariantPriceSchema,
  variantIdSchema,
  variantQuerySchema,
} from './dto/variant.dto.js';

export function createProductsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  const inventoryRead = requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'global',
  });
  router.get('/', inventoryRead, validate(productQuerySchema, 'query'), controller.listProducts);
  router.get('/:id', inventoryRead, validate(productIdSchema, 'params'), controller.getProduct);
  // D3: PRODUCT_MANAGE is COMPANY-required (rbac/permissions.ts); the
  // centralized policy denies a LOCATION-scoped ADMIN.
  router.post(
    '/',
    requirePermission(PRODUCTION_PERMISSIONS.PRODUCT_MANAGE),
    validate(createProductSchema),
    controller.createProduct,
  );
  return router;
}

export function createVariantsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  const inventoryRead = requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'global',
  });
  router.get('/', inventoryRead, validate(variantQuerySchema, 'query'), controller.listVariants);
  router.get('/:id', inventoryRead, validate(variantIdSchema, 'params'), controller.getVariant);
  // D3: PRODUCT_VARIANT_MANAGE and PRICE_MANAGE are COMPANY-required.
  router.post(
    '/',
    requirePermission(PRODUCTION_PERMISSIONS.PRODUCT_VARIANT_MANAGE),
    validate(createVariantSchema),
    controller.createVariant,
  );
  router.patch(
    '/:id/price',
    requirePermission(PRODUCTION_PERMISSIONS.PRICE_MANAGE),
    validate(variantIdSchema, 'params'),
    validate(updateVariantPriceSchema),
    controller.updateVariantPrice,
  );
  return router;
}

// D3: reference reads for the admin catalogue selectors. Same Production
// read permission as the existing product/variant reads (INVENTORY_VIEW,
// global) — no new permission; every catalogue-reading role already holds it.
export function createCategoriesRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  router.get('/', requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW), controller.listCategories);
  return router;
}

export function createBrandsRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createProductsController(database);
  router.get('/', requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW), controller.listBrands);
  return router;
}