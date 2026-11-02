import type { RequestHandler } from 'express';
import { prisma as defaultPrisma } from '../../config/prisma.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { loginSchema } from './dto/login.dto.js';
import { changePassword, login, resolveUserContext } from './auth.service.js';
import type { ChangePasswordInput } from './dto/change-password.dto.js';
import { createNoopSessionRevoker, type SessionRevoker } from '../../realtime/session-revoker.js';

export function createAuthController(database: PrismaClient, sessionRevoker: SessionRevoker = createNoopSessionRevoker()) {
  const loginHandler: RequestHandler = async (req, res) => {
    const input = loginSchema.parse(req.body);
    sendJson(res, await login(database, input));
  };

  const meHandler: RequestHandler = async (req, res) => {
    sendJson(res, { user: await resolveUserContext(database, req.auth!.userId) });
  };

  // The body is already parsed by the route's strict schema. The response carries a token: never cacheable.
  const changePasswordHandler: RequestHandler = async (req, res) => {
    const result = await changePassword(database, req.auth!.userId, req.body as ChangePasswordInput, sessionRevoker);
    res.setHeader('Cache-Control', 'no-store');
    sendJson(res, result);
  };

  return { loginHandler, meHandler, changePasswordHandler };
}

export const defaultAuthController = createAuthController(defaultPrisma);