import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createSalesService } from './sales.service.js';

export function createSalesController(database: PrismaClient) {
  const service = createSalesService(database);
  const userId = (req: Parameters<RequestHandler>[0]) => req.auth!.userId;
  return {
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
      sendJson(res, await service.sendToCashier(String(req.params.saleId), userId(req), req.auth!.branchIds));
    }) as RequestHandler,
  };
}