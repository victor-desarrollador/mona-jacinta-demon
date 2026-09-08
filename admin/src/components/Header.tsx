import { LogOut, ShieldCheck } from 'lucide-react';
import { useAuth } from '../hooks/useAuth';

export function Header() {
  const { user, logout } = useAuth();

  return (
    <header className="header">
      <div>
        <p className="eyebrow">Gestion comercial</p>
        <h1>Panel de control</h1>
      </div>
      <div className="header-user">
        <ShieldCheck size={18} />
        <span>
          {user?.name}
          <small>{user?.roles.join(' / ')}</small>
        </span>
        <button className="icon-button" onClick={logout} aria-label="Cerrar sesion">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
