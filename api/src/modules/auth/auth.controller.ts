import type { RequestHandler } from 'express';
import { prisma as defaultPrisma } from '../../config/prisma.js';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { sendJson } from '../../shared/json-safe.js';
import { loginSchema } from './dto/login.dto.js';
import { login, resolveUserContext } from './auth.service.js';

export function createAuthController(database: PrismaClient) {
  const loginHandler: RequestHandler = async (req, res) => {
    const input = loginSchema.parse(req.body);
    sendJson(res, await login(database, input));
  };

  const meHandler: RequestHandler = async (req, res) => {
    sendJson(res, { user: await resolveUserContext(database, req.auth!.userId) });
  };

  return { loginHandler, meHandler };
}

export const defaultAuthController = createAuthController(defaultPrisma);