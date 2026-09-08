import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCancellationService } from './cancellation.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';

export function createCancellationController(database: PrismaClient, realtime?: RealtimeEmitter) {
  const service = createCancellationService(database);
  return {
    cancel: (async (req, res) => {
      const result = await service.cancelSale(String(req.params.saleId), { userId: req.auth!.userId, branchIds: req.auth!.branchIds });
      realtime?.emit(REALTIME_EVENTS.saleCancelled, result);
      if (result.released.length > 0) realtime?.emit(REALTIME_EVENTS.inventoryUpdated, result);
      sendJson(res, result);
    }) as RequestHandler,
    releaseExpired: (async (req, res) => {
      const result = await service.releaseExpiredReservations({ userId: req.auth!.userId, branchIds: req.auth!.branchIds });
      for (const release of result.released) realtime?.emit(REALTIME_EVENTS.inventoryUpdated, release);
      sendJson(res, result);
    }) as RequestHandler,
  };
}
