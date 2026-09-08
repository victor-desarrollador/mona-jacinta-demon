import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createInventoryController } from './inventory.controller.js';

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
  const inventoryRead = requirePermission(PERMISSIONS.INVENTORY_VIEW, {
    branchScope: 'own',
    resolveResourceBranch: (req) => String(req.query.branchId),
  });
  // Validate first for 400 on malformed IDs. The permission middleware calls
  // assertBranchAccess before either controller can query branch inventory.
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
  return router;
}
