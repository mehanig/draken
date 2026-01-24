import {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  type ReactNode,
} from 'react';

interface AuthState {
  isAuthenticated: boolean;
  isLoading: boolean;
  authEnabled: boolean;
  username: string | null;
  token: string | null;
}

interface AuthContextType extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  logout: () => void;
  checkAuth: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

const TOKEN_KEY = 'draken_token';
const USERNAME_KEY = 'draken_username';

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({
    isAuthenticated: false,
    isLoading: true,
    authEnabled: true, // Assume enabled until we check
    username: null,
    token: null,
  });

  const checkAuth = useCallback(async () => {
    setState((s) => ({ ...s, isLoading: true }));

    try {
      // First check if auth is enabled
      const statusRes = await fetch('/api/auth/status');
      const statusData = await statusRes.json();

      if (!statusData.enabled) {
        // Auth is disabled, allow access
        setState({
          isAuthenticated: true,
          isLoading: false,
          authEnabled: false,
          username: null,
          token: null,
        });
        return;
      }

      // Auth is enabled, check for existing token
      const storedToken = localStorage.getItem(TOKEN_KEY);
      const storedUsername = localStorage.getItem(USERNAME_KEY);

      if (!storedToken) {
        setState({
          isAuthenticated: false,
          isLoading: false,
          authEnabled: true,
          username: null,
          token: null,
        });
        return;
      }

      // Verify token
      const verifyRes = await fetch('/api/auth/verify', {
        headers: {
          Authorization: `Bearer ${storedToken}`,
        },
      });

      if (verifyRes.ok) {
        setState({
          isAuthenticated: true,
          isLoading: false,
          authEnabled: true,
          username: storedUsername,
          token: storedToken,
        });
      } else {
        // Token invalid, clear it
        localStorage.removeItem(TOKEN_KEY);
        localStorage.removeItem(USERNAME_KEY);
        setState({
          isAuthenticated: false,
          isLoading: false,
          authEnabled: true,
          username: null,
          token: null,
        });
      }
    } catch (err) {
      console.error('Auth check failed:', err);
      setState({
        isAuthenticated: false,
        isLoading: false,
        authEnabled: true,
        username: null,
        token: null,
      });
    }
  }, []);

  const login = async (username: string, password: string) => {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

    if (!res.ok) {
      const data = await res.json();
      throw new Error(data.error || 'Login failed');
    }

    const data = await res.json();

    localStorage.setItem(TOKEN_KEY, data.token);
    localStorage.setItem(USERNAME_KEY, data.username);

    setState({
      isAuthenticated: true,
      isLoading: false,
      authEnabled: true,
      username: data.username,
      token: data.token,
    });
  };

  const logout = () => {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USERNAME_KEY);
    setState({
      isAuthenticated: false,
      isLoading: false,
      authEnabled: true,
      username: null,
      token: null,
    });
  };

  useEffect(() => {
    checkAuth();
  }, [checkAuth]);

  return (
    <AuthContext.Provider value={{ ...state, login, logout, checkAuth }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

// Helper to get current token for API calls
export function getAuthToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}
