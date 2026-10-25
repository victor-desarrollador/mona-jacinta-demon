import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { REALTIME_EVENTS, type RealtimeEmitter } from '../../realtime/socket.js';
import { createSaleVoidService, type SaleVoidResult, type SaleVoidService } from './sale-void.service.js';

// POST /sales/:saleId/void. A thin adapter: the service decides everything (authorization against the
// persisted branch, state, idempotency, stock, cash, evidence, audit) and the controller only
//   - answers 201 for a NEW void and 200 for an idempotent replay (the result already carries `replayed`);
//   - serializes BigInt through sendJson (decimal strings);
//   - lets every AppError reach the error middleware unchanged;
//   - notifies realtime AFTER the service returned, i.e. after the transaction committed, and never for a replay.
// No cash realtime event exists in the project (the cash UI reads the session through its HTTP endpoints),
// so none is invented here.
export function createSaleVoidController(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { saleVoidService?: SaleVoidService } = {},
) {
  const service = options.saleVoidService ?? createSaleVoidService(database);
  return {
    voidSale: (async (req, res) => {
      const result = await service.voidSale(req, String(req.params.saleId), req.body);
      if (!result.replayed) notify(realtime, result);
      sendJson(res.status(result.replayed ? 200 : 201), result);
    }) as RequestHandler,
  };
}

// The void is already committed: a failing notification must never turn it into an error response. The
// sale.voided payload is a safe summary (no reason, no evidence, no payments, no money); inventory.updated
// only when stock actually moved, carrying variant quantities and nothing else.
function notify(realtime: RealtimeEmitter | undefined, result: SaleVoidResult) {
  if (!realtime) return;
  try {
    realtime.emit(REALTIME_EVENTS.saleVoided, {
      branchId: result.branchId, saleId: result.saleId, status: result.status, previousStatus: result.previousStatus, voidId: result.voidId,
    });
    if (result.stockReturned.length > 0 || result.reservationsReleased.length > 0) {
      realtime.emit(REALTIME_EVENTS.inventoryUpdated, {
        branchId: result.branchId,
        saleId: result.saleId,
        stockReturned: result.stockReturned.map(({ variantId, inventoryId, quantity }) => ({ variantId, inventoryId, quantity })),
        reservationsReleased: result.reservationsReleased.map(({ variantId, quantity }) => ({ variantId, quantity })),
      });
    }
  } catch {
    /* realtime is best effort after the commit */
  }
}
