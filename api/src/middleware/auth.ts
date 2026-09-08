import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../config/prisma.js';
import { AppError } from '../shared/errors.js';

const key = new TextEncoder().encode(env.JWT_SECRET);

export function createRequireAuth(
  database: PrismaClient = defaultPrisma,
): RequestHandler {
  return async (req, _res, next) => {
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
        maxTokenAge: 900,
      });
      if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0)
        throw new Error('Missing token subject');

      const user = await database.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          isActive: true,
          branchRoles: {
            select: {
              branchId: true,
              role: {
                select: {
                  code: true,
                  permissions: { select: { permission: { select: { code: true } } } },
                },
              },
            },
          },
        },
      });
      if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
      if (!user.isActive)
        throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');

      const roles = [...new Set(user.branchRoles.map(({ role }) => role.code))];
      const branchIds = [...new Set(user.branchRoles.map(({ branchId }) => branchId))];
      const permissions = [
        ...new Set(
          user.branchRoles.flatMap(({ role }) =>
            role.permissions.map(({ permission }) => permission.code),
          ),
        ),
      ];
      req.userId = user.id;
      req.auth = { userId: user.id, roles, branchIds, permissions };
      next();
    } catch (error) {
      if (error instanceof AppError) {
        next(error);
        return;
      }
      next(
        new AppError(
          401,
          'UNAUTHORIZED',
          'El token de acceso no es válido o expiró.',
        ),
      );
    }
  };
}

export const requireAuth = createRequireAuth();
