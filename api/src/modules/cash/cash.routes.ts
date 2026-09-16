import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createCashController } from './cash.controller.js';
import { cashBranchDto, cashSessionParamsDto, openCashDto, closeCashDto } from './cash.dto.js';

export function createCashRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createCashController(database);
  // Task 1D.5.3's firm decision: GET /register and GET /current keep no
  // permission gate at all (no CASH_VIEW exists in the Production catalog) —
  // only coarse branch membership, enforced inside cash.service.ts via
  // hasBranchAccess.
  router.get('/register', validate(cashBranchDto, 'query'), controller.register);
  router.get('/current', validate(cashBranchDto, 'query'), controller.current);
  router.post('/sessions/open', requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_OPEN), validate(openCashDto), controller.open);
  router.post('/sessions/:sessionId/close', requirePermission(PRODUCTION_PERMISSIONS.CASH_SESSION_CLOSE), validate(cashSessionParamsDto, 'params'), validate(closeCashDto), controller.close);
  return router;
}
