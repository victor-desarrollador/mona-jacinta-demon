import { randomUUID } from 'node:crypto';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { env } from './config/env.js';
import { errorHandler } from './middleware/errorHandler.js';
import { createRateLimiter } from './middleware/rateLimit.js';
import { AppError } from './shared/errors.js';
import { sendJson } from './shared/json-safe.js';
import { logger } from './shared/logger.js';

export function createApp() {
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
  app.use((_req, _res, next) => {
    next(new AppError(404, 'NOT_FOUND', 'No se encontró el recurso.'));
  });
  app.use(errorHandler);
  return app;
}
