import { z } from 'zod';
import { roleCodeValues } from '../rbac/roles.js';

const roleCodeSchema = z.enum(roleCodeValues as [string, ...string[]]);

export const userIdParamsDto = z.object({ userId: z.uuid() }).strict();
export const userRoleParamsDto = z.object({ userId: z.uuid(), roleCode: roleCodeSchema }).strict();

// Structural validation only — role/scope-kind compatibility (OWNER/ADMIN ->
// COMPANY, CASHIER/SELLER/WAREHOUSE -> LOCATION) and every caller/target
// authorization decision belong to scope-assignment.service.ts, never here.
export const assignScopeDto = z
  .discriminatedUnion('scopeKind', [
    z
      .object({
        roleCode: roleCodeSchema,
        scopeKind: z.literal('LOCATION'),
        locationIds: z.array(z.uuid()).min(1),
      })
      .strict(),
    z.object({ roleCode: roleCodeSchema, scopeKind: z.literal('COMPANY') }).strict(),
  ])
  // Structural only: a request with duplicate ids for the same assignment
  // would otherwise reach the service's delete+create transaction and fail
  // there on the DB's partial unique index — reject earlier, at the
  // boundary, with a clear validation error instead.
  .superRefine((input, ctx) => {
    if (input.scopeKind !== 'LOCATION') return;
    if (new Set(input.locationIds).size !== input.locationIds.length) {
      ctx.addIssue({ code: 'custom', path: ['locationIds'], message: 'No se permiten ubicaciones duplicadas.' });
    }
  });

export type AssignScopeInput = z.infer<typeof assignScopeDto>;
