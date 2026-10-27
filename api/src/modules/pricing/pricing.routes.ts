import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { sendJson } from '../../shared/json-safe.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';
import { createPricingService } from './pricing.service.js';
import { updatePricingConfigSchema } from './pricing.dto.js';

export function createPricingRouter(database: PrismaClient): Router {
  const router = Router();
  const service = createPricingService(database);
  const manage = requirePermission(PRODUCTION_PERMISSIONS.PRICE_MANAGE);

  router.get('/config', manage, async (_req, res) => {
    sendJson(res, { config: await service.getConfig() });
  });

  router.patch('/config', manage, validate(updatePricingConfigSchema), async (req, res) => {
    sendJson(res, { config: await service.updateConfig(req.auth!.userId, req.body) });
  });

  return router;
}
