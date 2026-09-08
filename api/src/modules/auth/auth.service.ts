import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';
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
      branchId: true,
      role: {
        select: {
          code: true,
          permissions: { select: { permission: { select: { code: true } } } },
        },
      },
    },
  },
} as const;

function contextFromUser(user: {
  id: string;
  name: string;
  email: string;
  branchRoles: Array<{
    branchId: string;
    role: { code: string; permissions: Array<{ permission: { code: string } }> };
  }>;
}): UserContext {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: [...new Set(user.branchRoles.map(({ role }) => role.code))],
    branchIds: [...new Set(user.branchRoles.map(({ branchId }) => branchId))],
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