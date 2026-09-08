import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createBackofficeController } from './backoffice.controller.js';

const limit = z.coerce.number().int().min(1).max(100).default(50);
const offset = z.coerce.number().int().min(0).default(0);
const date = z.coerce.date();

const salesQuery = z.object({
  branchId: z.uuid().optional(),
  sellerId: z.uuid().optional(),
  dateFrom: date.optional(),
  dateTo: date.optional(),
  limit,
  offset,
}).strict();

const inventoryQuery = z.object({
  branchId: z.uuid().optional(),
  search: z.string().trim().min(1).max(100).optional(),
  limit,
  offset,
}).strict();

const saleParams = z.object({ id: z.uuid() }).strict();

export function createBackofficeRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createBackofficeController(database);
  const reportView = requirePermission(PERMISSIONS.REPORT_VIEW);
  const userManage = requirePermission(PERMISSIONS.USER_MANAGE);

  router.get('/dashboard', reportView, controller.dashboard);
  router.get('/sales', reportView, validate(salesQuery, 'query'), controller.sales);
  router.get('/sales/:id', reportView, validate(saleParams, 'params'), controller.saleDetail);
  router.get('/inventory', reportView, validate(inventoryQuery, 'query'), controller.inventory);
  router.get('/branches', reportView, controller.branches);
  router.get('/users', userManage, controller.users);

  return router;
}
