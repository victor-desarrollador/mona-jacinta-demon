import type { RequestHandler } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { createCashService } from './cash.service.js';

export function createCashController(database: PrismaClient) {
  const service = createCashService(database);
  return {
    register: (async (req, res) => {
      sendJson(res, await service.getRegister(String(req.query.branchId), req.auth!));
    }) as RequestHandler,
    current: (async (req, res) => {
      sendJson(res, await service.getCurrentSession(String(req.query.branchId), req.auth!));
    }) as RequestHandler,
    open: (async (req, res) => {
      sendJson(res.status(201), await service.openSession(req.body.registerId, req.auth!, req.body.startingCash));
    }) as RequestHandler,
    close: (async (req, res) => {
      sendJson(res, await service.closeSession(String(req.params.sessionId), req.auth!, req.body.closingCash));
    }) as RequestHandler,
    // CASH-1: close history for one authorized location.
    history: (async (req, res) => {
      sendJson(res, await service.listSessions(String(req.query.branchId), req.auth!));
    }) as RequestHandler,
    // PILOT cash exits (migration 10): the route fixes the movement type.
    withdraw: (async (req, res) => {
      sendJson(res.status(201), await service.registerMovement('WITHDRAWAL', String(req.params.sessionId), req.auth!, req.body));
    }) as RequestHandler,
    expense: (async (req, res) => {
      sendJson(res.status(201), await service.registerMovement('EXPENSE', String(req.params.sessionId), req.auth!, req.body));
    }) as RequestHandler,
    // PILOT reversal (migration 11): the path names the session and the original.
    reverse: (async (req, res) => {
      sendJson(res.status(201), await service.reverseMovement(String(req.params.sessionId), String(req.params.movementId), req.auth!, req.body));
    }) as RequestHandler,
    movements: (async (req, res) => {
      sendJson(res, await service.listMovements(String(req.params.sessionId), req.auth!));
    }) as RequestHandler,
  };
}
