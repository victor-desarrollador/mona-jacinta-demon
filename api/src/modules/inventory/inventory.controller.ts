import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createInventoryService } from './inventory.service.js';

export function createInventoryController(database: PrismaClient) {
  const service = createInventoryService(database);
  return {
    getInventoryByBranch: (async (req, res) => {
      sendJson(res, {
        items: await service.getInventoryByBranch(String(req.query.branchId)),
      });
    }) as RequestHandler,
    getAvailability: (async (req, res) => {
      const variantIds = req.query.variantId as string[] | undefined;
      sendJson(res, {
        items: await service.getAvailability(
          String(req.query.branchId),
          variantIds,
        ),
      });
    }) as RequestHandler,
  };
}
