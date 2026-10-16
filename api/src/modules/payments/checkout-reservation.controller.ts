// R3-A4.3 S4: HTTP boundary of the durable reservation (T-R) and of the two
// per-sale reads. It hands the already-validated request to the service (the
// only authority: it locks, checks, writes and commits) and serialises the
// result; a new reservation is 201, a replay 200. No realtime emission in S4.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCheckoutReservationService, type CheckoutReservationService } from './checkout-reservation.service.js';
import type { CheckoutReservationRequest } from './dto/checkout-reservation.dto.js';

export function createCheckoutReservationController(database: PrismaClient, options: { service?: CheckoutReservationService } = {}) {
  const service = options.service ?? createCheckoutReservationService(database);
  return {
    reserve: (async (req, res) => {
      const result = await service.reserve(req, String(req.params.saleId), req.body as CheckoutReservationRequest);
      sendJson(res.status(result.replayed ? 200 : 201), result.view);
    }) as RequestHandler,
    list: (async (req, res) => {
      sendJson(res.status(200), await service.listForSale(req, String(req.params.saleId)));
    }) as RequestHandler,
    get: (async (req, res) => {
      sendJson(res.status(200), await service.getForSale(req, String(req.params.saleId), String(req.params.reserveKey)));
    }) as RequestHandler,
  };
}
