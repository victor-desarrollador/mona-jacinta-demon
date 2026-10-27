import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { REALTIME_EVENTS, type RealtimeEmitter } from '../../realtime/socket.js';
import { createSaleExchangeService, type SaleExchangeResult, type SaleExchangeService } from './sale-exchange.service.js';

// POST /sales/:saleId/exchanges. A thin adapter, like the sale void controller: the service decides everything (authorization against the
// persisted branch, state, stock, price, idempotency, audit) and the controller only
//   - answers 201 for a NEW exchange and 200 for an idempotent replay (the result already carries `replayed`);
//   - serializes BigInt through sendJson (decimal strings) and never sends the internal `inventories` snapshot;
//   - lets every AppError reach the error middleware unchanged;
//   - notifies realtime AFTER the service returned, i.e. after the transaction committed, and never for a replay.
// It writes nothing: no Inventory, no money.
export function createSaleExchangeController(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { saleExchangeService?: SaleExchangeService } = {},
) {
  const service = options.saleExchangeService ?? createSaleExchangeService(database);
  return {
    exchangeSale: (async (req, res) => {
      const { inventories, ...body } = await service.exchangeSale(req, String(req.params.saleId), req.body);
      if (!body.replayed) notify(realtime, body, inventories);
      sendJson(res.status(body.replayed ? 200 : 201), body);
    }) as RequestHandler,
  };
}

// The exchange is already committed: a failing notification must never turn it into an error response. The existing inventory.updated event is
// advisory (clients refetch authoritative state); it carries, for every Inventory the exchange modified (deduplicated, final state), the ids and
// the resulting quantities, and nothing else: no reason, no prices, no user.
function notify(realtime: RealtimeEmitter | undefined, result: Omit<SaleExchangeResult, 'inventories'>, inventories: SaleExchangeResult['inventories']) {
  if (!realtime || inventories.length === 0) return;
  try {
    realtime.emit(REALTIME_EVENTS.inventoryUpdated, {
      branchId: result.branchId,
      saleId: result.saleId,
      exchangeId: result.exchangeId,
      inventories: inventories.map(({ inventoryId, variantId, physical, reserved }) => ({ inventoryId, variantId, physical, reserved })),
    });
  } catch {
    /* realtime is best effort after the commit */
  }
}
