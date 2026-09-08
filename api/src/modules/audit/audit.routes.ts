import { Router } from 'express';
import { z } from 'zod';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { requirePermission } from '../../middleware/authorization.js';
import { validate } from '../../middleware/validation.js';
import { sendJson } from '../../shared/json-safe.js';
import { PERMISSIONS } from '../../shared/permissions.js';

const query = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(2147483647).default(0),
}).strict();

export function createAuditRouter(database: PrismaClient): Router {
  const router = Router();
  // Mounted after createRequireAuth, which reloads permissions from the DB.
  router.get('/', requirePermission(PERMISSIONS.AUDIT_VIEW), validate(query, 'query'), async (req, res) => {
    const { limit, offset } = req.query as unknown as z.infer<typeof query>;
    const logs = await database.auditLog.findMany({
      orderBy: [{ timestamp: 'desc' }, { id: 'desc' }],
      take: limit,
      skip: offset,
    });
    sendJson(res, { data: logs, limit, offset });
  });
  return router;
}
