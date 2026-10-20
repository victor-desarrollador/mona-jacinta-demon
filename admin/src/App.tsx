import { Navigate, Route, Routes, useLocation } from 'react-router';
import { ErrorBoundary } from './components/ErrorBoundary';
import { Header } from './components/Header';
import { Sidebar } from './components/Sidebar';
import { useAuth } from './hooks/useAuth';
import { canManageUsers, canUseBackoffice } from './lib/auth';
import { Branches } from './pages/Branches';
import { Dashboard } from './pages/Dashboard';
import { ExternalCollections } from './pages/ExternalCollections';
import { Inventory } from './pages/Inventory';
import { Login } from './pages/Login';
import { Products } from './pages/Products';
import { SalesHistory } from './pages/SalesHistory';
import { Users } from './pages/Users';

function ProtectedLayout() {
  const { user, loading } = useAuth();
  const location = useLocation();

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

  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
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
          {/* keyed by path: a failing page is contained and navigating away recovers it */}
          <ErrorBoundary key={location.pathname}>
          <Routes>
            <Route index element={<Dashboard />} />
            <Route path="ventas" element={<SalesHistory />} />
            <Route path="productos" element={<Products />} />
            <Route path="inventario" element={<Inventory />} />
            <Route path="cobros-externos" element={<ExternalCollections />} />
            <Route path="sucursales" element={<Branches />} />
            <Route
              path="usuarios"
              element={canManageUsers(user) ? <Users /> : <Users forbidden />}
            />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
          </ErrorBoundary>
        </section>
      </div>
    </div>
  );
}

export function App() {
  const { loading, sessionError, retrySession } = useAuth();

  // The routes (and so the requested URL/deep link) stay put while the session is validated or retried.
  if (sessionError && !loading) {
    return (
      <main className="screen-center">
        <section className="empty-card">
          <p className="eyebrow">Administración</p>
          <h1>No se pudo validar la sesión</h1>
          <p>No hay conexión con el servidor o está con problemas. Tu sesión no se cerró.</p>
          <button type="button" className="primary-button" onClick={retrySession}>Reintentar</button>
        </section>
      </main>
    );
  }

  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/*" element={<ProtectedLayout />} />
    </Routes>
  );
}
