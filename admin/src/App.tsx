import { Navigate, Route, Routes } from 'react-router';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './hooks/useAuth';
import { canManageUsers, canUseBackoffice } from './lib/auth';
import { Branches } from './pages/Branches';
import { Dashboard } from './pages/Dashboard';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { SalesHistory } from './pages/SalesHistory';
import { Users } from './pages/Users';

function ProtectedLayout() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <main className="screen-center">
        <section className="empty-card">
          <p className="eyebrow">Administración</p>
          <h1>Cargando sesión</h1>
          <p>Validando credenciales con el servidor.</p>
        </section>
      </main>
    );
  }

  if (!user) return <Navigate to="/login" replace />;
  if (!canUseBackoffice(user)) {
    return (
      <main className="screen-center">
        <section className="empty-card">
          <p className="eyebrow">Acceso restringido</p>
          <h1>Sin permisos de reportes</h1>
          <p>El backoffice requiere permisos vigentes del backend.</p>
        </section>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <Sidebar />
      <div className="content-shell">
        <Header />
        <section className="content">
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="ventas" element={<SalesHistory />} />
            <Route path="inventario" element={<Inventory />} />
            <Route path="sucursales" element={<Branches />} />
            <Route
              path="usuarios"
              element={canManageUsers(user) ? <Users /> : <Users forbidden />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </section>
      </div>
    </div>
  );
}

export function App() {
  const { user, loading } = useAuth();

  return (
    <Routes>
      <Route
        path="/login"
        element={!loading && user ? <Navigate to="/" replace /> : <Login />}
      />
      <Route path="/*" element={<ProtectedLayout />} />
    </Routes>
  );
}
