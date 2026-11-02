// USER-MGMT-01 U5 — the read contract of GET /backoffice/users that the Users screen depends on: it exposes whether a password change is pending
// (`mustChangePassword`) and NEVER anything about credentials (hash, epoch, token claims). DB-free.
import { describe, expect, it, vi } from 'vitest';
import { createBackofficeService } from '../../src/modules/backoffice/backoffice.service.js';

const req = { auth: { userId: 'u1', roles: ['ADMIN'], effectiveLocationIds: ['loc-1'], assignments: [{ roleId: 'r', roleCode: 'ADMIN', scopeKind: 'COMPANY', locationId: null, permissions: [] }] } } as never;
const location = { id: 'loc-1', name: 'Centro', code: 'PCEN' };

function serviceWith(rows: unknown[]) {
  const findMany = vi.fn().mockResolvedValue(rows);
  return { service: createBackofficeService({ user: { findMany } } as never), findMany };
}

describe('GET /backoffice/users read contract (US-*)', () => {
  it('US-01 each item carries mustChangePassword (true and false) next to the existing fields', async () => {
    const { service } = serviceWith([
      { id: 'a', name: 'Ana', email: 'ana@x.test', isActive: true, mustChangePassword: true, roleScopes: [{ scopeKind: 'LOCATION', locationId: 'loc-1', role: { id: 'r1', code: 'SELLER', name: 'Vendedor' }, location }] },
      { id: 'b', name: 'Beto', email: 'beto@x.test', isActive: false, mustChangePassword: false, roleScopes: [] },
    ]);
    const { items } = await service.users(req);
    expect(items).toEqual([
      { id: 'a', name: 'Ana', email: 'ana@x.test', isActive: true, mustChangePassword: true, assignments: [{ roleCode: 'SELLER', scopeKind: 'LOCATION', location }] },
      { id: 'b', name: 'Beto', email: 'beto@x.test', isActive: false, mustChangePassword: false, assignments: [] },
    ]);
  });

  it('US-02 the query SELECTs mustChangePassword and never a credential column; a row that carried one would not reach the response', async () => {
    const { service, findMany } = serviceWith([
      { id: 'a', name: 'Ana', email: 'ana@x.test', isActive: true, mustChangePassword: false, passwordHash: '$2b$12$secret', credentialsChangedAt: new Date(1), roleScopes: [] },
    ]);
    const { items } = await service.users(req);
    const select = (findMany.mock.calls[0]![0] as { select: Record<string, unknown> }).select;
    expect(select.mustChangePassword).toBe(true);
    for (const forbidden of ['passwordHash', 'credentialsChangedAt']) expect(select).not.toHaveProperty(forbidden);
    expect(JSON.stringify(items)).not.toMatch(/passwordHash|credentialsChangedAt|\$2b\$|secret/);
  });
});
