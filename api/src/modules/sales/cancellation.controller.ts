import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCancellationService } from './cancellation.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';
import { hasPermissionAtLocation } from '../rbac/authorization-policy.js';
import { PRODUCTION_PERMISSIONS } from '../rbac/permissions.js';

export function createCancellationController(database: PrismaClient, realtime?: RealtimeEmitter) {
  const service = createCancellationService(database);
  return {
    cancel: (async (req, res) => {
      const result = await service.cancelSale(req, String(req.params.saleId));
      realtime?.emit(REALTIME_EVENTS.saleCancelled, result);
      if (result.released.length > 0) realtime?.emit(REALTIME_EVENTS.inventoryUpdated, result);
      sendJson(res, result);
    }) as RequestHandler,
    releaseExpired: (async (req, res) => {
      // Pilot P0.1-B1: only locations where the SAME assignment grants
      // INVENTORY_MANAGE — never the cross-assignment effectiveLocationIds union.
      const auth = req.auth!;
      const branchIds = auth.effectiveLocationIds.filter((branchId) =>
        hasPermissionAtLocation(auth, PRODUCTION_PERMISSIONS.INVENTORY_MANAGE, branchId));
      const result = await service.releaseExpiredReservations({ userId: auth.userId, branchIds });
      for (const release of result.released) realtime?.emit(REALTIME_EVENTS.inventoryUpdated, release);
      sendJson(res, result);
    }) as RequestHandler,
  };
}
