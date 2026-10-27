import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createCashController } from './cash.controller.js';
import { cashBranchDto, cashSessionParamsDto, openCashDto, closeCashDto, cashMovementDto, cashMovementParamsDto, cashMovementReversalDto } from './cash.dto.js';

export function createCashRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createCashController(database);
  // Task 1D.5.3's firm decision: GET /register and GET /current keep no
  // permission gate at all (no CASH_VIEW exists in the Production catalog) —
  // only coarse branch membership, enforced inside cash.service.ts via
  // hasBranchAccess.
  router.get('/register', validate(cashBranchDto, 'query'), controller.register);
  router.get('/current', validate(cashBranchDto, 'query'), controller.current);
  // CASH-1: close history, location-authorized. The route gate is the Production
  // CASH_SESSION_CLOSE grant; cash.service.ts pairs it with the register's own
  // persisted branchId, so only locations in the caller's effective
  // UserRoleScope are ever listed.
  router.get('/sessions', requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE), validate(cashBranchDto, 'query'), controller.history);
  router.post('/sessions/open', requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_OPEN), validate(openCashDto), controller.open);
  router.post('/sessions/:sessionId/close', requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE), validate(cashSessionParamsDto, 'params'), validate(closeCashDto), controller.close);
  // PILOT cash exits (migration 10): the route fixes the movement type. The
  // route gate is the Production CASH_MOVEMENT_MANAGE grant; cash.service.ts
  // pairs it with the session's register branchId, and a WITHDRAWAL additionally
  // requires a supervisor (OWNER / COMPANY-scoped ADMIN).
  router.post('/sessions/:sessionId/withdrawals', requirePermission(PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE), validate(cashSessionParamsDto, 'params'), validate(cashMovementDto), controller.withdraw);
  router.post('/sessions/:sessionId/expenses', requirePermission(PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE), validate(cashSessionParamsDto, 'params'), validate(cashMovementDto), controller.expense);
  router.get('/sessions/:sessionId/movements', requirePermission(PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE), validate(cashSessionParamsDto, 'params'), controller.movements);
  // PILOT reversal (migration 11): corrects a WITHDRAWAL/EXPENSE with an
  // append-only compensating movement. The route gate is CASH_MOVEMENT_MANAGE;
  // cash.service.ts additionally requires a supervisor (OWNER / COMPANY-scoped
  // ADMIN) at the session's register branchId. The amount and type always come
  // from the original movement, never from the body.
  router.post('/sessions/:sessionId/movements/:movementId/reversal', requirePermission(PRODUCTION_PERMISSIONS.CASH_MOVEMENT_MANAGE), validate(cashMovementParamsDto, 'params'), validate(cashMovementReversalDto), controller.reverse);
  return router;
}
