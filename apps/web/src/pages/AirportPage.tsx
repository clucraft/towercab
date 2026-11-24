import type { AirportDetail, AirportSummary, ClientConfig, Metar } from '@towercab/shared';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { api } from '../api';
import { replayFeed } from '../live/replayFeed';
import { type FeedFactory, LiveStore, webSocketFeed } from '../live/store';
import { navigate, setQuery, useLocation } from '../router';
import type { SceneController, SceneMode, SceneStats } from '../scene/SceneController';
import { buildViewPresets, viewForShortcut } from '../scene/views';
import { simFeed } from '../sim/simFeed';
import { SelectionPanel } from '../ui/SelectionPanel';
import { SidePanel } from '../ui/SidePanel';
import { TopBar } from '../ui/TopBar';

interface Notice {
  id: number;
  text: string;
}

const METAR_REFRESH_MS = 5 * 60_000;
/** On a phone held sideways, or any small window, the side panel starts closed and opens over the scene. */
const SMALL_SCREEN = '(max-width: 900px), (max-height: 520px)';

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

/** Picks where traffic comes from: the server, a recording (`?replay=name`) or the simulator (`?sim=150`). */
function chooseFeed(
  params: URLSearchParams,
  airport: AirportDetail,
): { factory: FeedFactory; label: string | null } {
  const replay = params.get('replay');
  if (replay && /^[a-z0-9-]{1,64}$/i.test(replay)) return { factory: replayFeed(replay), label: 'replay' };
  const sim = Number(params.get('sim') ?? 0);
  if (sim > 0) return { factory: simFeed(airport, Math.min(sim, 500)), label: 'simulated' };
  return { factory: webSocketFeed, label: null };
}

function AirportScene(props: { airport: AirportDetail; airports: AirportSummary[]; config: ClientConfig }) {
  const { airports, config } = props;
  const { search } = useLocation();
  // Read the URL once: it sets where the scene starts, and is kept up to date from then on.
  const initial = useRef(new URLSearchParams(search)).current;
  const showFps = initial.has('fps');

  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneController | null>(null);
  const [airport, setAirport] = useState(props.airport);
  const [feed] = useState(() => chooseFeed(initial, props.airport));
  const [store] = useState(() => new LiveStore(props.airport.icao, feed.factory));
  const [ready, setReady] = useState(false);
  const [mode, setMode] = useState<SceneMode>(
    initial.get('mode') === 'schematic' || !config.features.photoreal ? 'schematic' : 'photoreal',
  );
  const [view, setView] = useState<string>(initial.get('view') ?? airport.defaultView);
  const [selected, setSelected] = useState<string | null>(null);
  const [trails, setTrails] = useState(true);
  const [panelOpen, setPanelOpen] = useState(() => !window.matchMedia(SMALL_SCREEN).matches);
  const [metar, setMetar] = useState<Metar | null>(null);
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

  // The airport layout comes from OpenStreetMap and may still be on its way the first time an airport
  // is opened. Ask again a few times until it is there.
  useEffect(() => {
    if (airport.layout) return;
    let attempts = 0;
    const timer = setInterval(() => {
      attempts += 1;
      if (attempts > 6) clearInterval(timer);
      api
        .airport(airport.icao)
        .then((next) => {
          if (!next.layout) return;
          clearInterval(timer);
          setAirport(next);
          sceneRef.current?.setAirport(next);
        })
        .catch(() => {
          // Keep what we have.
        });
    }, 20_000);
    return () => clearInterval(timer);
  }, [airport]);

  useEffect(() => {
    const controller = new AbortController();
    const load = () =>
      api
        .metar(airport.icao, controller.signal)
        .then(setMetar)
        .catch(() => {
          // The panel says "no METAR"; nothing else to do.
        });
    void load();
    const timer = setInterval(load, METAR_REFRESH_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, [airport.icao]);

  // Ages count up between updates; the frame rate badge refreshes.
  useEffect(() => {
    const timer = setInterval(() => {
      setTick((t) => t + 1);
      if (showFps && sceneRef.current) setStats(sceneRef.current.stats());
    }, 500);
    return () => clearInterval(timer);
  }, [showFps]);

  const changeMode = useCallback((next: SceneMode) => void sceneRef.current?.setMode(next), []);
  const changeView = useCallback((id: string) => sceneRef.current?.setView(id), []);
  const select = useCallback((hex: string | null) => sceneRef.current?.select(hex), []);

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
  const now = store.serverNow();
  // Imagery credits are shown by Cesium inside the 3D view; they are repeated here by name.
  const imagery = [
    mode === 'photoreal' ? 'Google' : null,
    mode === 'photoreal' || config.features.terrain ? 'Cesium ion' : null,
    'CesiumJS',
  ].filter(Boolean);

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
        panelOpen={panelOpen}
        onAirport={(next) => navigate(`/${next}`)}
        onMode={changeMode}
        onView={changeView}
        onTrails={(enabled) => {
          setTrails(enabled);
          sceneRef.current?.setTrails(enabled);
        }}
        onPanel={() => setPanelOpen((open) => !open)}
      />

      <div className={`workspace${panelOpen ? ' with-panel' : ''}`}>
        <div className="stage">
          <div className="scene" ref={containerRef} data-testid="scene" />
          {!ready && <div className="scene-loading muted">Starting the 3D scene…</div>}

          <div className="notices" aria-live="polite">
            {store.error && <div className="notice">{store.error.message}</div>}
            {notices.map((n) => (
              <div key={n.id} className="notice">
                {n.text}
              </div>
            ))}
          </div>

          <div className="badges">
            {/* A recording or the simulator must never read as "live". */}
            <span
              className={`pill ${feed.label && store.connection === 'open' ? 'pill-note' : `pill-${store.connection}`}`}
              data-testid="connection"
            >
              {store.connection === 'open' ? (feed.label ?? 'live') : store.connection}
            </span>
            <span className="pill" data-testid="aircraft-count">
              {store.aircraft.size} aircraft
            </span>
            {showFps && stats && (
              <span className="pill" data-testid="fps">
                {stats.fps.toFixed(0)} fps · {stats.frameMs.toFixed(1)} ms
              </span>
            )}
          </div>

          {selectedAircraft && (
            <SelectionPanel
              aircraft={selectedAircraft}
              now={now}
              photos={config.features.photos}
              following={view === 'follow'}
              onFollow={() => sceneRef.current?.follow(selectedAircraft.hex)}
              onClose={() => select(null)}
            />
          )}
        </div>

        {panelOpen && (
          <SidePanel
            airport={airport}
            aircraft={[...store.aircraft.values()]}
            status={store.status}
            metar={metar}
            now={now}
            feedLabel={feed.label}
            selected={selected}
            onSelect={(hex) => select(hex)}
            onClose={() => setPanelOpen(false)}
          />
        )}
      </div>

      <footer className="attribution">
        <span className="disclaimer">Not for navigation or operational use.</span>
        <span className="credits" data-testid="credits">
          Imagery: {imagery.join(', ')}. Data:{' '}
          {config.attributions.map((a, i) => (
            <span key={a.name}>
              {i > 0 && ', '}
              <a href={a.url} target="_blank" rel="noreferrer noopener">
                {a.name}
              </a>
              {a.note ? ` (${a.note})` : ''}
            </span>
          ))}
          .
        </span>
      </footer>
    </div>
  );
}
