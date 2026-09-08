import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCashService } from './cash.service.js';

export function createCashController(database: PrismaClient) {
  const service = createCashService(database);
  return {
    register: (async (req, res) => {
      sendJson(res, await service.getRegister(String(req.query.branchId), req.auth!.branchIds));
    }) as RequestHandler,
    current: (async (req, res) => {
      sendJson(res, await service.getCurrentSession(String(req.query.branchId), req.auth!.branchIds));
    }) as RequestHandler,
    open: (async (req, res) => {
      sendJson(res.status(201), await service.openSession(req.body.registerId, req.auth!.userId, req.auth!.branchIds, req.body.startingCash));
    }) as RequestHandler,
    close: (async (req, res) => {
      sendJson(res, await service.closeSession(String(req.params.sessionId), req.auth!.userId, req.auth!.branchIds, req.body.closingCash));
    }) as RequestHandler,
  };
}
