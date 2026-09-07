import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { prisma as defaultPrisma } from './config/prisma.js';
import type { PrismaClient } from './generated/prisma/client.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRequireAuth } from './middleware/auth.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { AppError } from './shared/errors.js';
import { sendJson } from './shared/json-safe.js';
import { logger } from './shared/logger.js';
import { createAuthRouter } from './modules/auth/auth.routes.js';
import { createProductsRouter, createVariantsRouter } from './modules/products/products.routes.js';
import { createInventoryRouter } from './modules/inventory/inventory.routes.js';

export function createApp(database: PrismaClient = defaultPrisma) {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: env.CORS_ORIGINS }));
  app.use(express.json({ limit: '100kb' }));
  app.use(createRateLimiter());
  app.use((_req, res, next) => {
    const requestId = randomUUID();
    res.setHeader('X-Request-Id', requestId);
    res.once('finish', () =>
      logger.info({
        event: 'request_completed',
        requestId,
        status: res.statusCode,
      }),
    );
    next();
  });

  app.get('/health', (_req, res) => {
    sendJson(res, { status: 'ok' });
  });
  app.use('/api/v1/auth', createAuthRouter(database));
  // Every future API route is private by default; login remains public above.
  app.use('/api/v1', createRequireAuth(database));
  app.use('/api/v1/products', createProductsRouter(database));
  app.use('/api/v1/variants', createVariantsRouter(database));
  app.use('/api/v1/inventory', createInventoryRouter(database));
  app.use((_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'No se encontró el recurso.'));
  });
  app.use(errorHandler);
  return app;
}
