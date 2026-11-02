// USER-MGMT-01 U5.1 — role / scope management from the Users screen, on the EXISTING endpoints:
//   POST   /backoffice/users/:id/scope            assign = an ATOMIC REPLACE of one role's scope (delete + create in one transaction; identical = no-op)
//   DELETE /backoffice/users/:id/scope/:roleCode  revoke = removes ALL scope rows of that role (one transaction)
// Every UI action is exactly ONE of those requests. There is deliberately no "replace role X by role Y": that would be two requests with a partial
// state in between, and the roles of an account are independent (the user adds the new role, then removes the old one, as two conscious steps).
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { BRANCH_ID, TOKEN_KEY, adminUser, installApi, ownerUser, renderApp } from '../test/harness';

const ID = { self: '00000000-0000-4000-8000-0000000000a1', owner2: '00000000-0000-4000-8000-0000000000a2', admin2: '00000000-0000-4000-8000-0000000000a3', seller: '00000000-0000-4000-8000-0000000000a4', gone: '00000000-0000-4000-8000-0000000000a5' };
const YERBA_ID = '4b4b4b4b-4b4b-4b4b-8b4b-4b4b4b4b4b4b';
const CLOSED_ID = '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a';
const centro = { id: BRANCH_ID, name: 'Mona Centro', code: 'PCEN' };
const yerba = { id: YERBA_ID, name: 'Mona Yerba', code: 'PYB' };
const closed = { id: CLOSED_ID, name: 'Local Cerrado', code: 'PXX' };
const branches = { items: [
  { ...centro, type: 'RETAIL_BRANCH', isActive: true, locationConsistency: 'consistent' },
  { ...yerba, type: 'RETAIL_BRANCH', isActive: true, locationConsistency: 'consistent' },
  { ...closed, type: 'RETAIL_BRANCH', isActive: false, locationConsistency: 'consistent' },
] };
type A = { roleCode: string; scopeKind: 'COMPANY' | 'LOCATION'; location: { id: string; name: string; code: string } | null };
type Row = { id: string; name: string; email: string; isActive: boolean; mustChangePassword: boolean; assignments: A[] };
const at = (roleCode: string, location: A['location']): A => ({ roleCode, scopeKind: 'LOCATION', location });
const company = (roleCode: string): A => ({ roleCode, scopeKind: 'COMPANY', location: null });
const row = (id: string, name: string, assignments: A[], patch: Partial<Row> = {}): Row => ({ id, name, email: `${name.split(' ')[0]!.toLowerCase()}@pilot.local`, isActive: true, mustChangePassword: false, assignments, ...patch });
const baseRows = (): Row[] => [
  row(ID.self, 'Yo Mismo', [company('OWNER')]), row(ID.owner2, 'Otro Dueño', [company('OWNER')]), row(ID.admin2, 'Ada Admin', [company('ADMIN')]),
  row(ID.seller, 'Vera Vendedora', [at('SELLER', centro)]), row(ID.gone, 'Gabi Baja', [at('CASHIER', centro)], { isActive: false }),
];
const owner = { ...ownerUser, id: ID.self };
const admin = { ...adminUser, id: '00000000-0000-4000-8000-0000000000aa' };

async function setup(actor: typeof adminUser, routes: Parameters<typeof installApi>[0] = {}) {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const state = { rows: baseRows() };
  const api = installApi({
    'GET /auth/me': { body: { user: actor } },
    'GET /backoffice/branches': { body: branches },
    'GET /backoffice/users': () => ({ body: { items: state.rows } }),
    ...routes,
  });
  const user = userEvent.setup();
  renderApp('/usuarios');
  await screen.findByText('Vera Vendedora');
  return { ...api, user, state };
}
const openAccess = async (user: ReturnType<typeof userEvent.setup>, name: string) => {
  await user.click(screen.getByRole('button', { name: `Gestionar accesos de ${name}` }));
  return screen.findByRole('dialog', { name: `Gestionar accesos de ${name}` });
};
const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const usersReads = (calls: Array<{ key: string; init?: RequestInit }>) => calls.filter((c) => c.key === 'GET /backoffice/users').length;
const scopeCalls = <T extends { key: string }>(calls: T[]) => calls.filter((c) => c.key.includes('/scope'));
const SCOPE = `POST /backoffice/users/${ID.seller}/scope`;

