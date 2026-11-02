import type { RequestHandler } from 'express';
import { jwtVerify } from 'jose';
import type { PrismaClient } from '../generated/prisma/client.js';
import { env } from '../config/env.js';
import { prisma as defaultPrisma } from '../config/prisma.js';
import { AppError } from '../shared/errors.js';
import { buildAuthorizationContext } from '../modules/rbac/authorization-context.js';
import { ACCESS_TOKEN_SECONDS } from '../modules/auth/tokens.js';
import { isCredentialsEpochCurrent } from '../modules/auth/credentials-epoch.js';

const key = new TextEncoder().encode(env.JWT_SECRET);

// USER-MGMT-01 U1: `allowPasswordChangePending` is the explicit, per-route allowance for an account whose password change is pending
// (mustChangePassword). It is passed ONLY by /auth/me and /auth/change-password; every other mount keeps the default and answers
// 403 PASSWORD_CHANGE_REQUIRED, so the block is enforced here, in the backend, and never by matching URLs.
export type RequireAuthOptions = { allowPasswordChangePending?: boolean };

export function createRequireAuth(
  database: PrismaClient = defaultPrisma,
  options: RequireAuthOptions = {},
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
        maxTokenAge: ACCESS_TOKEN_SECONDS,
      });
      if (typeof payload.sub !== 'string' || payload.sub.trim().length === 0)
        throw new Error('Missing token subject');

      const user = await database.user.findUnique({
        where: { id: payload.sub },
        select: {
          id: true,
          isActive: true,
          mustChangePassword: true,
          credentialsChangedAt: true,
          // Phase 1D.3.6: UserBranchRole no longer needs its permissions
          // selected — it contributes only role.code, for the roles[]
          // display union. It can never again contribute permission
          // authority of any kind.
          branchRoles: {
            select: {
              role: {
                select: {
                  code: true,
                },
              },
            },
          },
          roleScopes: {
            select: {
              roleId: true,
              scopeKind: true,
              locationId: true,
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
      // The token's credentials epoch (`cc`) must EQUAL the stored one: a changed or reset password invalidates every earlier token on its
      // next request. Exact equality in milliseconds; `iat` plays no part (see modules/auth/credentials-epoch.ts).
      if (!isCredentialsEpochCurrent(payload.cc, user.credentialsChangedAt))
        throw new AppError(401, 'UNAUTHORIZED', 'El token de acceso no es válido o expiró.');
      if (user.mustChangePassword && options.allowPasswordChangePending !== true)
        throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Necesitás cambiar tu contraseña antes de continuar.');

      req.userId = user.id;
      req.auth = await buildAuthorizationContext(database, user);
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
