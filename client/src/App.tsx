import { useCallback, useEffect, useRef, useState } from 'react';
import { LogOut, Menu, X } from 'lucide-react';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import { Login } from './pages/Login';
import { Sync } from './pages/Sync';
import { Home } from './pages/Home';
import { linkClick } from './navigation';
import { History } from './pages/History';
import { Settings } from './pages/Settings';
import { Factory } from './pages/Factory';

function AppContent() {
  const { isAuthenticated, isLoading, authEnabled, username, logout } = useAuth();
  const [path, setPath] = useState(window.location.pathname), [callIntent, setCallIntent] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const header = useRef<HTMLElement | null>(null), menuButton = useRef<HTMLButtonElement | null>(null);
  const guard = useRef<(() => boolean) | null>(null), currentPath = useRef(path);
  const setGuard = useCallback((value: (() => boolean) | null) => { guard.current = value; }, []);
  const navigate = useCallback((next: string, call = false) => {
    if (guard.current && !guard.current()) return;
    setMenuOpen(false);
    window.history.pushState(null, '', next); currentPath.current = next; setPath(next);
    setCallIntent(call ? Number(next.split('/').pop()) : null); window.scrollTo(0, 0);
  }, []);
  useEffect(() => {
    const pop = () => {
      if (guard.current && !guard.current()) { window.history.pushState(null, '', currentPath.current); return; }
      setMenuOpen(false);
      currentPath.current = window.location.pathname; setPath(currentPath.current); setCallIntent(null);
    };
    window.addEventListener('popstate', pop); return () => window.removeEventListener('popstate', pop);
  }, []);
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!header.current?.contains(event.target as Node)) setMenuOpen(false); };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && menuOpen) { setMenuOpen(false); menuButton.current?.focus(); }
    };
    const desktop = window.matchMedia('(min-width: 761px)');
    const resize = () => setMenuOpen(false);
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape); desktop.addEventListener('change', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); desktop.removeEventListener('change', resize); };
  }, [menuOpen]);
  if (isLoading) return <div className="app-loading"><span className="spinner" />Opening Draken…</div>;
  if (!isAuthenticated) return <Login />;
  const match = /^\/syncs\/([1-9]\d*)(\/chat)?\/?$/.exec(path), id = match ? Number(match[1]) : null;
  return <div className="app-container">
    <header className="header" ref={header}><a className="brand" href="/" onClick={event => linkClick(event, navigate, '/')} aria-label="Draken sync history"><img src="/favicon.png" alt="" /><div><strong>Draken</strong><span>Session sync</span></div></a>
      <button ref={menuButton} type="button" className="icon-button header-menu-button" aria-label="Menu" aria-expanded={menuOpen} aria-controls="header-navigation" onClick={() => setMenuOpen(open => !open)}>{menuOpen ? <X size={22} /> : <Menu size={22} />}</button>
      <nav id="header-navigation" aria-label="Main" className={`header-right${menuOpen ? ' is-open' : ''}`}>
        <a href="/history" onClick={event => linkClick(event, navigate, '/history')} aria-current={/^\/history(?:\/|$)/.test(path) ? 'page' : undefined}>Search history</a>
        <a href="/factory" onClick={event => linkClick(event, navigate, '/factory')} aria-current={/^\/factory\/?$/.test(path) ? 'page' : undefined}>Factory</a>
        <a href="/settings" onClick={event => linkClick(event, navigate, '/settings')} aria-current={/^\/settings\/?$/.test(path) ? 'page' : undefined}>Settings</a>
        {authEnabled && <><span className="muted small header-username">{username}</span><button className="icon-button" onClick={() => { if (!guard.current || guard.current()) { setMenuOpen(false); logout(); } }} aria-label="Sign out"><LogOut size={18} /></button></>}
      </nav>
    </header>
    {id && Number.isSafeInteger(id) ? <Sync key={id} id={id} chat={Boolean(match?.[2])} callIntent={callIntent === id} consumeIntent={() => setCallIntent(null)} navigate={navigate} setGuard={setGuard} />
      : /^\/history(?:\/H[a-f0-9]{24})?\/?$/.test(path) ? <History key={path} navigate={navigate} reference={path.split('/')[2]} />
      : /^\/factory\/?$/.test(path) ? <Factory />
      : /^\/settings\/?$/.test(path) ? <Settings />
      : path === '/' ? <Home navigate={navigate} /> : <main className="sync-home"><h1>Page not found</h1><a href="/" onClick={event => linkClick(event, navigate, '/')}>All syncs</a></main>}
  </div>;
}

export default function App() { return <AuthProvider><AppContent /></AuthProvider>; }
