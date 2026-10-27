import { isIP } from 'node:net';
import { ipKeyGenerator, rateLimit } from 'express-rate-limit';
import type { Request } from 'express';
import { env, type Env } from '../config/env.js';
import { AppError } from '../shared/errors.js';

type ClientIpSource = Env['CLIENT_IP_SOURCE'];

// Pre-pilot fix 2B: X-Real-IP is used only when explicitly opted in and only
// as one valid IP; anything else falls back to the TCP peer. X-Forwarded-For
// is never read and trust proxy stays unset. IPv6 is grouped per /56.
export function clientRateLimitKey(
  req: Pick<Request, 'headers' | 'socket'>,
  source: ClientIpSource,
): string {
  const header = source === 'x-real-ip' ? req.headers['x-real-ip'] : undefined;
  const candidate = typeof header === 'string' ? header.trim() : '';
  const ip = isIP(candidate) ? candidate : req.socket.remoteAddress;
  if (!ip || !isIP(ip)) return 'unknown-client';
  try {
    return ipKeyGenerator(ip);
  } catch {
    return 'unknown-client';
  }
}

export function createRateLimiter(
  { clientIpSource = env.CLIENT_IP_SOURCE }: { clientIpSource?: ClientIpSource } = {},
) {
  return rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // A custom key also skips express-rate-limit's req.ip/X-Forwarded-For
    // checks, which only run inside its default keyGenerator.
    keyGenerator: (req) => clientRateLimitKey(req, clientIpSource),
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
