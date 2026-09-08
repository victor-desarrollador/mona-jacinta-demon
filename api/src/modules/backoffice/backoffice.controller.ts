import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createBackofficeService } from './backoffice.service.js';

export function createBackofficeController(database: PrismaClient) {
  const service = createBackofficeService(database);
  return {
    dashboard: (async (req, res) => {
      sendJson(res, await service.dashboard(req));
    }) as RequestHandler,
    sales: (async (req, res) => {
      sendJson(res, await service.listSales(req, req.query as never));
    }) as RequestHandler,
    saleDetail: (async (req, res) => {
      sendJson(res, await service.getSale(req, String(req.params.id)));
    }) as RequestHandler,
    inventory: (async (req, res) => {
      sendJson(res, await service.inventory(req, req.query as never));
    }) as RequestHandler,
    branches: (async (req, res) => {
      sendJson(res, await service.branches(req));
    }) as RequestHandler,
    users: (async (req, res) => {
      sendJson(res, await service.users(req));
    }) as RequestHandler,
  };
}
