// R3-A4.1 (R3 rev. 2 §5): HTTP boundary of POST /sales/:saleId/checkout/quote.
//
// The controller does exactly two things: it hands the already-validated request
// to the quote service and returns its answer. It never prices, never totals,
// never opens a transaction, never writes a row and notifies no client: the
// answer is a read-only projection and PostgreSQL stays the source of truth.
// The definitive checkout recomputes everything under its own transaction.
import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import {
  createCheckoutQuoteService,
  type CheckoutQuoteRequest,
  type CheckoutQuoteService,
} from './checkout-quote.service.js';

export function createCheckoutQuoteController(
  database: PrismaClient,
  options: { service?: CheckoutQuoteService } = {},
) {
  const service = options.service ?? createCheckoutQuoteService(database);

  return {
    quote: (async (req, res) => {
      const result = await service.quote(req, String(req.params.saleId), req.body as CheckoutQuoteRequest);
      sendJson(res.status(200), result);
    }) as RequestHandler,
  };
}
