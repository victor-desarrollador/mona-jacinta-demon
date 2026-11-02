import { Router, type RequestHandler } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createBackofficeController } from './backoffice.controller.js';
import { assignScopeDto, userIdParamsDto, userRoleParamsDto } from './scope-assignment.dto.js';
import { createNoopSessionRevoker, type SessionRevoker } from '../../realtime/session-revoker.js';
import { adminOperationDto, createUserDto, updateUserDto } from './user-admin.dto.js';

const limit = z.coerce.number().int().min(1).max(100).default(50);
const offset = z.coerce.number().int().min(0).default(0);
const date = z.string();
// dateFrom/dateTo llegan como string: ISO timestamp (compatibilidad) o
// fecha de negocio "YYYY-MM-DD" (zona de Tucuman, P0-C). El servicio los interpreta.

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

// The identity lifecycle answers carry a temporary password (once) and account data: never cached by the browser or any proxy. Set BEFORE the
// permission gate, the validation and the handler, so the header is also on every refusal.
const noStore: RequestHandler = (_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
};

export function createBackofficeRouter(database: PrismaClient, sessionRevoker: SessionRevoker = createNoopSessionRevoker()): Router {
  const router = Router();
  const controller = createBackofficeController(database, sessionRevoker);
  const reportView = requirePermission(PRODUCTION_PERMISSIONS.REPORT_VIEW);
  const userManage = requirePermission(PRODUCTION_PERMISSIONS.USER_MANAGE);

  router.get('/dashboard', reportView, controller.dashboard);
  router.get('/sales', reportView, validate(salesQuery, 'query'), controller.sales);
  router.get('/sales/:id', reportView, validate(saleParams, 'params'), controller.saleDetail);
  router.get('/inventory', reportView, validate(inventoryQuery, 'query'), controller.inventory);
  router.get('/branches', reportView, controller.branches);
  router.get('/users', userManage, controller.users);
  // Phase 1D.4.4: this is the security dependency Task 1D.4.3 deliberately
  // deferred — scope-assignment.service.ts is only safe against a
  // CASHIER/SELLER/WAREHOUSE caller once USER_MANAGE gates both routes
  // below, before the controller/service is ever invoked.
  router.post(
    '/users/:userId/scope',
    validate(userIdParamsDto, 'params'),
    validate(assignScopeDto),
    userManage,
    controller.assignScope,
  );
  // USER-MGMT-01 U2 — identity lifecycle. The permission gate (USER_MANAGE at COMPANY scope) runs BEFORE validation so an unauthorised caller learns
  // nothing about the request schema; the body is strict (no password, no isActive, no unknown field ever reaches the service).
  router.post('/users', noStore, userManage, validate(createUserDto), controller.createUser);
  router.patch('/users/:userId', noStore, userManage, validate(userIdParamsDto, 'params'), validate(updateUserDto), controller.updateUser);
  router.post('/users/:userId/deactivate', noStore, userManage, validate(userIdParamsDto, 'params'), validate(adminOperationDto), controller.deactivateUser);
  router.post('/users/:userId/reactivate', noStore, userManage, validate(userIdParamsDto, 'params'), validate(adminOperationDto), controller.reactivateUser);
  router.post('/users/:userId/reset-password', noStore, userManage, validate(userIdParamsDto, 'params'), validate(adminOperationDto), controller.resetUserPassword);
  router.delete(
    '/users/:userId/scope/:roleCode',
    validate(userRoleParamsDto, 'params'),
    userManage,
    controller.revokeScope,
  );

  return router;
}
