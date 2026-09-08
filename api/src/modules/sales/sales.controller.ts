import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { AppError } from '../../shared/errors.js';
import { createSalesService } from './sales.service.js';
import type { RealtimeEmitter } from '../../realtime/socket.js';
import { REALTIME_EVENTS } from '../../realtime/socket.js';

export function createSalesController(database: PrismaClient, realtime?: RealtimeEmitter) {
  const service = createSalesService(database);
  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.userId;
  return {
    pending: (async (req, res) => {
      // No client filters: branch scope comes exclusively from fresh authorization.
      if (Object.keys(req.query).length > 0) {
        throw new AppError(400, 'VALIDATION_ERROR', 'La cola no admite parámetros de consulta.');
      }
      sendJson(res, { items: await service.listPendingSales(req.auth!.branchIds) });
    }) as RequestHandler,
    create: (async (req, res) => {
      const sale = await service.createDraftSale(req, userId(req), req.body.branchId);
      sendJson(res.status(201), sale);
    }) as RequestHandler,
    list: (async (req, res) => {
      sendJson(res, { items: await service.listDrafts(userId(req), req.auth!.branchIds) });
    }) as RequestHandler,
    get: (async (req, res) => {
      sendJson(res, await service.getDraft(req, userId(req), String(req.params.saleId)));
    }) as RequestHandler,
    addItem: (async (req, res) => {
      sendJson(res, await service.addItem(req, userId(req), String(req.params.saleId), req.body));
    }) as RequestHandler,
    updateItem: (async (req, res) => {
      sendJson(res, await service.updateItem(req, userId(req), String(req.params.saleId), String(req.params.itemId), req.body));
    }) as RequestHandler,
    removeItem: (async (req, res) => {
      sendJson(res, await service.removeItem(req, userId(req), String(req.params.saleId), String(req.params.itemId)));
    }) as RequestHandler,
    sendToCashier: (async (req, res) => {
      const sale = await service.sendToCashier(String(req.params.saleId), userId(req), req.auth!.branchIds);
      realtime?.emit(REALTIME_EVENTS.salePendingPayment, { branchId: sale.branchId, saleId: sale.id, saleNumber: sale.saleNumber, status: sale.status });
      sendJson(res, sale);
    }) as RequestHandler,
    complete: (async (req, res) => {
      const sale = await service.completeSale(req, userId(req), String(req.params.saleId));
      realtime?.emit(REALTIME_EVENTS.saleCompleted, { branchId: sale.branchId, saleId: sale.id, saleNumber: sale.saleNumber, status: sale.status });
      realtime?.emit(REALTIME_EVENTS.inventoryUpdated, { branchId: sale.branchId, saleId: sale.id, status: sale.status });
      sendJson(res, sale);
    }) as RequestHandler,
  };
}