afterEach(() => vi.unstubAllGlobals());

// ---- visibility -----------------------------------------------------------------------------------------------------------------------------
test('AC-01 an OWNER opens "Gestionar accesos" on another account and sees its current accesses with per-role actions', async () => {
  const { user } = await setup(owner);
  const dialog = await openAccess(user, 'Vera Vendedora');
  const current = within(dialog).getByRole('region', { name: 'Accesos actuales' });
  expect(within(current).getByText('Vendedor — Mona Centro')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Quitar rol Vendedor' })).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Agregar rol' })).toBeInTheDocument();
  expect(dialog).toContainElement(document.activeElement as HTMLElement);
});

test('AC-02 an ADMIN COMPANY has the action on operational accounts only, and is never offered OWNER or ADMIN roles', async () => {
  const { user } = await setup(admin);
  for (const name of ['Yo Mismo', 'Otro Dueño', 'Ada Admin']) expect(screen.queryByRole('button', { name: `Gestionar accesos de ${name}` }), name).not.toBeInTheDocument();
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Agregar rol' }));
  const options = within(within(dialog).getByLabelText('Rol')).getAllByRole('option').map((o) => o.textContent).filter((t) => t && t !== 'Elegí un rol');
  expect(options).toEqual(['Cajero', 'Vendedor', 'Depósito']);
});

test('AC-03 nobody gets the action on their own account; an OWNER gets it on another OWNER and on an ADMIN, and on an INACTIVE account', async () => {
  await setup(owner);
  expect(screen.queryByRole('button', { name: 'Gestionar accesos de Yo Mismo' })).not.toBeInTheDocument();
  for (const name of ['Otro Dueño', 'Ada Admin', 'Gabi Baja']) expect(screen.getByRole('button', { name: `Gestionar accesos de ${name}` }), name).toBeInTheDocument();
});

// ---- scope shape ------------------------------------------------------------------------------------------------------------------------------
test('AC-04 a LOCATION role asks for sedes (active ones; current ones pre-checked); a COMPANY role asks for none', async () => {
  const { user } = await setup(owner);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  const group = within(dialog).getByRole('group', { name: 'Sedes' });
  expect(within(group).getByLabelText('Mona Centro')).toBeChecked();
  expect(within(group).getByLabelText('Mona Yerba')).not.toBeChecked();
  expect(within(group).queryByLabelText('Local Cerrado')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Volver' }));
  await user.click(within(dialog).getByRole('button', { name: 'Agregar rol' }));
  await user.selectOptions(within(dialog).getByLabelText('Rol'), 'ADMIN');
  expect(within(dialog).queryByRole('group', { name: 'Sedes' })).not.toBeInTheDocument();
  expect(within(dialog).getByText(/Toda la empresa/)).toBeInTheDocument();
  await user.selectOptions(within(dialog).getByLabelText('Rol'), 'CASHIER');
  expect(within(dialog).getByRole('group', { name: 'Sedes' })).toBeInTheDocument();
});

// ---- change sedes: ONE atomic request, reviewed first, then re-read ------------------------------------------------------------------------------------
test('AC-05 changing sedes shows current vs new accesses, sends NOTHING until confirmed, then ONE assign (the atomic replace) and re-reads /backoffice/users', async () => {
  const { user, calls, state } = await setup(owner, { [SCOPE]: { body: { userId: ID.seller, roleCode: 'SELLER', scopeKind: 'LOCATION' } } });
  const reads0 = usersReads(calls);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  await user.click(within(dialog).getByLabelText('Mona Yerba'));
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  expect(within(within(dialog).getByRole('region', { name: 'Accesos actuales' })).getByText('Vendedor — Mona Centro')).toBeInTheDocument();
  const next = within(dialog).getByRole('region', { name: 'Nuevos accesos' });
  expect(within(next).getByText('Vendedor — Mona Centro, Mona Yerba')).toBeInTheDocument();
  expect(scopeCalls(calls)).toHaveLength(0);
  state.rows = state.rows.map((r) => (r.id === ID.seller ? { ...r, assignments: [at('SELLER', centro), at('SELLER', yerba)] } : r));
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(within(dialog).getByRole('region', { name: 'Accesos actuales' })).toHaveTextContent('Vendedor — Mona Centro, Mona Yerba'));
  const sent = scopeCalls(calls);
  expect(sent).toHaveLength(1);
  expect(bodyOf(sent[0]!)).toEqual({ roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [BRANCH_ID, YERBA_ID].sort() });
  expect(usersReads(calls)).toBe(reads0 + 1);
  expect(within(dialog).getByRole('status')).toHaveTextContent('Accesos actualizados.');
  expect(within(screen.getByText('Vera Vendedora').closest('tr')!).getByText('Vendedor · PCEN, Vendedor · PYB')).toBeInTheDocument();
});

