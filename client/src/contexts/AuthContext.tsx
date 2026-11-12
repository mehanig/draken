import { createContext, useContext, useState, useEffect, type ReactNode } from 'react';
import { storedSession, saveSession, clearSession } from '../auth/session';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  authEnabled: boolean;
  username: string | null;
}
interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
}
const AuthContext = createContext<AuthContextType | null>(null);
const signedOut: AuthState = { isAuthenticated: false, isLoading: false, authEnabled: true, username: null };

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ ...signedOut, isLoading: true });

  useEffect(() => {
    let active = true;
    const show = (value: AuthState) => { if (active) setState(value); };
    const check = async () => {
      try {
        const statusRes = await fetch('/api/auth/status');
        const statusData = await statusRes.json();
        if (!statusData.enabled) {
          show({ isAuthenticated: true, isLoading: false, authEnabled: false, username: null });
          return;
        }
        const { token, username } = storedSession();
        if (!token) { show(signedOut); return; }
        const verifyRes = await fetch('/api/auth/verify', { headers: { Authorization: `Bearer ${token}` } });
        if (verifyRes.ok) show({ isAuthenticated: true, isLoading: false, authEnabled: true, username });
        else { if (active) clearSession(); show(signedOut); }
      } catch (error) {
        console.error('Auth check failed:', error);
        show(signedOut);
      }
    };
    void check();
    return () => { active = false; };
  }, []);

  const login = async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Login failed');
    saveSession(data.token, data.username);
    setState({ isAuthenticated: true, isLoading: false, authEnabled: true, username: data.username });
  };
  const logout = () => { clearSession(); setState(signedOut); };

  return <AuthContext.Provider value={{ ...state, login, logout }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used within an AuthProvider');
  return context;
}
