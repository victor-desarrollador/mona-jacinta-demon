import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCancellationService } from './cancellation.service.js';

export function createCancellationController(database: PrismaClient) {
  const service = createCancellationService(database);
  return {
    cancel: (async (req, res) => {
      sendJson(res, await service.cancelSale(String(req.params.saleId), { userId: req.auth!.userId, branchIds: req.auth!.branchIds }));
    }) as RequestHandler,
    releaseExpired: (async (req, res) => {
      sendJson(res, await service.releaseExpiredReservations({ userId: req.auth!.userId, branchIds: req.auth!.branchIds }));
    }) as RequestHandler,
  };
}
