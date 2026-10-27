// R3-A4.3 S4: query of GET /checkout-attempts/recent (C1–C5 §4.1, C4).
// branchId canonical UUID v4; scope mine|branch; limit 1..50 (default 20);
// since ISO-8601 instant (default: the service uses now − 24 h). The 7-day
// lower bound and the "not in the future" upper bound need the clock, so the
// service checks them.
import { z } from 'zod';
import { canonicalUuid } from './checkout-fields.js';

export const RECENT_DEFAULT_LIMIT = 20;
export const RECENT_MAX_LIMIT = 50;

export type CheckoutAttemptsRecentQuery = {
  branchId: string;
  scope: 'mine' | 'branch';
  limit: number;
  since: Date | null;
};

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})$/;

export const checkoutAttemptsRecentQueryDto = z.object({
  branchId: canonicalUuid,
  scope: z.enum(['mine', 'branch']),
  limit: z.string().regex(/^[1-9][0-9]?$/, 'limit inválido.')
    .refine((value) => Number(value) <= RECENT_MAX_LIMIT, `limit no puede superar ${RECENT_MAX_LIMIT}.`).optional(),
  since: z.string().regex(ISO_INSTANT, 'since debe ser una fecha ISO-8601.')
    .refine((value) => !Number.isNaN(Date.parse(value)), 'since inválido.').optional(),
}).strict().transform((query): CheckoutAttemptsRecentQuery => ({
  branchId: query.branchId,
  scope: query.scope,
  limit: query.limit === undefined ? RECENT_DEFAULT_LIMIT : Number(query.limit),
  since: query.since === undefined ? null : new Date(query.since),
}));
