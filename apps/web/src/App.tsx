import { useEffect, useState } from 'react';

interface Health {
  status: string;
  version: string;
  airports: string[];
}

/** Phase 0 placeholder: proves the web build is served and can reach the server. */
export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    fetch('/healthz', { signal: controller.signal })
      .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
      .then((body: Health) => setHealth(body))
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, []);

  return (
    <main className="placeholder">
      <h1>TowerCab</h1>
      <p>Live aircraft around an airport in 3D. The scene is not built yet.</p>
      {health && (
        <p data-testid="health">
          Server {health.status}, version {health.version}. Airports: {health.airports.join(', ')}.
        </p>
      )}
      {error && <p role="alert">Could not reach the server: {error}</p>}
      <footer>Not for navigation or operational use.</footer>
    </main>
  );
}
