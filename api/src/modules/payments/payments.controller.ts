import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createPaymentsService } from './payments.service.js';
import type { RegisterPaymentInput } from './dto/payment.dto.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';

export function createPaymentsController(database: PrismaClient, realtime?: RealtimeEmitter) {
  const service = createPaymentsService(database);
  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.userId;
  return {
    create: (async (req, res) => {
      const result = await service.registerPayment(req, userId(req), String(req.params.saleId), req.body as RegisterPaymentInput);
      if (!result.replayed && result.resultingStatus === 'PAID') {
        realtime?.emit(REALTIME_EVENTS.salePaid, { branchId: result.branchId, saleId: result.saleId, status: result.resultingStatus });
      }
      sendJson(res.status(result.replayed ? 200 : 201), result.payment);
    }) as RequestHandler,
    list: (async (req, res) => {
      sendJson(res, { items: await service.listPayments(req, userId(req), String(req.params.saleId)) });
    }) as RequestHandler,
  };
}