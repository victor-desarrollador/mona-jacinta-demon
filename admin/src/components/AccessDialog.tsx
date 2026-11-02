import { useRef, useState } from 'react';
import { Modal } from './Modal';
import { useAuth } from '../hooks/useAuth';
import { api, type BackofficeUser, type BranchListItem } from '../lib/api';
import { COMPANY_ROLES, accessLabel, adminErrorMessage, creatableRoles, groupAccesses, projectAccesses, type RoleAccess } from '../lib/userAdmin';
import { roleLabel } from '../lib/utils';

// USER-MGMT-01 U5.1 — role / scope management on the EXISTING endpoints. Every action here is exactly ONE request:
//   assign (POST .../scope)   an atomic REPLACE of one role's scope (a LOCATION role's sedes are changed by sending the new full set)
//   revoke (DELETE .../scope/:roleCode)   removes that role from the account
// There is deliberately no "replace role X by role Y": it would be two requests with a partial state between them. Roles are independent on an
// account, so the person adds the new one and removes the old one as two conscious, individually reviewed steps. Nothing is optimistic: after a
// success the list is re-read from the server; after a failure nothing is touched. The backend (policy U3, LAST_OWNER_PROTECTED, role/scope
// compatibility, inactive sedes) remains the authority and its own message is shown.
type Change = { kind: 'set'; access: RoleAccess } | { kind: 'remove'; roleCode: string };
type Step = { step: 'list' } | { step: 'form'; editing: string | null } | { step: 'review'; change: Change; from: 'form' | 'list'; editing: string | null };

