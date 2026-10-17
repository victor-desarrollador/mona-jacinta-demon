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
import {
  createBrandsRouter,
  createCategoriesRouter,
  createProductsRouter,
  createVariantsRouter,
} from './modules/products/products.routes.js';
import { createInventoryRouter } from './modules/inventory/inventory.routes.js';
import { createCashRouter } from './modules/cash/cash.routes.js';
import { createSalesRouter } from './modules/sales/sales.routes.js';
import { createPaymentsRouter } from './modules/payments/payments.routes.js';
import { createCheckoutAttemptsRouter } from './modules/payments/checkout-attempts-recent.routes.js';
import { createExternalCollectionsRouter } from './modules/payments/external-collections.routes.js';
import { createPricingRouter } from './modules/pricing/pricing.routes.js';
import { createReservationAdminRouter } from './modules/sales/cancellation.routes.js';
import { createAuditRouter } from './modules/audit/audit.routes.js';
import { createBackofficeRouter } from './modules/backoffice/backoffice.routes.js';
import { createNoopRealtimeEmitter, type RealtimeEmitter } from './realtime/socket.js';

export function createApp(database: PrismaClient = defaultPrisma, realtime: RealtimeEmitter = createNoopRealtimeEmitter()) {
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
  app.use('/api/v1/categories', createCategoriesRouter(database));
  app.use('/api/v1/brands', createBrandsRouter(database));
  app.use('/api/v1/pricing', createPricingRouter(database));
  app.use('/api/v1/inventory', createInventoryRouter(database));
  app.use('/api/v1/sales', createSalesRouter(database, realtime));
  // R3-A4.3 S-REF: the PROPORTIONAL_EXTERNAL_METHODS_ENABLED pilot gate is
  // validated once at startup and injected here; the quote and the reservation
  // read it from their options, never from the process.
  app.use('/api/v1/sales', createPaymentsRouter(database, realtime, {
    externalMethodsEnabled: env.PROPORTIONAL_EXTERNAL_METHODS_ENABLED,
  }));
  // R3-A4.3 S4: reload recovery of checkout attempts, outside /sales/:saleId.
  app.use('/api/v1/checkout-attempts', createCheckoutAttemptsRouter(database));
  // R3-A4.3 S-REF: the external collections the pilot records outside the POS
  // (refund + branch listing). The service decides scope and location.
  app.use('/api/v1/external-collections', createExternalCollectionsRouter(database));
  app.use('/api/v1/cash', createCashRouter(database));
  app.use('/api/v1/backoffice', createBackofficeRouter(database));
  app.use('/api/v1/admin', createReservationAdminRouter(database, realtime));
  app.use('/api/v1/audit', createAuditRouter(database));
  app.use((_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'No se encontró el recurso.'));
  });
  app.use(errorHandler);
  return app;
}
