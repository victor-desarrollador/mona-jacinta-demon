import { rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { AppError } from '../shared/errors.js';

export function createRateLimiter() {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    handler: (_req, _res, next) => {
      next(
        new AppError(
          429,
          'RATE_LIMITED',
          'Demasiadas solicitudes. Intentá nuevamente en un minuto.',
        ),
      );
    },
  });
}

// Pre-pilot fix 2A: brute-force brake that counts only failed requests
// (status >= 400) per caller-supplied key. In-memory store: per limiter
// instance, per API process. The key never reaches responses or logs.
export function createFailedAttemptLimiter(options: {
  windowMs: number;
  limit: number;
  message: string;
  keyGenerator: (req: Request) => string;
}) {
  return rateLimit({
    windowMs: options.windowMs,
    limit: options.limit,
    skipSuccessfulRequests: true,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    keyGenerator: options.keyGenerator,
    handler: (_req, _res, next) => {
      next(new AppError(429, 'RATE_LIMITED', options.message));
    },
  });
}
