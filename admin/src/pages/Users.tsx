import { LockKeyhole } from 'lucide-react';
import { useCallback, useEffect, useRef, useState, type FormEvent } from 'react';
import { AccessDialog } from '../components/AccessDialog';
import { Modal } from '../components/Modal';
import { useAuth } from '../hooks/useAuth';
import { ApiError, api, type BackofficeUser, type BranchListItem, type IdentityOperationResult } from '../lib/api';
import { COMPANY_ROLES, adminErrorMessage, creatableRoles, rowActions, useIntentKey } from '../lib/userAdmin';
import { roleLabel } from '../lib/utils';

const productionRoleCodes = new Set(['OWNER', 'ADMIN', 'CASHIER', 'SELLER', 'WAREHOUSE']);

// A LOCATION assignment without its location must never read as company-wide,
// and an unrecognized role code is not echoed as if it were a valid role.
function assignmentLabel(assignment: BackofficeUser['assignments'][number]) {
  const role = productionRoleCodes.has(assignment.roleCode) ? roleLabel(assignment.roleCode) : 'Rol desconocido';
  if (assignment.scopeKind === 'COMPANY') return `${role} · Toda la empresa`;
  return `${role} · ${assignment.location?.code ?? 'Alcance inválido'}`;
}

const REPLAY_CREATE = 'El empleado ya había sido creado. La contraseña temporal original no puede volver a mostrarse. Si la perdiste, usá Resetear contraseña.';
const PASSWORD_ONCE = 'Copiala ahora. No podremos volver a mostrarla.';

// What the "temporary password" dialog shows. The password lives ONLY in this state: closing the dialog drops it (no storage, no URL, no log).
type Reveal = { title: string; password: string | null; notice: string | null };
type Confirm = { action: 'deactivate' | 'reactivate' | 'reset'; row: BackofficeUser };
type DialogState = { kind: 'create' } | { kind: 'edit'; row: BackofficeUser } | { kind: 'access'; rowId: string } | ({ kind: 'confirm' } & Confirm) | null;

function revealFrom(title: string, replayTitle: string, result: IdentityOperationResult, replayNotice?: string): Reveal {
  if (result.replayed || !result.temporaryPassword) {
    return { title: replayTitle, password: null, notice: replayNotice ?? result.message ?? 'La contraseña temporal ya fue emitida. Generá una nueva desde Resetear contraseña.' };
  }
  return { title, password: result.temporaryPassword, notice: null };
}

