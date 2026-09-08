import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { PERMISSIONS } from '../../shared/permissions.js';
import { createCashController } from './cash.controller.js';
import { cashBranchDto, cashSessionParamsDto, openCashDto, closeCashDto } from './cash.dto.js';

export function createCashRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createCashController(database);
  router.get('/register', validate(cashBranchDto, 'query'), controller.register);
  router.get('/current', validate(cashBranchDto, 'query'), controller.current);
  router.post('/sessions/open', requirePermission(PERMISSIONS.CASH_SESSION_OPEN), validate(openCashDto), controller.open);
  router.post('/sessions/:sessionId/close', requirePermission(PERMISSIONS.CASH_SESSION_CLOSE), validate(cashSessionParamsDto, 'params'), validate(closeCashDto), controller.close);
  return router;
}
