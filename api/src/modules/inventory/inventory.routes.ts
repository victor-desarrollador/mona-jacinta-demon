import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createInventoryController } from './inventory.controller.js';
import { initialStockSchema } from './initial-stock.service.js';

const branchQuery = z.object({ branchId: z.uuid() }).strict();
const availabilityQuery = branchQuery.extend({
  variantId: z
    .union([z.uuid(), z.array(z.uuid()).min(1)])
    .transform((value) => (typeof value === 'string' ? [value] : value))
    .optional(),
});

export function createInventoryRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createInventoryController(database);
  const inventoryRead = requirePermission(PRODUCTION_PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'own',
    resolveResourceBranch: (req) => String(req.query.branchId),
  });
  // Validate first for 400 on malformed IDs. The permission middleware pairs
  // INVENTORY_VIEW with the requested branch via hasPermissionAtLocation
  // before either controller can query branch inventory.
  router.get(
    '/',
    validate(branchQuery, 'query'),
    inventoryRead,
    controller.getInventoryByBranch,
  );
  router.get(
    '/availability',
    validate(availabilityQuery, 'query'),
    inventoryRead,
    controller.getAvailability,
  );
  // D3: IMPORT_RUN is intentionally NOT COMPANY-required; it is paired with
  // the target branch through the existing location-aware mechanism
  // (branchScope 'own' -> hasPermissionAtLocation). The body is validated
  // first so the resolver only ever receives a validated branchId.
  router.post(
    '/initial-stock',
    validate(initialStockSchema),
    requirePermission(PRODUCTION_PERMISSIONS.IMPORT_RUN, {
      branchScope: 'own',
      resolveResourceBranch: (req) => (req.body as { branchId: string }).branchId,
    }),
    controller.loadInitialStock,
  );
  return router;
}