export function Users({ forbidden = false }: { forbidden?: boolean }) {
  const { token, logout, user: actor } = useAuth();
  const [users, setUsers] = useState<BackofficeUser[]>([]);
  const [branches, setBranches] = useState<BranchListItem[]>([]);
  const [loading, setLoading] = useState(!forbidden);
  const [blocked, setBlocked] = useState(forbidden);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<DialogState>(null);
  const [reveal, setReveal] = useState<Reveal | null>(null);

  const load = useCallback(() => {
    if (!token || forbidden) return Promise.resolve();
    return api
      .users(token, logout)
      .then(({ items }) => setUsers(items))
      .catch((cause) => {
        if (cause instanceof ApiError && cause.status === 403) {
          setBlocked(true);
          return;
        }
        setError(cause instanceof Error ? cause.message : 'No se pudieron cargar usuarios.');
      });
  }, [token, logout, forbidden]);

  useEffect(() => {
    if (!token || forbidden) return;
    setLoading(true);
    setError('');
    load().finally(() => setLoading(false));
    // The branches only feed the create form (active ones); a failure there is reported inside the form, not here.
    api.branches(token, logout).then(({ items }) => setBranches(items.filter((b) => b.isActive === true))).catch(() => setBranches([]));
  }, [token, logout, forbidden, load]);

  if (blocked) {
    return (
      <section className="empty-card">
        <LockKeyhole size={24} />
        <p className="eyebrow">Usuarios</p>
        <h2>Sin permiso USER_MANAGE</h2>
        <p>El backend no habilita esta pantalla para la sesión actual.</p>
      </section>
    );
  }

  const roleOptions = creatableRoles(actor);

  return (
    <div className="page-stack">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Administración</p>
          <h2>Usuarios</h2>
        </div>
        <button type="button" className="primary-button" onClick={() => setDialog({ kind: 'create' })}>Crear empleado</button>
      </div>
      {error ? <p className="error-banner">{error}</p> : null}
      {loading ? <p className="muted">Cargando usuarios...</p> : null}
      <div className="table-card">
        <table>
          <thead>
            <tr>
              <th>Nombre</th>
              <th>Correo</th>
              <th>Roles y sucursales</th>
              <th>Estado</th>
              <th>Contraseña</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            {users.map((row) => {
              const actions = rowActions(actor, row);
              return (
                <tr key={row.id}>
                  <td>{row.name}</td>
                  <td>{row.email}</td>
                  <td>{row.assignments.length === 0 ? 'Sin asignaciones' : row.assignments.map(assignmentLabel).join(', ')}</td>
                  <td>{row.isActive ? 'Activo' : 'Inactivo'}</td>
                  <td>{row.mustChangePassword ? 'Cambio pendiente' : 'Configurada'}</td>
                  <td className="row-actions">
                    {actions.includes('edit') ? <button type="button" className="secondary-button" aria-label={`Editar ${row.name}`} onClick={() => setDialog({ kind: 'edit', row })}>Editar</button> : null}
                    {actions.includes('access') ? <button type="button" className="secondary-button" aria-label={`Gestionar accesos de ${row.name}`} onClick={() => setDialog({ kind: 'access', rowId: row.id })}>Accesos</button> : null}
                    {actions.includes('deactivate') ? <button type="button" className="secondary-button" aria-label={`Desactivar a ${row.name}`} onClick={() => setDialog({ kind: 'confirm', action: 'deactivate', row })}>Desactivar</button> : null}
                    {actions.includes('reactivate') ? <button type="button" className="secondary-button" aria-label={`Reactivar a ${row.name}`} onClick={() => setDialog({ kind: 'confirm', action: 'reactivate', row })}>Reactivar</button> : null}
                    {actions.includes('reset') ? <button type="button" className="secondary-button" aria-label={`Resetear contraseña de ${row.name}`} onClick={() => setDialog({ kind: 'confirm', action: 'reset', row })}>Resetear contraseña</button> : null}
                  </td>
                </tr>
              );
            })}
            {!loading && !error && users.length === 0 ? (
              <tr>
                <td colSpan={6}>Sin usuarios</td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>

      {dialog?.kind === 'create' ? (
        <CreateDialog
          roles={roleOptions}
          branches={branches}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog(null);
            setReveal(result.replayed || !result.temporaryPassword
              ? { title: 'Empleado ya creado', password: null, notice: REPLAY_CREATE }
              : { title: 'Empleado creado', password: result.temporaryPassword, notice: null });
            void load();
          }}
        />
      ) : null}
      {dialog?.kind === 'edit' ? (
        <EditDialog row={dialog.row} onClose={() => setDialog(null)} onDone={() => { setDialog(null); void load(); }} />
      ) : null}
      {dialog?.kind === 'access' && users.find((u) => u.id === dialog.rowId) ? (
        <AccessDialog row={users.find((u) => u.id === dialog.rowId)!} branches={branches} actor={actor} reload={load} onClose={() => setDialog(null)} />
      ) : null}
      {dialog?.kind === 'confirm' ? (
        <ConfirmDialog
          action={dialog.action}
          row={dialog.row}
          onClose={() => setDialog(null)}
          onDone={(result) => {
            setDialog(null);
            if (dialog.action === 'reactivate') setReveal(revealFrom('Empleado reactivado', 'Contraseña ya emitida', result));
            else if (dialog.action === 'reset') setReveal(revealFrom('Contraseña reseteada', 'Contraseña ya emitida', result));
            void load();
          }}
        />
      ) : null}
      {reveal ? <TemporaryPasswordDialog reveal={reveal} onClose={() => setReveal(null)} /> : null}
    </div>
  );
}

