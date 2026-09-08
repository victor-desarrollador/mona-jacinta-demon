import { Router } from 'express';
import type { PrismaClient } from '../../generated/prisma/client.js';
import { createRequireAuth } from '../../middleware/auth.js';
import { createAuthController } from './auth.controller.js';

export function createAuthRouter(database: PrismaClient): Router {
  const router = Router();
  const controller = createAuthController(database);
  router.post('/login', controller.loginHandler);
  router.get('/me', createRequireAuth(database), controller.meHandler);
  return router;
}