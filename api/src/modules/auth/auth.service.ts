import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
import { resolveEffectiveBranchIds } from '../rbac/effective-branch-ids.js';
import { mapUserRoleScopeRows } from '../rbac/scope-resolver.js';
import { verifyPassword } from './password.js';
import { signAccessToken } from './tokens.js';
import type { LoginInput } from './dto/login.dto.js';

type AuthDatabase = Pick<PrismaClient, 'user'>;

type UserContext = {
  id: string;
  name: string;
  email: string;
  roles: string[];
  branchIds: string[];
  permissions: string[];
};

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
      role: { select: { code: true } },
    },
  },
} as const;

function contextFromUser(user: {
  id: string;
  name: string;
  email: string;
  branchRoles: Array<{
    role: { code: string; permissions: Array<{ permission: { code: string } }> };
  }>;
  roleScopes: Array<{
    roleId: string;
    scopeKind: 'LOCATION' | 'COMPANY';
    locationId: string | null;
    role: { code: string };
  }>;
}): UserContext {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [...new Set(user.branchRoles.map(({ role }) => role.code))],
    branchIds: resolveEffectiveBranchIds(mapUserRoleScopeRows(user.roleScopes)),
    permissions: [
      ...new Set(
        user.branchRoles.flatMap(({ role }) =>
          role.permissions.map(({ permission }) => permission.code),
        ),
      ),
    ],
  };
}

export async function resolveUserContext(
  database: AuthDatabase,
  userId: string,
): Promise<UserContext> {
  const user = await database.user.findUnique({ where: { id: userId }, select: userSelect });
  if (!user) throw new AppError(401, 'UNAUTHORIZED', 'El token no es válido.');
  if (!user.isActive)
    throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  return contextFromUser(user);
}

export async function login(database: AuthDatabase, input: LoginInput) {
  const user = await database.user.findUnique({ where: { email: input.email }, select: userSelect });
  if (!user || !(await verifyPassword(input.password, user.passwordHash)))
    throw new AppError(401, 'INVALID_CREDENTIALS', 'Las credenciales no son válidas.');
  if (!user.isActive)
    throw new AppError(403, 'INACTIVE_USER', 'El usuario está inactivo.');
  const context = contextFromUser(user);
  return { accessToken: await signAccessToken(user.id), user: context };
}
