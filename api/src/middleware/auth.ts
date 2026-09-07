import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import { env } from '../config/env.js';
import { AppError } from '../shared/errors.js';

const key = new TextEncoder().encode(env.JWT_SECRET);

export const requireAuth: RequestHandler = async (req, _res, next) => {
  const match = /^Bearer ([^\s]+)$/i.exec(req.headers.authorization ?? '');
  if (!match?.[1]) {
    next(
      new AppError(
        401,
        'UNAUTHORIZED',
        'Se requiere un token de acceso válido.',
      ),
    );
    return;
  }
  try {
    const { payload } = await jwtVerify(match[1], key, {
      algorithms: ['HS256'],
      requiredClaims: ['sub', 'iat', 'exp'],
      maxTokenAge: env.JWT_ACCESS_TTL_SECONDS,
    });
    if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0) {
      throw new Error('Missing token subject');
    }
    req.userId = payload.sub;
  } catch {
    next(
      new AppError(
        401,
        'UNAUTHORIZED',
        'El token de acceso no es válido o expiró.',
      ),
    );
    return;
  }
  // Only identity is attached. Roles, permissions and branch claims are never used.
  next();
};
