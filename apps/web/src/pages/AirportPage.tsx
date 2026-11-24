import type { AirportDetail, AirportSummary, ClientConfig } from '@towercab/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { LiveStore, webSocketFeed } from '../live/store';
import { navigate, setQuery, useLocation } from '../router';
import type { SceneController, SceneMode, SceneStats } from '../scene/SceneController';
import { buildViewPresets, viewForShortcut } from '../scene/views';
import { simFeed } from '../sim/simFeed';
import { SelectionPanel } from '../ui/SelectionPanel';
import { TopBar } from '../ui/TopBar';

interface Notice {
  id: number;
  text: string;
}

/** `/KLAF`: the 3D view of one airport. */
export function AirportPage({ icao }: { icao: string }) {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [airport, setAirport] = useState<AirportDetail | null>(null);
  const [airports, setAirports] = useState<AirportSummary[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setAirport(null);
    setError(null);
    Promise.all([
      api.clientConfig(controller.signal),
      api.airport(icao, controller.signal),
      api.airports(controller.signal),
    ])
      .then(([c, a, list]) => {
        setConfig(c);
        setAirport(a);
        setAirports(list);
      })
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setError(err.message);
      });
    return () => controller.abort();
  }, [icao]);

  if (error) {
    return (
      <main className="placeholder">
        <h1>{icao}</h1>
        <p role="alert">{error}</p>
        <button type="button" className="link" onClick={() => navigate('/')}>
          Back to the airport list
        </button>
      </main>
    );
  }
  if (!config || !airport) {
    return (
      <main className="placeholder">
        <p className="muted">Loading {icao}…</p>
      </main>
    );
  }
  return <AirportScene key={airport.icao} airport={airport} airports={airports} config={config} />;
}