test('AC-06 adding a COMPANY role (OWNER grants ADMIN) sends the COMPANY body with no locationIds', async () => {
  const { user, calls } = await setup(owner, { [SCOPE]: { body: { userId: ID.seller, roleCode: 'ADMIN', scopeKind: 'COMPANY' } } });
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Agregar rol' }));
  await user.selectOptions(within(dialog).getByLabelText('Rol'), 'ADMIN');
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  expect(within(within(dialog).getByRole('region', { name: 'Nuevos accesos' })).getByText('Administrador — Toda la empresa')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(scopeCalls(calls)).toHaveLength(1));
  expect(bodyOf(scopeCalls(calls)[0]!)).toEqual({ roleCode: 'ADMIN', scopeKind: 'COMPANY' });
});

test('AC-07 removing a role shows the delta, then sends ONE DELETE for that role and re-reads', async () => {
  const { user, calls } = await setup(owner, { [`DELETE /backoffice/users/${ID.seller}/scope/SELLER`]: { body: { userId: ID.seller, roleCode: 'SELLER', revoked: true } } });
  const reads0 = usersReads(calls);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Quitar rol Vendedor' }));
  expect(within(within(dialog).getByRole('region', { name: 'Nuevos accesos' })).getByText('Sin accesos')).toBeInTheDocument();
  expect(scopeCalls(calls)).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(scopeCalls(calls)).toHaveLength(1));
  expect(scopeCalls(calls)[0]!.key).toBe(`DELETE /backoffice/users/${ID.seller}/scope/SELLER`);
  await waitFor(() => expect(usersReads(calls)).toBe(reads0 + 1));
});

test('AC-08 a LOCATION role cannot be saved without a sede: no review, no request', async () => {
  const { user, calls } = await setup(owner);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  await user.click(within(dialog).getByLabelText('Mona Centro')); // uncheck the only sede
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Elegí al menos una sede.');
  expect(within(dialog).queryByRole('region', { name: 'Nuevos accesos' })).not.toBeInTheDocument();
  expect(scopeCalls(calls)).toHaveLength(0);
});

test('AC-09 an unchanged sede selection is not sent at all', async () => {
  const { user, calls } = await setup(owner);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('No hay cambios para guardar.');
  expect(scopeCalls(calls)).toHaveLength(0);
});

