import { Routes, Route, Link } from 'react-router-dom';
import { LogOut, User } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { ProjectList } from './pages/ProjectList';
import { ProjectDetail } from './pages/ProjectDetail';
import { Login } from './pages/Login';

function AppContent() {
  const { isAuthenticated, isLoading, authEnabled, username, logout } = useAuth();

  if (isLoading) {
    return (
      <div className="app-loading">
        <span className="spinner" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Login />;
  }

  return (
    <div className="app-container">
      <header className="header">
        <div className="header-content">
          <Link to="/" className="logo">
            <img src="/favicon.png" alt="Draken" className="logo-icon" />
            <div>
              <div className="logo-text">Draken</div>
              <div className="logo-subtitle">Claude Code Dashboard</div>
            </div>
          </Link>

          {authEnabled && (
            <div className="header-user">
              <span className="user-info">
                <User size={16} />
                {username}
              </span>
              <button className="btn btn-ghost btn-sm" onClick={logout}>
                <LogOut size={16} />
                Sign Out
              </button>
            </div>
          )}
        </div>
      </header>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<ProjectList />} />
          <Route path="/project/:id" element={<ProjectDetail />} />
        </Routes>
      </main>
    </div>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
}
