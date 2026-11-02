import { z } from 'zod';
import { roleCodeValues } from '../rbac/index.js';
import { normalizeName } from './user-admin-request.js';

// USER-MGMT-01 U2 — request bodies of the administrative identity operations. Strict everywhere: a client can never name a password, an
// isActive flag, a hash or any other field. Email is trimmed and lower-cased HERE (the application normalizes; the lower(email) unique index of
// G22 is only the backstop). Names keep their case and accents. Role/scope compatibility and every caller/target decision belong to
// user-admin.service.ts, never to a DTO.
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const idempotencyKey = z.string().regex(UUID_V4, 'La clave de idempotencia debe ser un UUID v4.');
const name = z.string().transform(normalizeName).pipe(z.string().min(1).max(100));
const email = z.string().trim().toLowerCase().pipe(z.email().max(254));
const roleCode = z.enum(roleCodeValues as [string, ...string[]]);

const base = { name, email, roleCode, idempotencyKey };

export const createUserDto = z
  .discriminatedUnion('scopeKind', [
    z.object({ ...base, scopeKind: z.literal('LOCATION'), locationIds: z.array(z.uuid()).min(1) }).strict(),
    z.object({ ...base, scopeKind: z.literal('COMPANY') }).strict(),
  ])
  .superRefine((input, ctx) => {
    if (input.scopeKind !== 'LOCATION') return;
    if (new Set(input.locationIds).size !== input.locationIds.length) {
      ctx.addIssue({ code: 'custom', path: ['locationIds'], message: 'No se permiten ubicaciones duplicadas.' });
    }
  });
export type CreateUserInput = z.infer<typeof createUserDto>;

// PATCH: name and/or email only (roles and scopes keep using the scope endpoints).
export const updateUserDto = z
  .object({ name: name.optional(), email: email.optional() })
  .strict()
  .refine((input) => input.name !== undefined || input.email !== undefined, { message: 'Indicá al menos un campo para modificar.' });
export type UpdateUserInput = z.infer<typeof updateUserDto>;

// deactivate / reactivate / reset-password: the body is exactly the idempotency key.
export const adminOperationDto = z.object({ idempotencyKey }).strict();
export type AdminOperationInput = z.infer<typeof adminOperationDto>;