export function AccessDialog({ row, branches, actor, reload, onClose }: {
  row: BackofficeUser;
  branches: BranchListItem[];
  actor: Parameters<typeof creatableRoles>[0];
  reload: () => Promise<unknown>;
  onClose: () => void;
}) {
  const { token, logout } = useAuth();
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [view, setView] = useState<Step>({ step: 'list' });
  const [roleCode, setRoleCode] = useState('');
  const [locationIds, setLocationIds] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  const current = groupAccesses(row.assignments);
  const roles = creatableRoles(actor);
  const companyRole = COMPANY_ROLES.has(roleCode);

  function startForm(editing: string | null) {
    const existing = editing ? current.find((a) => a.roleCode === editing) : undefined;
    setRoleCode(editing ?? '');
    setLocationIds(existing ? existing.locations.map((l) => l.id) : []);
    setError('');
    setDone(false);
    setView({ step: 'form', editing });
  }

  // The sedes to offer for a LOCATION role: the active ones, plus the ones the account ALREADY holds for it (so an inactive one is shown, marked, never dropped).
  function sedeOptions(): Array<{ id: string; name: string; inactive: boolean }> {
    const held = current.find((a) => a.roleCode === roleCode)?.locations ?? [];
    const options = branches.map((b) => ({ id: b.id, name: b.name, inactive: false }));
    for (const location of held) if (!options.some((o) => o.id === location.id)) options.push({ id: location.id, name: location.name, inactive: true });
    return options;
  }

  function review(event: React.FormEvent) {
    event.preventDefault();
    if (!roleCode) { setError('Elegí un rol.'); return; }
    let access: RoleAccess;
    if (companyRole) {
      access = { roleCode, scopeKind: 'COMPANY', locations: [] };
    } else {
      if (locationIds.length === 0) { setError('Elegí al menos una sede.'); return; }
      const known = new Map<string, { id: string; name: string; code: string }>();
      for (const b of branches) known.set(b.id, { id: b.id, name: b.name, code: b.code });
      for (const l of current.flatMap((a) => a.locations)) if (!known.has(l.id)) known.set(l.id, l);
      access = { roleCode, scopeKind: 'LOCATION', locations: [...locationIds].sort().map((id) => known.get(id)!).filter(Boolean) };
    }
    const held = current.find((a) => a.roleCode === roleCode);
    const same = held && held.scopeKind === access.scopeKind && [...held.locations.map((l) => l.id)].sort().join() === [...access.locations.map((l) => l.id)].sort().join();
    if (same) { setError('No hay cambios para guardar.'); return; }
    setError('');
    setView({ step: 'review', change: { kind: 'set', access }, from: 'form', editing: view.step === 'form' ? view.editing : null });
  }

  async function confirm(change: Change) {
    if (busy.current || !token) return;
    busy.current = true;
    setPending(true);
    setError('');
    try {
      if (change.kind === 'remove') {
        await api.revokeScope(token, row.id, change.roleCode, logout);
      } else if (change.access.scopeKind === 'COMPANY') {
        await api.assignScope(token, row.id, { roleCode: change.access.roleCode, scopeKind: 'COMPANY' }, logout);
      } else {
        await api.assignScope(token, row.id, { roleCode: change.access.roleCode, scopeKind: 'LOCATION', locationIds: change.access.locations.map((l) => l.id) }, logout);
      }
    } catch (cause) {
      // Nothing changed on screen: the accesses shown are still the last ones read from the server.
      setError(adminErrorMessage(cause));
      busy.current = false;
      setPending(false);
      return;
    }
    await reload(); // the server is the source of truth: re-read, never patch locally
    busy.current = false;
    setPending(false);
    setDone(true);
    setView({ step: 'list' });
  }

  const list = (title: string, items: RoleAccess[]) => (
    <section aria-label={title}>
      <h3>{title}</h3>
      {items.length === 0 ? <p>Sin accesos</p> : <ul className="plain-list">{items.map((a) => <li key={a.roleCode}>{accessLabel(a, roleLabel)}</li>)}</ul>}
    </section>
  );

  return (
    <Modal title={`Gestionar accesos de ${row.name}`} onEscape={view.step === 'list' ? onClose : undefined}>
      {view.step === 'list' ? (
        <>
          {list('Accesos actuales', current)}
          {done ? <p role="status">Accesos actualizados.</p> : null}
          <ul className="plain-list">
            {current.map((a) => (
              <li key={a.roleCode} className="row-actions">
                <span>{roleLabel(a.roleCode)}</span>
                {a.scopeKind === 'LOCATION' ? <button type="button" className="secondary-button" onClick={() => startForm(a.roleCode)}>{`Cambiar sedes de ${roleLabel(a.roleCode)}`}</button> : null}
                <button type="button" className="secondary-button" onClick={() => { setError(''); setDone(false); setView({ step: 'review', change: { kind: 'remove', roleCode: a.roleCode }, from: 'list', editing: null }); }}>{`Quitar rol ${roleLabel(a.roleCode)}`}</button>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => startForm(null)}>Agregar rol</button>
            <button type="button" className="primary-button" onClick={onClose} data-autofocus>Cerrar</button>
          </div>
        </>
      ) : null}

      {view.step === 'form' ? (
        <form onSubmit={review} className="stack-form">
          <label>
            Rol
            <select value={roleCode} disabled={view.editing !== null} onChange={(e) => { setRoleCode(e.target.value); setLocationIds([]); setError(''); }} data-autofocus>
              <option value="">Elegí un rol</option>
              {roles.map((code) => <option key={code} value={code}>{roleLabel(code)}</option>)}
            </select>
          </label>
          {roleCode && companyRole ? <p className="muted">Alcance: Toda la empresa.</p> : null}
          {roleCode && !companyRole ? (
            <fieldset>
              <legend>Sedes</legend>
              {sedeOptions().map((o) => (
                <label key={o.id} className="check-row">
                  <input
                    type="checkbox"
                    checked={locationIds.includes(o.id)}
                    onChange={(e) => setLocationIds((cur) => (e.target.checked ? [...cur, o.id] : cur.filter((id) => id !== o.id)))}
                  />
                  {o.inactive ? `${o.name} (inactiva)` : o.name}
                </label>
              ))}
            </fieldset>
          ) : null}
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => { setError(''); setView({ step: 'list' }); }}>Volver</button>
            <button type="submit" className="primary-button">Revisar cambio</button>
          </div>
        </form>
      ) : null}

      {view.step === 'review' ? (
        <>
          {list('Accesos actuales', current)}
          {list('Nuevos accesos', projectAccesses(current, view.change))}
          {error ? <p className="error-banner" role="alert">{error}</p> : null}
          <div className="modal-actions">
            <button type="button" className="secondary-button" onClick={() => { setError(''); setView(view.from === 'form' ? { step: 'form', editing: view.editing } : { step: 'list' }); }}>Volver</button>
            <button type="button" className="primary-button" disabled={pending} onClick={() => void confirm(view.change)} data-autofocus>Confirmar</button>
          </div>
        </>
      ) : null}
    </Modal>
  );
}
