import type { AirportSummary } from '@towercab/shared';
import { lazy, Suspense, useEffect, useState } from 'react';
import { api } from './api';
import { AirportPage } from './pages/AirportPage';
import { DebugPage } from './pages/DebugPage';
import { navigate, useRoute } from './router';

// Few people ever open the admin page; it is fetched when they do.
const AdminPage = lazy(() => import('./pages/AdminPage').then((m) => ({ default: m.AdminPage })));

/** Landing page: the configured airports. */
function Home() {
  const [airports, setAirports] = useState<AirportSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    api
      .airports(controller.signal)
      .then(setAirports)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="placeholder">
      <h1>TowerCab</h1>
      <p>Live aircraft around an airport in 3D.</p>
      {error && <p role="alert">Could not reach the server: {error}</p>}
      <nav className="airport-list" data-testid="airport-list">
        {airports?.map((a) => (
          <div key={a.icao} className="airport-card">
            <strong>{a.icao}</strong>
            <span>{a.name}</span>
            {a.available ? (
              <span className="airport-links">
                <button type="button" className="link" onClick={() => navigate(`/${a.icao}`)}>
                  3D view
                </button>
                <button type="button" className="link" onClick={() => navigate(`/debug/${a.icao}`)}>
                  Live table
                </button>
              </span>
            ) : (
              <span className="muted">no reference data yet</span>
            )}
          </div>
        ))}
      </nav>
      <footer>Not for navigation or operational use.</footer>
    </main>
  );
}

export function App() {
  const route = useRoute();
  switch (route.name) {
    case 'home':
      return <Home />;
    case 'debug':
      return <DebugPage icao={route.icao} />;
    case 'airport':
      return <AirportPage icao={route.icao} />;
    case 'admin':
      return (
        <Suspense
          fallback={
            <main className="placeholder">
              <p className="muted">Loading…</p>
            </main>
          }
        >
          <AdminPage />
        </Suspense>
      );
    default:
      return (
        <main className="placeholder">
          <h1>TowerCab</h1>
          <p>There is nothing at this address.</p>
          <button type="button" className="link" onClick={() => navigate('/')}>
            Back to the airport list
          </button>
        </main>
      );
  }
}
