import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createPaymentsService } from './payments.service.js';
import type { RegisterPaymentInput } from './dto/payment.dto.js';

export function createPaymentsController(database: PrismaClient) {
  const service = createPaymentsService(database);
  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.userId;
  return {
    create: (async (req, res) => {
      const result = await service.registerPayment(req, userId(req), String(req.params.saleId), req.body as RegisterPaymentInput);
      sendJson(res.status(result.replayed ? 200 : 201), result.payment);
    }) as RequestHandler,
    list: (async (req, res) => {
      sendJson(res, { items: await service.listPayments(req, userId(req), String(req.params.saleId)) });
    }) as RequestHandler,
  };
}