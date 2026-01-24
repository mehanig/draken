import { Routes, Route, Link } from 'react-router-dom';
import { ProjectList } from './pages/ProjectList';
import { ProjectDetail } from './pages/ProjectDetail';

export default function App() {
  return (
    <div className="app-container">
      <header className="header">
        <div className="header-content">
          <Link to="/" className="logo">
            <svg className="logo-icon" viewBox="0 0 100 100">
              <defs>
                <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="100%">
                  <stop offset="0%" style={{ stopColor: '#6366f1', stopOpacity: 1 }} />
                  <stop offset="100%" style={{ stopColor: '#8b5cf6', stopOpacity: 1 }} />
                </linearGradient>
              </defs>
              <circle cx="50" cy="50" r="45" fill="url(#grad)" />
              <path d="M30 35 L50 25 L70 35 L70 65 L50 75 L30 65 Z" fill="none" stroke="white" strokeWidth="3" />
              <path d="M50 25 L50 75" stroke="white" strokeWidth="2" />
              <path d="M30 50 L70 50" stroke="white" strokeWidth="2" />
              <circle cx="50" cy="50" r="8" fill="white" />
            </svg>
            <div>
              <div className="logo-text">Draken</div>
              <div className="logo-subtitle">Claude Code Dashboard</div>
            </div>
          </Link>
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
