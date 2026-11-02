// USER-MGMT-01 U5 — the Users screen as an administration tool: list, create, edit, deactivate, reactivate, reset password, the one-time temporary
// password, RBAC visibility (a UX hint: the backend decides), idempotency keys and error mapping. Every request goes through the fake fetch.
import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { BRANCH_ID, TOKEN_KEY, adminUser, installApi, ownerUser, renderApp } from '../test/harness';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ID = { self: '00000000-0000-4000-8000-0000000000a1', owner2: '00000000-0000-4000-8000-0000000000a2', admin2: '00000000-0000-4000-8000-0000000000a3', seller: '00000000-0000-4000-8000-0000000000a4', gone: '00000000-0000-4000-8000-0000000000a5' };
const PASSWORD = 'ABCD-efgh-JKLM-npqr';
const centro = { id: BRANCH_ID, name: 'Mona Centro', code: 'PCEN' };
const branches = { items: [
  { ...centro, type: 'RETAIL_BRANCH', isActive: true, locationConsistency: 'consistent' },
  { id: '3a3a3a3a-3a3a-4a3a-8a3a-3a3a3a3a3a3a', name: 'Local Cerrado', code: 'PXX', type: 'RETAIL_BRANCH', isActive: false, locationConsistency: 'consistent' },
] };
type Row = { id: string; name: string; email: string; isActive: boolean; mustChangePassword: boolean; assignments: unknown[] };
const row = (id: string, name: string, roleCode: string, patch: Partial<Row> = {}): Row => ({
  id, name, email: `${name.split(' ')[0]!.toLowerCase()}@pilot.local`, isActive: true, mustChangePassword: false,
  assignments: [roleCode === 'OWNER' || roleCode === 'ADMIN' ? { roleCode, scopeKind: 'COMPANY', location: null } : { roleCode, scopeKind: 'LOCATION', location: centro }], ...patch,
});
const baseRows = (): Row[] => [
  row(ID.self, 'Yo Mismo', 'OWNER'), row(ID.owner2, 'Otro Dueño', 'OWNER'), row(ID.admin2, 'Ada Admin', 'ADMIN'),
  row(ID.seller, 'Vera Vendedora', 'SELLER', { mustChangePassword: true }), row(ID.gone, 'Gabi Baja', 'CASHIER', { isActive: false }),
];

