import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import {
  buildAuthorizationContext,
  type AuthorizationContextInput,
} from '../rbac/authorization-context.js';
import { toPublicUserContext } from './user-context.dto.js';
import { verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';
import type { LoginInput } from './dto/login.dto.js';

type AuthDatabase = Pick<PrismaClient, 'user' | 'location'>;

type UserRow = AuthorizationContextInput & { name: string; email: string; isActive: boolean; passwordHash: string };

const userSelect = {
  id: true,
  name: true,
  email: true,
  isActive: true,
  passwordHash: true,
  branchRoles: {
    select: {
      role: {
        select: {
          code: true,
          permissions: { select: { permission: { select: { code: true } } } },
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
} as const;

// Public API contract boundary: buildAuthorizationContext's internal,
// Production-authorization-shaped AuthContext (assignments/legacyPermissions/
// effectiveLocationIds) is deliberately NOT returned to callers of
// login/resolveUserContext — see user-context.dto.ts for why. This is the
// only place the internal context and the public DTO meet.
async function contextFromUser(database: AuthDatabase, user: UserRow) {
  const context = await buildAuthorizationContext(database, user);
  return toPublicUserContext(user, context);
}

export async function resolveUserContext(database: AuthDatabase, userId: string) {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(database, user);
}

export async function login(database: AuthDatabase, input: LoginInput) {
  const user = await database.user.findUnique({ where: { email: input.email }, select: userSelect });
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = await contextFromUser(database, user);
  return { accessToken: await signAccessToken(user.id), user: context };
}
