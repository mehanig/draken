import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Login } from './pages/Login';
import { Sync } from './pages/Sync';
import { Home, linkClick } from './pages/Home';
import { History } from './pages/History';
import { IndexSettings } from './components/IndexSettings';

function AppContent() {
  const { isAuthenticated, isLoading, authEnabled, username, logout } = useAuth();
  const [path, setPath] = useState(window.location.pathname), [callIntent, setCallIntent] = useState<number | null>(null);
  const guard = useRef<(() => boolean) | null>(null), currentPath = useRef(path);
  const setGuard = useCallback((value: (() => boolean) | null) => { guard.current = value; }, []);
  const navigate = useCallback((next: string, call = false) => {
    if (guard.current && !guard.current()) return;
    window.history.pushState(null, '', next); currentPath.current = next; setPath(next);
    setCallIntent(call ? Number(next.split('/').pop()) : null); window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const pop = () => {
      if (guard.current && !guard.current()) { window.history.pushState(null, '', currentPath.current); return; }
      currentPath.current = window.location.pathname; setPath(currentPath.current); setCallIntent(null);
    };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  if (isLoading) return <div className="app-loading"><span className="spinner" />Opening Draken…</div>;
  if (!isAuthenticated) return <Login />;
  const match = /^\/syncs\/([1-9]\d*)(\/chat)?\/?$/.exec(path), id = match ? Number(match[1]) : null;
  return <div className="app-container">
    <header className="header"><a className="brand" href="/" onClick={event => linkClick(event, navigate, '/')} aria-label="Draken sync history"><img src="/favicon.png" alt="" /><div><strong>Draken</strong><span>Session sync</span></div></a>
      <div className="header-right"><a href="/history" onClick={event => linkClick(event, navigate, '/history')}>Search history</a><IndexSettings />{authEnabled && <><span className="muted small">{username}</span><button className="icon-button" onClick={() => { if (!guard.current || guard.current()) logout(); }} aria-label="Sign out"><LogOut size={18} /></button></>}</div>
    </header>
    {id && Number.isSafeInteger(id) ? <Sync key={id} id={id} chat={Boolean(match?.[2])} callIntent={callIntent === id} consumeIntent={() => setCallIntent(null)} navigate={navigate} setGuard={setGuard} />
      : /^\/history(?:\/H[a-f0-9]{24})?\/?$/.test(path) ? <History key={path} navigate={navigate} reference={path.split('/')[2]} />
      : path === '/' ? <Home navigate={navigate} /> : <main className="sync-home"><h1>Page not found</h1><a href="/" onClick={event => linkClick(event, navigate, '/')}>All syncs</a></main>}
  </div>;
}

export default function App() { return <AuthProvider><AppContent /></AuthProvider>; }
