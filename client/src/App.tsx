import { LogOut } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Login } from './pages/Login';
import { Sync } from './pages/Sync';

function AppContent() {
  const { isAuthenticated, isLoading, authEnabled, username, logout } = useAuth();
  if (isLoading) return <div className="app-loading"><span className="spinner" />Opening Draken…</div>;
  if (!isAuthenticated) return <Login />;
  return <div className="app-container">
    <header className="header"><div className="brand"><img src="/favicon.png" alt="" /><div><strong>Draken</strong><span>Session sync</span></div></div>
      <div className="header-right"><span className="prototype-tag">LOCAL PROTOTYPE</span>{authEnabled && <><span className="muted small">{username}</span><button className="icon-button" onClick={logout} aria-label="Sign out"><LogOut size={18} /></button></>}</div>
    </header><Sync />
  </div>;
}

export default function App() {
  return <AuthProvider><AppContent /></AuthProvider>;
}