type Setup = { actor: typeof adminUser; rows?: Row[]; routes?: Parameters<typeof installApi>[0] };
async function setup({ actor, rows = baseRows(), routes = {} }: Setup) {
  window.localStorage.setItem(TOKEN_KEY, 'tok');
  const state = { rows };
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
const bodyOf = (call: { init: RequestInit }) => JSON.parse(String(call.init.body)) as Record<string, unknown>;
const posts = (calls: Array<{ key: string; init: RequestInit }>, key: string) => calls.filter((c) => c.key === key);
const storageDump = () => JSON.stringify([...Object.entries(window.localStorage), ...Object.entries(window.sessionStorage)]);
const owner = { ...ownerUser, id: ID.self };
const admin = { ...adminUser, id: '00000000-0000-4000-8000-0000000000aa' };

beforeEach(() => window.sessionStorage.clear());
afterEach(() => vi.unstubAllGlobals());

// ---- list ---------------------------------------------------------------------------------------------------------------------------------
test('A01 the list shows name, e-mail, roles and branches, account state and password state (Cambio pendiente / Configurada)', async () => {
  await setup({ actor: owner });
  const table = screen.getByRole('table');
  for (const header of ['Nombre', 'Correo', 'Roles y sucursales', 'Estado', 'Contraseña', 'Acciones']) expect(within(table).getByRole('columnheader', { name: header })).toBeInTheDocument();
  const vera = screen.getByText('Vera Vendedora').closest('tr')!;
  expect(within(vera).getByText('Cambio pendiente')).toBeInTheDocument();
  expect(within(vera).getByText('Activo')).toBeInTheDocument();
  expect(within(vera).getByText('Vendedor · PCEN')).toBeInTheDocument();
  const gabi = screen.getByText('Gabi Baja').closest('tr')!;
  expect(within(gabi).getByText('Inactivo')).toBeInTheDocument();
  expect(within(gabi).getByText('Configurada')).toBeInTheDocument();
});

// ---- RBAC visibility ------------------------------------------------------------------------------------------------------------------------
test('A02 an OWNER sees actions on every account but its own; no action at all on itself', async () => {
  await setup({ actor: owner });
  const own = screen.getByText('Yo Mismo').closest('tr')!;
  expect(within(own).queryAllByRole('button')).toHaveLength(0);
  for (const name of ['Otro Dueño', 'Ada Admin']) expect(within(screen.getByText(name).closest('tr')!).getByRole('button', { name: `Desactivar a ${name}` })).toBeInTheDocument();
  expect(within(screen.getByText('Gabi Baja').closest('tr')!).getByRole('button', { name: 'Reactivar a Gabi Baja' })).toBeInTheDocument();
});

test('A03 an ADMIN COMPANY sees NO action on OWNER or ADMIN accounts, and does on operational ones; active/inactive decide Desactivar vs Reactivar', async () => {
  await setup({ actor: admin });
  for (const name of ['Yo Mismo', 'Otro Dueño', 'Ada Admin']) expect(within(screen.getByText(name).closest('tr')!).queryAllByRole('button'), name).toHaveLength(0);
  const vera = within(screen.getByText('Vera Vendedora').closest('tr')!);
  expect(vera.getByRole('button', { name: 'Editar Vera Vendedora' })).toBeInTheDocument();
  expect(vera.getByRole('button', { name: 'Desactivar a Vera Vendedora' })).toBeInTheDocument();
  expect(vera.getByRole('button', { name: 'Resetear contraseña de Vera Vendedora' })).toBeInTheDocument();
  expect(vera.queryByRole('button', { name: /Reactivar/ })).not.toBeInTheDocument();
  const gabi = within(screen.getByText('Gabi Baja').closest('tr')!);
  expect(gabi.getByRole('button', { name: 'Reactivar a Gabi Baja' })).toBeInTheDocument();
  expect(gabi.queryByRole('button', { name: /Desactivar|Resetear/ })).not.toBeInTheDocument(); // a reset needs an active account
});

// ---- create -------------------------------------------------------------------------------------------------------------------------------
test('A04 the role choices follow the matrix: OWNER may create every role, ADMIN COMPANY only CASHIER / SELLER / WAREHOUSE', async () => {
  for (const [actor, expected] of [[owner, ['Dueño', 'Administrador', 'Cajero', 'Vendedor', 'Depósito']], [admin, ['Cajero', 'Vendedor', 'Depósito']]] as const) {
    const { user } = await setup({ actor });
    await user.click(screen.getByRole('button', { name: 'Crear empleado' }));
    const dialog = await screen.findByRole('dialog', { name: 'Crear empleado' });
    const options = within(within(dialog).getByLabelText('Rol')).getAllByRole('option').map((o) => o.textContent).filter((t) => t && t !== 'Elegí un rol');
    expect(options).toEqual(expected);
    document.body.innerHTML = '';
  }
});

test('A05 scope follows the role: a company role asks for no branches, an operational role asks for ACTIVE branches only', async () => {
  const { user } = await setup({ actor: owner });
  await user.click(screen.getByRole('button', { name: 'Crear empleado' }));
  const dialog = await screen.findByRole('dialog', { name: 'Crear empleado' });
  await user.selectOptions(within(dialog).getByLabelText('Rol'), 'ADMIN');
  expect(within(dialog).queryByRole('group', { name: 'Sedes' })).not.toBeInTheDocument();
  expect(within(dialog).getByText(/Toda la empresa/)).toBeInTheDocument();
  await user.selectOptions(within(dialog).getByLabelText('Rol'), 'SELLER');
  const group = within(dialog).getByRole('group', { name: 'Sedes' });
  expect(within(group).getByLabelText('Mona Centro')).toBeInTheDocument();
  expect(within(group).queryByLabelText('Local Cerrado')).not.toBeInTheDocument();
});

async function fillCreate(user: ReturnType<typeof userEvent.setup>, { role = 'SELLER', email = 'nuevo@pilot.local' } = {}) {
  await user.click(screen.getByRole('button', { name: 'Crear empleado' }));
  const dialog = await screen.findByRole('dialog', { name: 'Crear empleado' });
  await user.type(within(dialog).getByLabelText('Nombre'), '  Nora Nueva ');
  await user.type(within(dialog).getByLabelText('Correo'), email);
  await user.selectOptions(within(dialog).getByLabelText('Rol'), role);
  if (role !== 'ADMIN' && role !== 'OWNER') await user.click(within(dialog).getByLabelText('Mona Centro'));
  return dialog;
}
const created = (extra: object = {}) => ({ status: 201, body: { replayed: false, user: { id: ID.seller, name: 'Nora Nueva' }, temporaryPassword: PASSWORD, ...extra } });

test('A06 create sends the documented body with a UUID v4 key and shows the temporary password ONCE in a modal; closing removes it from the page and from every store', async () => {
  const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  const { user, calls } = await setup({ actor: owner, routes: { 'POST /backoffice/users': created() } });
  const dialog = await fillCreate(user);
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  const modal = await screen.findByRole('dialog', { name: 'Empleado creado' });
  const body = bodyOf(posts(calls, 'POST /backoffice/users')[0]!);
  expect(body).toMatchObject({ name: 'Nora Nueva', email: 'nuevo@pilot.local', roleCode: 'SELLER', scopeKind: 'LOCATION', locationIds: [BRANCH_ID] });
  expect(String(body.idempotencyKey)).toMatch(UUID_V4);
  expect(Object.keys(body).sort()).toEqual(['email', 'idempotencyKey', 'locationIds', 'name', 'roleCode', 'scopeKind']);
  expect(within(modal).getByText(PASSWORD)).toBeInTheDocument();
  expect(within(modal).getByText('Copiala ahora. No podremos volver a mostrarla.')).toBeInTheDocument();
  expect(storageDump()).not.toContain(PASSWORD);
  expect(window.location.href).not.toContain(PASSWORD);
  expect(modal).toContainElement(document.activeElement as HTMLElement); // focus moved into the dialog
  await user.click(within(modal).getByRole('button', { name: 'Cerrar' }));
  expect(screen.queryByRole('dialog', { name: 'Empleado creado' })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain(PASSWORD);
  expect(storageDump()).not.toContain(PASSWORD);
  expect(JSON.stringify(log.mock.calls)).not.toContain(PASSWORD);
  log.mockRestore();
});

test('A07 the Copiar button writes the password to the clipboard and nothing else keeps it', async () => {
  const { user } = await setup({ actor: owner, routes: { 'POST /backoffice/users': created() } });
  const write = vi.spyOn(navigator.clipboard, 'writeText');
  const dialog = await fillCreate(user);
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  const modal = await screen.findByRole('dialog', { name: 'Empleado creado' });
  await user.click(within(modal).getByRole('button', { name: 'Copiar' }));
  expect(write).toHaveBeenCalledWith(PASSWORD);
  expect(storageDump()).not.toContain(PASSWORD);
});

test('A08 a REPLAY (replayed:true, no password) explains that the original password cannot be shown again — it is not an empty field nor an error', async () => {
  const message = 'La contraseña temporal ya fue emitida. Si no la conservaste, generá una nueva desde Resetear contraseña.';
  const { user } = await setup({ actor: owner, routes: { 'POST /backoffice/users': { status: 200, body: { replayed: true, user: { id: ID.seller, name: 'Nora Nueva' }, temporaryPassword: null, message } } } });
  const dialog = await fillCreate(user);
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  const modal = await screen.findByRole('dialog', { name: 'Empleado ya creado' });
  expect(within(modal).getByText('El empleado ya había sido creado. La contraseña temporal original no puede volver a mostrarse. Si la perdiste, usá Resetear contraseña.')).toBeInTheDocument();
  expect(within(modal).queryByRole('button', { name: 'Copiar' })).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

// ---- idempotency + double submit -----------------------------------------------------------------------------------------------------------------
test('A09 a retry of the SAME intent reuses the key; changing the payload takes a new one; a new create after success takes a new one', async () => {
  let attempt = 0;
  const { user, calls } = await setup({ actor: owner, routes: { 'POST /backoffice/users': () => { attempt += 1; if (attempt === 1) throw new Error('network down'); return created(); } } });
  const dialog = await fillCreate(user);
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  expect(await within(dialog).findByRole('alert')).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' })); // manual retry, same intent
  await screen.findByRole('dialog', { name: 'Empleado creado' });
  const [first, second] = posts(calls, 'POST /backoffice/users').map((c) => bodyOf(c).idempotencyKey);
  expect(second).toBe(first);
  await user.click(screen.getByRole('button', { name: 'Cerrar' }));
  const dialog2 = await fillCreate(user, { email: 'otra@pilot.local' });
  await user.click(within(dialog2).getByRole('button', { name: 'Crear empleado' }));
  await screen.findByRole('dialog', { name: 'Empleado creado' });
  const keys = posts(calls, 'POST /backoffice/users').map((c) => bodyOf(c).idempotencyKey);
  expect(keys).toHaveLength(3);
  expect(keys[2]).not.toBe(keys[0]);
});

test('A10 a failed create followed by an EDIT of the form takes a NEW key (another intent)', async () => {
  const { user, calls } = await setup({ actor: owner, routes: { 'POST /backoffice/users': () => ({ status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'Ya existe un usuario con ese email.' } } }) } });
  const dialog = await fillCreate(user);
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  expect(await within(dialog).findByText('Ya existe un usuario con ese email.')).toBeInTheDocument();
  await user.type(within(dialog).getByLabelText('Correo'), '.ar');
  await user.click(within(dialog).getByRole('button', { name: 'Crear empleado' }));
  await waitFor(() => expect(posts(calls, 'POST /backoffice/users')).toHaveLength(2));
  const [a, b] = posts(calls, 'POST /backoffice/users').map((c) => bodyOf(c).idempotencyKey);
  expect(b).not.toBe(a);
});

test('A11 a double click sends ONE request: the button is disabled while the request is in flight', async () => {
  let release!: (v: { status: number; body: unknown }) => void;
  const pending = new Promise<{ status: number; body: unknown }>((resolve) => { release = resolve; });
  const { user, calls } = await setup({ actor: owner, routes: { 'POST /backoffice/users': pending } });
  const dialog = await fillCreate(user);
  const submit = within(dialog).getByRole('button', { name: 'Crear empleado' });
  await user.dblClick(submit);
  expect(submit).toBeDisabled();
  expect(posts(calls, 'POST /backoffice/users')).toHaveLength(1);
  release(created());
  await screen.findByRole('dialog', { name: 'Empleado creado' });
  expect(posts(calls, 'POST /backoffice/users')).toHaveLength(1);
});

test('A11b two submits dispatched in the SAME tick (before React can re-render the disabled button) still send ONE request: the in-flight guard, not the DOM, is the barrier', async () => {
  let release!: (v: { status: number; body: unknown }) => void;
  const pending = new Promise<{ status: number; body: unknown }>((resolve) => { release = resolve; });
  const { user, calls } = await setup({ actor: owner, routes: { 'POST /backoffice/users': pending } });
  const dialog = await fillCreate(user);
  const form = dialog.querySelector('form')!;
  act(() => { form.requestSubmit(); form.requestSubmit(); });
  expect(posts(calls, 'POST /backoffice/users')).toHaveLength(1);
  release(created());
  await screen.findByRole('dialog', { name: 'Empleado creado' });
});

test('A11c the same holds for a confirmation (deactivate): two confirms in one tick send ONE request', async () => {
  let release!: (v: { body: unknown }) => void;
  const pending = new Promise<{ body: unknown }>((resolve) => { release = resolve; });
  const { user, calls } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.owner2}/deactivate`]: pending } });
  await user.click(screen.getByRole('button', { name: 'Desactivar a Otro Dueño' }));
  const confirm = within(await screen.findByRole('dialog', { name: 'Desactivar a Otro Dueño' })).getByRole('button', { name: 'Confirmar' });
  act(() => { confirm.click(); confirm.click(); });
  expect(calls.filter((c) => c.key.includes('deactivate'))).toHaveLength(1);
  release({ body: { replayed: false, user: { id: ID.owner2 } } });
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Desactivar a Otro Dueño' })).not.toBeInTheDocument());
});

// ---- edit -------------------------------------------------------------------------------------------------------------------------------------
test('A12 edit offers name and e-mail only, sends only what changed, does nothing when nothing changed and maps EMAIL_TAKEN', async () => {
  let reply: { status?: number; body: unknown } = { body: { user: { id: ID.seller } } };
  const { user, calls } = await setup({ actor: owner, routes: { [`PATCH /backoffice/users/${ID.seller}`]: () => reply } });
  await user.click(screen.getByRole('button', { name: 'Editar Vera Vendedora' }));
  const dialog = await screen.findByRole('dialog', { name: 'Editar a Vera Vendedora' });
  expect(within(dialog).queryByLabelText('Rol')).not.toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Guardar' }));
  expect(calls.filter((c) => c.key.startsWith('PATCH'))).toHaveLength(0);
  expect(screen.queryByRole('dialog', { name: /Editar/ })).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Editar Vera Vendedora' }));
  const again = await screen.findByRole('dialog', { name: 'Editar a Vera Vendedora' });
  reply = { status: 409, body: { error: { code: 'EMAIL_TAKEN', message: 'Ya existe un usuario con ese email.' } } };
  await user.clear(within(again).getByLabelText('Correo'));
  await user.type(within(again).getByLabelText('Correo'), 'tomado@pilot.local');
  await user.click(within(again).getByRole('button', { name: 'Guardar' }));
  expect(await within(again).findByText('Ya existe un usuario con ese email.')).toBeInTheDocument();
  expect(bodyOf(calls.find((c) => c.key.startsWith('PATCH'))!)).toEqual({ email: 'tomado@pilot.local' });
});

// ---- deactivate / reactivate / reset -----------------------------------------------------------------------------------------------------------
test('A13 deactivate needs an explicit confirmation that explains the effects; Cancelar sends nothing; Confirmar sends the key and refreshes the list', async () => {
  const { user, calls, state } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.seller}/deactivate`]: { body: { replayed: false, user: { id: ID.seller, isActive: false } } } } });
  await user.click(screen.getByRole('button', { name: 'Desactivar a Vera Vendedora' }));
  const dialog = await screen.findByRole('dialog', { name: 'Desactivar a Vera Vendedora' });
  expect(within(dialog).getByText(/no podrá iniciar sesión/i)).toBeInTheDocument();
  expect(within(dialog).getByText(/sesiones .*dejan de funcionar/i)).toBeInTheDocument();
  expect(within(dialog).getByText(/desconectad/i)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Cancelar' }));
  expect(calls.filter((c) => c.key.includes('deactivate'))).toHaveLength(0);
  await user.click(screen.getByRole('button', { name: 'Desactivar a Vera Vendedora' }));
  state.rows = state.rows.map((r) => (r.id === ID.seller ? { ...r, isActive: false } : r));
  await user.click(within(await screen.findByRole('dialog', { name: 'Desactivar a Vera Vendedora' })).getByRole('button', { name: 'Confirmar' }));
  await waitFor(() => expect(within(screen.getByText('Vera Vendedora').closest('tr')!).getByText('Inactivo')).toBeInTheDocument());
  const sent = calls.filter((c) => c.key.includes('deactivate'));
  expect(sent).toHaveLength(1);
  expect(Object.keys(bodyOf(sent[0]!))).toEqual(['idempotencyKey']);
  expect(String(bodyOf(sent[0]!).idempotencyKey)).toMatch(UUID_V4);
});