// ---- refusals leave the screen truthful ------------------------------------------------------------------------------------------------------------
test.each([
  ['403 FORBIDDEN', 403, 'FORBIDDEN', 'Sólo OWNER puede asignar el rol ADMIN.'],
  ['409 LAST_OWNER_PROTECTED', 409, 'LAST_OWNER_PROTECTED', 'No se puede quitar al último OWNER operativo: el sistema quedaría sin ningún OWNER activo.'],
  ['400 LOCATION_INACTIVE', 400, 'LOCATION_INACTIVE', 'No se puede asignar alcance sobre ubicaciones inactivas.'],
  ['409 SCOPE_STATE_INCONSISTENT', 409, 'SCOPE_STATE_INCONSISTENT', 'El alcance del rol SELLER para este usuario está en un estado inconsistente.'],
  ['404 NOT_FOUND', 404, 'NOT_FOUND', 'No se encontró el usuario.'],
])('AC-10 %s: the backend\'s own message is shown, nothing is re-read and the displayed accesses do not change', async (_n, status, code, message) => {
  const { user, calls } = await setup(owner, { [`DELETE /backoffice/users/${ID.seller}/scope/SELLER`]: { status, body: { error: { code, message } } } });
  const reads0 = usersReads(calls);
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Quitar rol Vendedor' }));
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  expect(await within(dialog).findByText(message)).toBeInTheDocument();
  expect(usersReads(calls)).toBe(reads0);
  expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Volver' }));
  expect(within(within(dialog).getByRole('region', { name: 'Accesos actuales' })).getByText('Vendedor — Mona Centro')).toBeInTheDocument();
  expect(within(screen.getByText('Vera Vendedora').closest('tr')!).getByText('Vendedor · PCEN')).toBeInTheDocument();
});

test('AC-11 a network failure (outcome unknown) is NOT reported as success: error shown, no "actualizados", no optimistic change', async () => {
  const { user } = await setup(owner, { [SCOPE]: () => { throw new Error('network down'); } });
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  await user.click(within(dialog).getByLabelText('Mona Yerba'));
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(/No se pudo completar la operación/);
  expect(within(dialog).queryByRole('status')).not.toBeInTheDocument();
  expect(within(screen.getByText('Vera Vendedora').closest('tr')!).getByText('Vendedor · PCEN')).toBeInTheDocument();
});

test('AC-12 two confirmations in the SAME tick send ONE request (the in-flight guard)', async () => {
  let release!: (v: { body: unknown }) => void;
  const held = new Promise<{ body: unknown }>((resolve) => { release = resolve; });
  const { user, calls } = await setup(owner, { [SCOPE]: held });
  const dialog = await openAccess(user, 'Vera Vendedora');
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  await user.click(within(dialog).getByLabelText('Mona Yerba'));
  await user.click(within(dialog).getByRole('button', { name: 'Revisar cambio' }));
  const confirm = within(dialog).getByRole('button', { name: 'Confirmar' });
  act(() => { confirm.click(); confirm.click(); });
  expect(scopeCalls(calls)).toHaveLength(1);
  release({ body: { userId: ID.seller } });
  await waitFor(() => expect(within(dialog).getByRole('status')).toBeInTheDocument());
});

test('AC-13 a Location already held by the role but now inactive stays visible (marked, checked) instead of being silently dropped; an account with no accesses says so', async () => {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const rows = baseRows().map((r) => (r.id === ID.seller ? { ...r, assignments: [at('SELLER', centro), at('SELLER', closed)] } : r.id === ID.gone ? { ...r, assignments: [] } : r));
  installApi({
    'GET /auth/me': { body: { user: owner } },
    'GET /backoffice/branches': { body: branches },
    'GET /backoffice/users': { body: { items: rows } },
  });
  const user = userEvent.setup();
  renderApp('/usuarios');
  await screen.findByText('Vera Vendedora');
  const dialog = await openAccess(user, 'Vera Vendedora');
  expect(within(within(dialog).getByRole('region', { name: 'Accesos actuales' })).getByText('Vendedor — Mona Centro, Local Cerrado')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Cambiar sedes de Vendedor' }));
  expect(within(within(dialog).getByRole('group', { name: 'Sedes' })).getByLabelText('Local Cerrado (inactiva)')).toBeChecked();
  await user.click(within(dialog).getByRole('button', { name: 'Volver' }));
  await user.click(within(dialog).getByRole('button', { name: 'Cerrar' }));
  const empty = await openAccess(user, 'Gabi Baja');
  expect(within(within(empty).getByRole('region', { name: 'Accesos actuales' })).getByText('Sin accesos')).toBeInTheDocument();
});
