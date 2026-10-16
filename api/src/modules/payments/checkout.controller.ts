// R3-A3.3 (R3 rev. 2 §5): HTTP boundary of POST /sales/:saleId/checkout.
//
// The controller does exactly two things: it hands the already-validated request
// to the checkout service (the only settlement authority: it prices, opens the
// one Serializable transaction and commits) and, once the service has
// COMMITTED, it emits the advisory realtime notifications on those rows. It
// never prices, totals, opens a transaction or writes a row.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCheckoutService, type CheckoutRequest, type CheckoutService } from './checkout.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';
import { logger } from '../../shared/logger.js';

export function createCheckoutController(
  database: PrismaClient,
  realtime?: RealtimeEmitter,
  options: { service?: CheckoutService } = {},
) {
  const service = options.service ?? createCheckoutService(database);
  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.userId;

  // Pilot P0.1-C rule: the checkout is already committed when this runs, so the
  // notification is advisory. Resolving the sale's branch (the routing key of
  // the payload; the approved CheckoutResult deliberately carries none) and
  // emitting are both inside the guard: a failure is logged with a safe code
  // only and never turns a committed checkout into an HTTP error. Clients
  // refetch authoritative state.
  async function notifyCommitted(saleId: string, saleNumber: string | null, status: string) {
    try {
      const sale = await database.sale.findFirst({ where: { id: saleId }, select: { branchId: true } });
      if (!sale) return;
      realtime?.emit(REALTIME_EVENTS.saleCompleted, { branchId: sale.branchId, saleId, saleNumber, status });
      realtime?.emit(REALTIME_EVENTS.inventoryUpdated, { branchId: sale.branchId, saleId, status });
    } catch {
      logger.warn({ event: 'sale_checkout_notify_failed', saleId, code: 'NOTIFY_FAILED' });
    }
  }

  return {
    create: (async (req, res) => {
      const result = await service.checkout(req, userId(req), String(req.params.saleId), req.body as CheckoutRequest);
      // A replay changed nothing: the original call already notified.
      if (!result.replayed) await notifyCommitted(result.saleId, result.saleNumber, result.status);
      sendJson(res.status(result.replayed ? 200 : 201), result);
    }) as RequestHandler,
  };
}
