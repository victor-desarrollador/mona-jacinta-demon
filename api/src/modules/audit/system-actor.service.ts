import type { PrismaClient } from '../../generated/prisma/client.js';
import { AppError } from '../../shared/errors.js';

// Pilot P0.1-B1: the dedicated technical User that system-generated
// reservation-expiry audits are attributed to (AuditLog.userId is NOT NULL
// with a FK to User). It is deliberately inactive (login refuses inactive
// users), holds zero UserRoleScope and zero legacy UserBranchRole rows (so
// it resolves zero permissions and zero locations), and is not one of the
// canonical demo users. The id contains hex letters, so prisma/seed.ts's
// decimal id(n) helper can never produce it.
export const SYSTEM_ACTOR_USER_ID = '00000000-0000-4000-8000-00000000a001';
export const SYSTEM_ACTOR_EMAIL = 'system-reservation-expiry@system.local';
export const SYSTEM_ACTOR_NAME = 'Sistema (vencimiento de reservas)';

// Same advisory lock prisma/seed.ts and canonical-owner-bootstrap use, so
// this bootstrap serializes against seed/reset maintenance.
const MAINTENANCE_ADVISORY_LOCK_ID = 506005;

type ActorDatabase = Pick<PrismaClient, 'user' | 'userRoleScope' | 'userBranchRole'>;
type BootstrapDatabase = ActorDatabase & Pick<PrismaClient, '$transaction'>;

export type SystemActorState = 'ABSENT' | 'VALID' | 'INVALID';
export type SystemActorPlan = { state: SystemActorState; readyForExecution: boolean; blockers: string[] };
export type SystemActorBootstrapResult = { action: 'CREATED' | 'NOOP_ALREADY_VALID'; userId: string };

// Least-privilege select: never load passwordHash.
const identitySelect = { id: true, email: true, name: true, isActive: true } as const;

// Read-only classification shared by the planner, the mutator and runtime
// resolution. Any deviation is a blocker; nothing is ever repaired.
async function inspect(db: ActorDatabase): Promise<{ state: SystemActorState; blockers: string[] }> {
  const byId = await db.user.findUnique({ where: { id: SYSTEM_ACTOR_USER_ID }, select: identitySelect });
  const byEmail = await db.user.findUnique({ where: { email: SYSTEM_ACTOR_EMAIL }, select: identitySelect });
  if (!byId && !byEmail) return { state: 'ABSENT', blockers: [] };
  if (!byId || !byEmail || byId.id !== byEmail.id) {
    return { state: 'INVALID', blockers: ['System actor identity conflict: canonical id and email resolve to different users'] };
  }
  const blockers: string[] = [];
  if (byId.name !== SYSTEM_ACTOR_NAME) blockers.push('System actor identity conflict: unexpected name');
  if (byId.isActive) blockers.push('System actor is active; it must stay inactive');
  const scopes = await db.userRoleScope.count({ where: { userId: SYSTEM_ACTOR_USER_ID } });
  if (scopes > 0) blockers.push(`System actor has ${scopes} UserRoleScope row(s); it must have no scope`);
  const legacy = await db.userBranchRole.count({ where: { userId: SYSTEM_ACTOR_USER_ID } });
  if (legacy > 0) blockers.push(`System actor has ${legacy} legacy UserBranchRole row(s); it must have none`);
  return { state: blockers.length > 0 ? 'INVALID' : 'VALID', blockers };
}

export async function planSystemActorBootstrap(db: ActorDatabase): Promise<SystemActorPlan> {
  const { state, blockers } = await inspect(db);
  return { state, readyForExecution: state !== 'INVALID', blockers };
}

// Idempotent: creates the actor when absent, verifies it when present, and
// fails closed (never repairs) on any conflict. createPasswordHash is only
// invoked on creation; callers hash a random, never-output secret so the
// row holds an unusable credential.
export async function bootstrapSystemActor(
  db: BootstrapDatabase,
  options: { createPasswordHash: () => Promise<string> },
): Promise<SystemActorBootstrapResult> {
  return db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(${MAINTENANCE_ADVISORY_LOCK_ID})::text`;
    const { state, blockers } = await inspect(tx);
    if (state === 'INVALID') throw new Error(`Refusing to bootstrap system actor: ${blockers.join('; ')}`);
    if (state === 'VALID') return { action: 'NOOP_ALREADY_VALID' as const, userId: SYSTEM_ACTOR_USER_ID };
    await tx.user.create({
      data: {
        id: SYSTEM_ACTOR_USER_ID,
        email: SYSTEM_ACTOR_EMAIL,
        name: SYSTEM_ACTOR_NAME,
        isActive: false,
        passwordHash: await options.createPasswordHash(),
      },
      select: { id: true },
    });
    return { action: 'CREATED' as const, userId: SYSTEM_ACTOR_USER_ID };
  });
}

// Runtime resolution for SYSTEM-triggered audits. Fails closed so automatic
// expiry never attributes audits to a missing or tampered actor.
export async function resolveSystemActorId(db: ActorDatabase): Promise<string> {
  const { state } = await inspect(db);
  if (state !== 'VALID') {
    throw new AppError(503, 'SYSTEM_ACTOR_UNAVAILABLE', 'El actor de sistema no está disponible.');
  }
  return SYSTEM_ACTOR_USER_ID;
}
