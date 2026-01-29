import { useState } from 'react';
import { Lock, User, LogIn, AlertCircle } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';

export function Login() {
  const { login } = useAuth();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      await login(username, password);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-header">
          <img src="/favicon.png" alt="Draken" className="login-logo" />
          <h1>Draken</h1>
          <p className="login-subtitle">Claude Code Dashboard</p>
        </div>

        <form onSubmit={handleSubmit} className="login-form">
          {error && (
            <div className="login-error">
              <AlertCircle size={16} />
              {error}
            </div>
          )}

          <div className="form-group">
            <label htmlFor="username">Username</label>
            <div className="input-with-icon">
              <User size={18} className="input-icon" />
              <input
                id="username"
                type="text"
                className="input"
                placeholder="Enter username"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                autoComplete="username"
                autoFocus
              />
            </div>
          </div>

          <div className="form-group">
            <label htmlFor="password">Password</label>
            <div className="input-with-icon">
              <Lock size={18} className="input-icon" />
              <input
                id="password"
                type="password"
                className="input"
                placeholder="Enter password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="current-password"
              />
            </div>
          </div>

          <button
            type="submit"
            className="btn btn-primary btn-lg login-btn"
            disabled={loading || !username || !password}
          >
            {loading ? (
              <>
                <span className="spinner spinner-sm" /> Signing in...
              </>
            ) : (
              <>
                <LogIn size={18} /> Sign In
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
}
