import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import {
  buildAuthorizationContext,
  type AuthorizationContextInput,
} from '../rbac/authorization-context.js';
import { toPublicUserContext, type PublicBranchLabel, type PublicSessionUser } from './user-context.dto.js';
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
  // Phase 1D.3.6: UserBranchRole no longer needs its permissions selected —
  // it contributes only role.code, for the roles[] display union. It can
  // never again contribute permission authority of any kind.
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
} as const;

// Public API contract boundary: buildAuthorizationContext's internal,
// Production-authorization-shaped AuthContext (assignments/
// effectiveLocationIds) is deliberately NOT returned to callers of
// login/resolveUserContext — see user-context.dto.ts for why. This is the
// only place the internal context and the public DTO meet.
//
// `branches` is display data for the client's branch selector (id, name, code), read for the caller's EFFECTIVE locations only and returned
// in `branchIds` order. It never feeds an authorization decision: the selector's options still come from `branchIds`.
async function contextFromUser(database: AuthDatabase, user: UserRow): Promise<PublicSessionUser> {
  const context = await buildAuthorizationContext(database, user);
  const publicContext = toPublicUserContext(user, context);
  const ids = publicContext.branchIds;
  const rows = ids.length === 0 ? [] : await database.location.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, code: true } });
  const byId = new Map(rows.filter((row) => typeof row.name === 'string' && typeof row.code === 'string').map((row) => [row.id, row]));
  const branches = ids.flatMap((id): PublicBranchLabel[] => {
    const row = byId.get(id);
    return row ? [{ id: row.id, name: row.name, code: row.code }] : [];
  });
  return { ...publicContext, branches };
}

export async function resolveUserContext(database: AuthDatabase, userId: string): Promise<PublicSessionUser> {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(database, user);
}

export async function login(database: AuthDatabase, input: LoginInput): Promise<{ accessToken: string; user: PublicSessionUser }> {
  const user = await database.user.findUnique({ where: { email: input.email }, select: userSelect });
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive) throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = await contextFromUser(database, user);
  return { accessToken: await signAccessToken(user.id), user: context };
}