// ---- create ----------------------------------------------------------------------------------------------------------------------------------
function CreateDialog({ roles, branches, onClose, onDone }: { roles: readonly string[]; branches: BranchListItem[]; onClose: () => void; onDone: (result: IdentityOperationResult) => void }) {
  const { token, logout } = useAuth();
  const intent = useIntentKey();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [roleCode, setRoleCode] = useState('');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState('');

  const companyRole = COMPANY_ROLES.has(roleCode);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !token) return;
    if (!roleCode) { setError('Elegí un rol.'); return; }
    if (!companyRole && locationIds.length === 0) { setError('Elegí al menos una sede.'); return; }
    const body = {
      name: name.trim(),
      email: email.trim(),
      roleCode,
      scopeKind: companyRole ? ('COMPANY' as const) : ('LOCATION' as const),
      ...(companyRole ? {} : { locationIds: [...locationIds].sort() }),
    };
    // Same intent (same request) => same key, even across a manual retry after a failure; any change to the request is another intent.
    const idempotencyKey = intent.keyFor(JSON.stringify(body));
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const result = await api.createUser(token, { ...body, idempotencyKey }, logout);
      intent.reset();
      onDone(result);
    } catch (cause) {
      setError(adminErrorMessage(cause));
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <Modal title="Crear empleado" onEscape={onClose}>
      <form onSubmit={submit} className="stack-form">
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} data-autofocus />
        </label>
        <label>
          Correo
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        <label>
          Rol
          <select value={roleCode} onChange={(e) => { setRoleCode(e.target.value); setLocationIds([]); }} required>
            <option value="">Elegí un rol</option>
            {roles.map((code) => <option key={code} value={code}>{roleLabel(code)}</option>)}
          </select>
        </label>
        {roleCode && companyRole ? <p className="muted">Alcance: Toda la empresa.</p> : null}
        {roleCode && !companyRole ? (
          <fieldset>
            <legend>Sedes</legend>
            {branches.length === 0 ? <p className="muted">No hay sedes activas disponibles.</p> : null}
            {branches.map((branch) => (
              <label key={branch.id} className="check-row">
                <input
                  type="checkbox"
                  checked={locationIds.includes(branch.id)}
                  onChange={(e) => setLocationIds((current) => (e.target.checked ? [...current, branch.id] : current.filter((id) => id !== branch.id)))}
                />
                {branch.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={pending}>{pending ? 'Creando...' : 'Crear empleado'}</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- edit (name / e-mail only; roles and scopes are separate endpoints) ----------------------------------------------------------------------------
function EditDialog({ row, onClose, onDone }: { row: BackofficeUser; onClose: () => void; onDone: () => void }) {
  const { token, logout } = useAuth();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [name, setName] = useState(row.name);
  const [email, setEmail] = useState(row.email);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy.current || !token) return;
    const changes: { name?: string; email?: string } = {};
    if (name.trim() !== row.name) changes.name = name.trim();
    if (email.trim() !== row.email) changes.email = email.trim();
    if (Object.keys(changes).length === 0) { onClose(); return; } // nothing to say to the server
    busy.current = true;
    setPending(true);
    setError('');
    try {
      await api.updateUser(token, row.id, changes, logout);
      onDone();
    } catch (cause) {
      setError(adminErrorMessage(cause));
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <Modal title={`Editar a ${row.name}`} onEscape={onClose}>
      <form onSubmit={submit} className="stack-form">
        <label>
          Nombre
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={100} data-autofocus />
        </label>
        <label>
          Correo
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required />
        </label>
        {error ? <p className="error-banner" role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button type="button" className="secondary-button" onClick={onClose}>Cancelar</button>
          <button type="submit" className="primary-button" disabled={pending}>Guardar</button>
        </div>
      </form>
    </Modal>
  );
}

// ---- deactivate / reactivate / reset: an explicit confirmation that says what will happen -----------------------------------------------------------------
function ConfirmDialog({ action, row, onClose, onDone }: Confirm & { onClose: () => void; onDone: (result: IdentityOperationResult) => void }) {
  const { token, logout } = useAuth();
  const intent = useIntentKey();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  const title = action === 'deactivate' ? `Desactivar a ${row.name}` : action === 'reactivate' ? `Reactivar a ${row.name}` : `Resetear contraseña de ${row.name}`;

  async function confirm() {
    if (busy.current || !token) return;
    const idempotencyKey = intent.keyFor(`${action}:${row.id}`);
    busy.current = true;
    setPending(true);
    setError('');
    try {
      const call = action === 'deactivate' ? api.deactivateUser : action === 'reactivate' ? api.reactivateUser : api.resetUserPassword;
      const result = await call(token, row.id, idempotencyKey, logout);
      intent.reset();
      onDone(result);
    } catch (cause) {
      setError(adminErrorMessage(cause));
      busy.current = false;
      setPending(false);
    }
  }

  return (
    <Modal title={title} onEscape={onClose}>
      {action === 'deactivate' ? (
        <ul className="plain-list">
          <li>{row.name} no podrá iniciar sesión.</li>
          <li>Las sesiones HTTP que ya tenga abiertas dejan de funcionar.</li>
          <li>Sus conexiones en tiempo real serán desconectadas.</li>
          <li>La cuenta no se borra: se puede reactivar.</li>
        </ul>
      ) : null}
      {action === 'reactivate' ? (
        <>
          <p>Este usuario volverá a quedar activo con los siguientes accesos:</p>
          <ul className="plain-list">
            {row.assignments.length === 0 ? <li>Sin asignaciones</li> : row.assignments.map((a, index) => <li key={index}>{assignmentLabel(a)}</li>)}
          </ul>
          <p>Se generará una contraseña temporal nueva y tendrá que cambiarla al ingresar.</p>
        </>
      ) : null}
      {action === 'reset' ? (
        <ul className="plain-list">
          <li>Las credenciales actuales dejarán de funcionar y las sesiones de {row.name} se cerrarán.</li>
          <li>Se generará una contraseña temporal que se muestra una sola vez.</li>
          <li>Deberá cambiar la nueva contraseña temporal en el próximo acceso.</li>
        </ul>
      ) : null}
      {error ? <p className="error-banner" role="alert">{error}</p> : null}
      <div className="modal-actions">
        <button type="button" className="secondary-button" onClick={onClose} data-autofocus>Cancelar</button>
        <button type="button" className="primary-button" disabled={pending} onClick={confirm}>Confirmar</button>
      </div>
    </Modal>
  );
}

// ---- the one-time temporary password -----------------------------------------------------------------------------------------------------------
function TemporaryPasswordDialog({ reveal, onClose }: { reveal: Reveal; onClose: () => void }) {
  const [copied, setCopied] = useState<'idle' | 'ok' | 'failed'>('idle');
  async function copy() {
    if (!reveal.password) return;
    try {
      await navigator.clipboard.writeText(reveal.password);
      setCopied('ok');
    } catch {
      setCopied('failed');
    }
  }
  // No onEscape: a stray Escape must not throw away a password that can never be shown again.
  return (
    <Modal title={reveal.title}>
      {reveal.password ? (
        <>
          <p>{PASSWORD_ONCE}</p>
          <p><code className="temporary-password">{reveal.password}</code></p>
          {copied === 'ok' ? <p role="status">Copiada al portapapeles.</p> : null}
          {copied === 'failed' ? <p role="alert">No se pudo copiar automáticamente. Seleccionala y copiala a mano.</p> : null}
        </>
      ) : (
        <p>{reveal.notice}</p>
      )}
      <div className="modal-actions">
        {reveal.password ? <button type="button" className="secondary-button" onClick={copy}>Copiar</button> : null}
        <button type="button" className="primary-button" onClick={onClose} data-autofocus>Cerrar</button>
      </div>
    </Modal>
  );
}