test('A14 reactivate lists the accesses the account KEEPS before confirming, then shows the new temporary password once', async () => {
  const { user, calls } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.gone}/reactivate`]: { body: { replayed: false, user: { id: ID.gone }, temporaryPassword: PASSWORD } } } });
  await user.click(screen.getByRole('button', { name: 'Reactivar a Gabi Baja' }));
  const dialog = await screen.findByRole('dialog', { name: 'Reactivar a Gabi Baja' });
  expect(within(dialog).getByText(/volverá a quedar activo con los siguientes accesos/i)).toBeInTheDocument();
  expect(within(dialog).getByText('Cajero · PCEN')).toBeInTheDocument();
  expect(calls.filter((c) => c.key.includes('reactivate'))).toHaveLength(0);
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  const modal = await screen.findByRole('dialog', { name: 'Empleado reactivado' });
  expect(within(modal).getByText(PASSWORD)).toBeInTheDocument();
  await user.click(within(modal).getByRole('button', { name: 'Cerrar' }));
  expect(document.body.textContent).not.toContain(PASSWORD);
});

test('A15 reset explains the effects, sends the key, shows the temporary password once; its replay shows the message and no password', async () => {
  let replay = false;
  const message = 'La contraseña temporal ya fue emitida. Si no la conservaste, generá una nueva desde Resetear contraseña.';
  const { user, calls } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.seller}/reset-password`]: () => ({ body: replay ? { replayed: true, user: { id: ID.seller }, temporaryPassword: null, message } : { replayed: false, user: { id: ID.seller }, temporaryPassword: PASSWORD } }) } });
  await user.click(screen.getByRole('button', { name: 'Resetear contraseña de Vera Vendedora' }));
  const dialog = await screen.findByRole('dialog', { name: 'Resetear contraseña de Vera Vendedora' });
  expect(within(dialog).getByText(/credenciales actuales dejarán de funcionar/i)).toBeInTheDocument();
  expect(within(dialog).getByText(/deberá cambiar la nueva contraseña temporal/i)).toBeInTheDocument();
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  const modal = await screen.findByRole('dialog', { name: 'Contraseña reseteada' });
  expect(within(modal).getByText(PASSWORD)).toBeInTheDocument();
  await user.click(within(modal).getByRole('button', { name: 'Cerrar' }));
  replay = true;
  await user.click(screen.getByRole('button', { name: 'Resetear contraseña de Vera Vendedora' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Resetear contraseña de Vera Vendedora' })).getByRole('button', { name: 'Confirmar' }));
  const notice = await screen.findByRole('dialog', { name: 'Contraseña ya emitida' });
  expect(within(notice).getByText(message)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain(PASSWORD);
  const keys = calls.filter((c) => c.key.includes('reset-password')).map((c) => bodyOf(c).idempotencyKey);
  expect(keys).toHaveLength(2);
  expect(keys[1]).not.toBe(keys[0]); // two conscious actions, two keys
});

// ---- error mapping ----------------------------------------------------------------------------------------------------------------------------
test.each([
  ['LAST_OWNER_PROTECTED', 409, 'No se puede quitar al último OWNER operativo: el sistema quedaría sin ningún OWNER activo.'],
  ['USER_INACTIVE', 409, 'El usuario está inactivo: reactivalo antes de resetear su contraseña.'],
  ['IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_PAYLOAD', 409, 'La clave de idempotencia ya se usó con otra solicitud.'],
  ['FORBIDDEN', 403, 'Sólo OWNER puede administrar a un OWNER o a un ADMIN.'],
  ['NOT_FOUND', 404, 'No se encontró el usuario.'],
])('A16 %s shows the backend\'s own Spanish message inside the open confirmation, not a generic one', async (code, status, message) => {
  const { user } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.owner2}/deactivate`]: { status, body: { error: { code, message } } } } });
  await user.click(screen.getByRole('button', { name: 'Desactivar a Otro Dueño' }));
  const dialog = await screen.findByRole('dialog', { name: 'Desactivar a Otro Dueño' });
  await user.click(within(dialog).getByRole('button', { name: 'Confirmar' }));
  expect(await within(dialog).findByText(message)).toBeInTheDocument();
  expect(within(dialog).queryByText(/Error de API/)).not.toBeInTheDocument();
});

test('A17 a 5xx shows the generic server message, never an internal detail', async () => {
  const { user } = await setup({ actor: owner, routes: { [`POST /backoffice/users/${ID.owner2}/deactivate`]: { status: 500, body: { error: { code: 'INTERNAL', message: 'PrismaClientKnownRequestError at line 42' } } } } });
  await user.click(screen.getByRole('button', { name: 'Desactivar a Otro Dueño' }));
  await user.click(within(await screen.findByRole('dialog', { name: 'Desactivar a Otro Dueño' })).getByRole('button', { name: 'Confirmar' }));
  expect(await screen.findByText('Ocurrió un error en el servidor. Intentá nuevamente.')).toBeInTheDocument();
  expect(document.body.textContent).not.toMatch(/Prisma/);
});
