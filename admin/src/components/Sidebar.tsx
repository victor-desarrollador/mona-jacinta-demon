import { BarChart3, Building2, LayoutDashboard, PackageSearch, ReceiptText, Users } from 'lucide-react';
import { NavLink } from 'react-router';
import { canManageUsers } from '../lib/auth';
import { cn } from '../lib/utils';
import { useAuth } from '../hooks/useAuth';

const baseItems = [
  { to: '/', label: 'Panel principal', icon: LayoutDashboard },
  { to: '/ventas', label: 'Ventas', icon: ReceiptText },
  { to: '/inventario', label: 'Inventario', icon: PackageSearch },
  { to: '/sucursales', label: 'Sucursales', icon: Building2 },
];

export function Sidebar() {
  const { user } = useAuth();
  const items = canManageUsers(user)
    ? [...baseItems, { to: '/usuarios', label: 'Usuarios', icon: Users }]
    : baseItems;

  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">MJ</div>
        <div>
          <strong>Mona Jacinta</strong>
          <span>Administración</span>
        </div>
      </div>
      <nav className="nav-list">
        {items.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) => cn('nav-item', isActive && 'active')}
            end={item.to === '/'}
          >
            <item.icon size={18} />
            {item.label}
          </NavLink>
        ))}
      </nav>
      <div className="sidebar-footer">
        <BarChart3 size={18} />
        <span>Datos leídos desde la API de administración</span>
      </div>
    </aside>
  );
}