function AirportScene(props: { airport: AirportDetail; airports: AirportSummary[]; config: ClientConfig }) {
  const { airport, airports, config } = props;
  const { search } = useLocation();
  // Read the URL once: it sets where the scene starts, and is kept up to date from then on.
  const initial = useRef(new URLSearchParams(search)).current;
  const simCount = Number(initial.get('sim') ?? 0);
  const showFps = initial.has('fps');

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneController | null>(null);
  const [store] = useState(
    () =>
      new LiveStore(airport.icao, simCount > 0 ? simFeed(airport, Math.min(simCount, 500)) : webSocketFeed),
  );
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SceneMode>(
    initial.get('mode') === 'schematic' || !config.features.photoreal ? 'schematic' : 'photoreal',
  );
  const [view, setView] = useState<string>(initial.get('view') ?? airport.defaultView);
  const [selected, setSelected] = useState<string | null>(null);
  const [trails, setTrails] = useState(true);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [stats, setStats] = useState<SceneStats | null>(null);
  const [, setTick] = useState(0);
  const presets = buildViewPresets(airport);

  useSyncExternalStore(store.subscribe, store.getVersion);

  const notify = useCallback((text: string) => {
    const id = Date.now() + Math.random();
    setNotices((list) => [...list.slice(-2), { id, text }]);
    setTimeout(() => setNotices((list) => list.filter((n) => n.id !== id)), 9000);
  }, []);

  // Build the scene once per airport. The scene module (and Cesium with it) is loaded on demand, so the
  // landing page and the live table stay small.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the scene is created once; later changes go through its methods
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    let cancelled = false;
    let scene: SceneController | null = null;
    store.start();
    import('../scene/SceneController')
      .then(({ SceneController }) =>
        SceneController.create({
          container,
          airport,
          config,
          store,
          mode,
          view,
          // A scene that was discarded before it finished starting must not report back.
          callbacks: {
            onSelect: (hex) => {
              if (!cancelled) setSelected(hex);
            },
            onMode: (m) => {
              if (cancelled) return;
              setMode(m);
              setQuery({ mode: m });
            },
            onView: (v) => {
              if (cancelled) return;
              setView(v);
              setQuery({ view: v === 'free' ? null : v });
            },
            onNotice: (text) => {
              if (!cancelled) notify(text);
            },
          },
        }),
      )
      .then((created) => {
        if (cancelled) {
          created.destroy();
          return;
        }
        scene = created;
        sceneRef.current = created;
        // A handle for the smoke test and for debugging from the console.
        (window as unknown as { __towercab?: unknown }).__towercab = created;
        setReady(true);
      })
      .catch((err: Error) => {
        console.error('TowerCab: the 3D scene failed to start', err);
        if (!cancelled) notify(`The 3D scene could not start: ${err.message}`);
      });
    return () => {
      cancelled = true;
      scene?.destroy();
      sceneRef.current = null;
      store.stop();
    };
  }, []);

  // Ages in the selection panel count up between updates; the frame rate badge refreshes.
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
      if (showFps && sceneRef.current) setStats(sceneRef.current.stats());
    }, 500);
    return () => clearInterval(timer);
  }, [showFps]);

  const changeMode = useCallback((next: SceneMode) => void sceneRef.current?.setMode(next), []);
  const changeView = useCallback((id: string) => sceneRef.current?.setView(id), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && ['INPUT', 'SELECT', 'TEXTAREA'].includes(target.tagName)) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      const scene = sceneRef.current;
      if (!scene) return;
      const key = event.key.toLowerCase();
      if (key === 'f') {
        if (selected) scene.follow(selected);
        else notify('Select an aircraft to follow.');
      } else if (key === 's') {
        void scene.setMode(scene.mode === 'schematic' ? 'photoreal' : 'schematic');
      } else if (key === 'escape') {
        scene.select(null);
      } else {
        const next = viewForShortcut(scene.presets, key, scene.view);
        if (next) scene.setView(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, notify]);

  const selectedAircraft = selected ? store.aircraft.get(selected) : undefined;

  return (
    <div className="app" data-testid="airport-page" data-ready={ready} data-mode={mode}>
      <TopBar
        icao={airport.icao}
        airports={airports}
        mode={mode}
        photorealAvailable={config.features.photoreal}
        presets={presets}
        view={view}
        hasSelection={Boolean(selected)}
        trails={trails}
        onAirport={(next) => navigate(`/${next}`)}
        onMode={changeMode}
        onView={changeView}
        onTrails={(enabled) => {
          setTrails(enabled);
          sceneRef.current?.setTrails(enabled);
        }}
      />

      <div className="stage">
        <div className="scene" ref={containerRef} data-testid="scene" />
        {!ready && <div className="scene-loading muted">Starting the 3D scene…</div>}

        <div className="notices" aria-live="polite">
          {notices.map((n) => (
            <div key={n.id} className="notice">
              {n.text}
            </div>
          ))}
        </div>

        <div className="badges">
          <span className={`pill pill-${store.connection}`} data-testid="connection">
            {store.connection === 'open' ? 'live' : store.connection}
          </span>
          <span className="pill" data-testid="aircraft-count">
            {store.aircraft.size} aircraft
          </span>
          {simCount > 0 && <span className="pill">simulated</span>}
          {showFps && stats && (
            <span className="pill" data-testid="fps">
              {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(1)} ms
            </span>
          )}
        </div>

        {selectedAircraft && (
          <SelectionPanel
            aircraft={selectedAircraft}
            now={store.serverNow()}
            photos={config.features.photos}
            following={view === 'follow'}
            onFollow={() => sceneRef.current?.follow(selectedAircraft.hex)}
            onClose={() => sceneRef.current?.select(null)}
          />
        )}
      </div>

      <footer className="attribution">
        <span>Not for navigation or operational use.</span>
        <span className="credits">
          Data:{' '}
          {config.attributions.map((a, i) => (
            <span key={a.name}>
              {i > 0 && ', '}
              <a href={a.url} target="_blank" rel="noreferrer noopener">
                {a.name}
              </a>
              {a.note ? ` (${a.note})` : ''}
            </span>
          ))}
        </span>
      </footer>
    </div>
  );
}
