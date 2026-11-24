import type {
  AdminCamera,
  AdminCameraPatch,
  AdminState,
  AirportDetail,
  CameraPose,
  ClientConfig,
  PublicCamera,
} from '@towercab/shared';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, adminApi, api, type DiscoveryOutcome } from '../api';
import { type FeedFactory, LiveStore } from '../live/store';
import { navigate } from '../router';
import type { SceneController } from '../scene/SceneController';

const TOKEN_KEY = 'towercab.admin';
/** The pose editor shows the airport, not its traffic. */
const noFeed: FeedFactory = () => ({ start() {}, stop() {}, serverNow: () => Date.now() });

function savedToken(): string {
  try {
    return sessionStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function ago(then: number): string {
  const minutes = Math.max(0, Math.round((Date.now() - then) / 60_000));
  if (minutes < 90) return `${minutes} min ago`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h ago`;
  return `${Math.round(minutes / 1440)} days ago`;
}

function until(then: number): string {
  const minutes = Math.max(1, Math.round((then - Date.now()) / 60_000));
  return minutes < 90 ? `${minutes} min` : `${(minutes / 60).toFixed(1)} h`;
}

/** `/admin`: the camera queue, discovery and the pose editor. */
export function AdminPage() {
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [token, setToken] = useState(savedToken);
  const [entered, setEntered] = useState('');
  const [state, setState] = useState<AdminState | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [icao, setIcao] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<DiscoveryOutcome[] | null>(null);
  const [editing, setEditing] = useState<{ id: string; draft: CameraPose } | null>(null);

  useEffect(() => {
    api
      .clientConfig()
      .then(setConfig)
      .catch((err: Error) => setError(err.message));
  }, []);

  const signOut = useCallback(() => {
    try {
      sessionStorage.removeItem(TOKEN_KEY);
    } catch {
      // nothing was stored
    }
    setToken('');
    setState(null);
  }, []);

  /** Runs an admin call; a refused token sends the page back to the sign-in form. */
  const call = useCallback(
    async <T,>(request: (token: string) => Promise<T>): Promise<T | null> => {
      setBusy(true);
      setError(null);
      try {
        return await request(token);
      } catch (err) {
        if (err instanceof ApiError && err.status === 401) {
          signOut();
          setError('That token was not accepted.');
        } else {
          setError((err as Error).message);
        }
        return null;
      } finally {
        setBusy(false);
      }
    },
    [token, signOut],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: load once per token
  useEffect(() => {
    if (!token || !config?.features.admin) return;
    void call((t) => adminApi.state(t)).then((next) => {
      if (!next) return;
      setState(next);
      setIcao((current) => current ?? next.airports[0]?.icao ?? null);
      try {
        // Kept for this tab only, so a reload does not ask again; closing the tab forgets it.
        sessionStorage.setItem(TOKEN_KEY, token);
      } catch {
        // Private browsing: the token lives in memory until the page is closed.
      }
    });
  }, [token, config?.features.admin]);

  const patch = useCallback(
    async (id: string, change: AdminCameraPatch) => {
      const next = await call((t) => adminApi.patchCamera(t, id, change));
      if (next) setState(next);
      return next !== null;
    },
    [call],
  );

  if (!config) {
    return (
      <main className="placeholder">
        <h1>TowerCab admin</h1>
        {error ? <p role="alert">{error}</p> : <p className="muted">Loading…</p>}
      </main>
    );
  }
  if (!config.features.admin) {
    return (
      <main className="placeholder">
        <h1>TowerCab admin</h1>
        <p>
          Admin is switched off on this server. Set the <code>ADMIN_TOKEN</code> environment variable to a
          long random value and restart the container to switch it on.
        </p>
        <button type="button" className="link" onClick={() => navigate('/')}>
          Back to the airport list
        </button>
      </main>
    );
  }
  if (!token || !state) {
    return (
      <main className="placeholder">
        <h1>TowerCab admin</h1>
        <form
          className="admin-signin"
          onSubmit={(event) => {
            event.preventDefault();
            if (entered.trim()) setToken(entered.trim());
          }}
        >
          <label>
            Admin token
            <input
              type="password"
              value={entered}
              onChange={(e) => setEntered(e.target.value)}
              autoComplete="current-password"
              data-testid="admin-token"
            />
          </label>
          <button type="submit" disabled={busy || !entered.trim()}>
            Sign in
          </button>
        </form>
        {error && <p role="alert">{error}</p>}
        <p className="muted">The token is the value of ADMIN_TOKEN on the server.</p>
      </main>
    );
  }

  const cameras = state.cameras.filter((c) => c.airport === icao);
  const pending = cameras.filter((c) => c.status === 'pending');
  const shown = cameras.filter((c) => c.status === 'approved');
  const rejected = cameras.filter((c) => c.status === 'rejected');
  const runs = state.runs.filter((r) => r.airport === icao);
  const canSearch = state.discovery.enabled && (state.discovery.youtube || state.discovery.windy);

  const card = (camera: AdminCamera) => (
    <CameraCard
      key={camera.id}
      camera={camera}
      token={token}
      busy={busy}
      editing={editing?.id === camera.id}
      onPatch={(change) => void patch(camera.id, change)}
      onEditPose={() => setEditing({ id: camera.id, draft: camera.pose ?? { ...DEFAULT_POSE } })}
    />
  );

  return (
    <div className="admin" data-testid="admin-page">
      <header className="admin-bar">
        <a className="brand" href="/">
          TowerCab
        </a>
        <strong>Cameras</strong>
        <label className="field">
          <span className="visually-hidden">Airport</span>
          <select value={icao ?? ''} onChange={(e) => setIcao(e.target.value)} data-testid="admin-airport">
            {state.airports.map((a) => (
              <option key={a.icao} value={a.icao}>
                {a.icao} · {a.name}
              </option>
            ))}
          </select>
        </label>
        <span className="spacer" />
        <span className="muted small">TowerCab {state.version}</span>
        <button type="button" onClick={signOut}>
          Sign out
        </button>
      </header>

      {error && (
        <p className="admin-error" role="alert">
          {error}
        </p>
      )}

      <div className="admin-columns">
        <section className="admin-list">
          <div className="admin-section">
            <h2>Find cameras</h2>
            {!state.discovery.enabled ? (
              <p className="muted">
                Discovery is off. Set <code>discovery.enabled: true</code> in config.yaml to search YouTube
                and Windy for cameras near an airport.
              </p>
            ) : (
              <>
                <p className="muted">
                  YouTube: {state.discovery.youtube ? 'key set' : 'no YOUTUBE_API_KEY'}. Windy:{' '}
                  {state.discovery.windy ? 'key set' : 'no WINDY_API_KEY'}. A search is sent at most every{' '}
                  {state.discovery.intervalHours} hours per airport; in between, the last results are kept.
                </p>
                <button
                  type="button"
                  disabled={busy || !canSearch || !icao}
                  data-testid="admin-search"
                  onClick={async () => {
                    if (!icao) return;
                    const result = await call((t) => adminApi.discover(t, icao));
                    if (result) {
                      setState(result.state);
                      setOutcomes(result.outcomes);
                    }
                  }}
                >
                  Search near {icao}
                </button>
              </>
            )}
            {outcomes && (
              <ul className="admin-outcomes">
                {outcomes.map((o) => (
                  <li key={o.provider} className={o.ok ? '' : 'bad'}>
                    <strong>{o.provider === 'youtube' ? 'YouTube' : 'Windy'}:</strong>{' '}
                    {o.ran
                      ? o.ok
                        ? `${o.found} found, ${o.added} new.`
                        : `failed. ${o.message ?? ''}`
                      : `not asked. ${o.message ?? ''}`}
                    {o.nextAt ? ` Next search possible in ${until(o.nextAt)}.` : ''}
                  </li>
                ))}
              </ul>
            )}
            {runs.length > 0 && (
              <p className="muted small">
                Last searched:{' '}
                {runs
                  .map(
                    (r) =>
                      `${r.provider === 'youtube' ? 'YouTube' : 'Windy'} ${ago(r.ranAt)} (${r.ok ? `${r.found} found` : 'failed'})`,
                  )
                  .join(', ')}
                .
              </p>
            )}
          </div>

          <div className="admin-section">
            <h2>
              Waiting for a decision <span className="count">{pending.length}</span>
            </h2>
            {pending.length === 0 && <p className="muted">Nothing in the queue.</p>}
            {pending.map(card)}
          </div>

          <div className="admin-section">
            <h2>
              On show <span className="count">{shown.length}</span>
            </h2>
            {shown.length === 0 && (
              <p className="muted">
                No cameras for {icao}. Add them under <code>cameras:</code> in config.yaml, or approve one
                from the queue.
              </p>
            )}
            {shown.map(card)}
          </div>

          {rejected.length > 0 && (
            <details className="admin-section">
              <summary>
                Rejected <span className="count">{rejected.length}</span>
              </summary>
              {rejected.map(card)}
            </details>
          )}
        </section>

        <section className="admin-editor">
          {icao && (
            <PoseEditor
              key={icao}
              icao={icao}
              config={config}
              cameras={cameras}
              editing={editing}
              busy={busy}
              onDraft={(draft) => setEditing((current) => (current ? { ...current, draft } : current))}
              onCancel={() => setEditing(null)}
              onSave={async () => {
                if (editing && (await patch(editing.id, { pose: editing.draft }))) setEditing(null);
              }}
              onRemove={async () => {
                if (editing && (await patch(editing.id, { pose: null }))) setEditing(null);
              }}
            />
          )}
        </section>
      </div>
    </div>
  );
}

/** Where a new pose starts: filled in with the airport's position when editing begins. */
const DEFAULT_POSE: CameraPose = { lat: 0, lon: 0, heightM: 10, headingDeg: 0, pitchDeg: 0, hfovDeg: 60 };

function CameraCard(props: {
  camera: AdminCamera;
  token: string;
  busy: boolean;
  editing: boolean;
  onPatch(change: AdminCameraPatch): void;
  onEditPose(): void;
}) {
  const { camera, busy } = props;
  const [name, setName] = useState(camera.name);
  const [picture, setPicture] = useState<string | null>(camera.thumbnail ?? null);
  const discovered = camera.origin === 'discovery';

  // Windy picture addresses expire, so the queue entry has none; a fresh one is asked for when shown.
  useEffect(() => {
    if (camera.thumbnail || camera.provider !== 'windy') return;
    let cancelled = false;
    adminApi
      .preview(props.token, camera.id)
      .then((r) => !cancelled && setPicture(r.url))
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [camera.id, camera.thumbnail, camera.provider, props.token]);

  return (
    <article
      className={`admin-card${props.editing ? ' editing' : ''}`}
      data-testid={`admin-camera-${camera.id}`}
    >
      {picture &&
        (camera.link ? (
          <a href={camera.link} target="_blank" rel="noreferrer noopener" className="admin-thumb">
            <img src={picture} alt="" loading="lazy" />
          </a>
        ) : (
          <span className="admin-thumb">
            <img src={picture} alt="" loading="lazy" />
          </span>
        ))}
      <div className="admin-card-body">
        {discovered ? (
          <input
            className="admin-name"
            value={name}
            aria-label="Camera name"
            onChange={(e) => setName(e.target.value)}
            onBlur={() => name.trim() && name !== camera.name && props.onPatch({ name: name.trim() })}
          />
        ) : (
          <strong>{camera.name}</strong>
        )}
        <p className="muted small">
          {camera.kind}
          {camera.provider ? ` · ${camera.provider === 'youtube' ? 'YouTube' : 'Windy'}` : ' · config.yaml'}
          {camera.detail?.channel ? ` · ${camera.detail.channel}` : ''}
          {camera.detail?.distanceKm !== undefined ? ` · ${camera.detail.distanceKm} km from the field` : ''}
          {camera.detail?.foundBy ? ` · found by ${camera.detail.foundBy}` : ''}
          {camera.foundAt ? ` · ${ago(camera.foundAt)}` : ''}
          {!camera.enabled ? ' · switched off' : ''}
        </p>
        {camera.detail?.description && <p className="small admin-description">{camera.detail.description}</p>}
        <div className="admin-actions">
          {discovered && camera.status !== 'approved' && (
            <button type="button" disabled={busy} onClick={() => props.onPatch({ status: 'approved' })}>
              Approve
            </button>
          )}
          {discovered && camera.status !== 'rejected' && (
            <button type="button" disabled={busy} onClick={() => props.onPatch({ status: 'rejected' })}>
              Reject
            </button>
          )}
          {discovered && camera.status === 'approved' && (
            <button type="button" disabled={busy} onClick={() => props.onPatch({ enabled: !camera.enabled })}>
              {camera.enabled ? 'Switch off' : 'Switch on'}
            </button>
          )}
          <button
            type="button"
            disabled={busy}
            className={props.editing ? 'on' : ''}
            onClick={props.onEditPose}
          >
            {camera.pose ? 'Edit pose' : 'Set pose'}
          </button>
          {camera.link && (
            <a href={camera.link} target="_blank" rel="noreferrer noopener">
              Open source
            </a>
          )}
        </div>
      </div>
    </article>
  );
}

const FIELDS: {
  key: keyof CameraPose;
  label: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}[] = [
  { key: 'headingDeg', label: 'Direction', min: 0, max: 360, step: 1, unit: '°' },
  { key: 'hfovDeg', label: 'Field of view', min: 5, max: 170, step: 1, unit: '°' },
  { key: 'pitchDeg', label: 'Tilt', min: -60, max: 30, step: 1, unit: '°' },
  { key: 'heightM', label: 'Height above ground', min: 0, max: 150, step: 0.5, unit: 'm' },
];

/** The 3D view of the airport in which a camera is placed and aimed. */
function PoseEditor(props: {
  icao: string;
  config: ClientConfig;
  cameras: AdminCamera[];
  editing: { id: string; draft: CameraPose } | null;
  busy: boolean;
  onDraft(pose: CameraPose): void;
  onCancel(): void;
  onSave(): void;
  onRemove(): void;
}) {
  const { icao, config, cameras, editing } = props;
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SceneController | null>(null);
  const [airport, setAirport] = useState<AirportDetail | null>(null);
  const [ready, setReady] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [looking, setLooking] = useState(false);
  const onDraft = useRef(props.onDraft);
  onDraft.current = props.onDraft;

  useEffect(() => {
    api
      .airport(icao)
      .then(setAirport)
      .catch((err: Error) => setProblem(err.message));
  }, [icao]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: one scene per airport
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !airport) return;
    let cancelled = false;
    let scene: SceneController | null = null;
    const store = new LiveStore(airport.icao, noFeed);
    import('../scene/SceneController')
      .then(({ SceneController }) =>
        SceneController.create({
          container,
          airport,
          config,
          store,
          // `?mode=schematic` works here as it does on an airport page.
          mode:
            config.features.photoreal &&
            new URLSearchParams(window.location.search).get('mode') !== 'schematic'
              ? 'photoreal'
              : 'schematic',
          view: 'overhead',
          callbacks: { onNotice: (text) => !cancelled && setProblem(text) },
        }),
      )
      .then((created) => {
        if (cancelled) return created.destroy();
        scene = created;
        sceneRef.current = created;
        // A handle for tests and for debugging from the console, as on the airport page.
        (window as unknown as { __towercab?: unknown }).__towercab = created;
        setReady(true);
      })
      .catch((err: Error) => !cancelled && setProblem(`The 3D view could not start: ${err.message}`));
    return () => {
      cancelled = true;
      scene?.destroy();
      sceneRef.current = null;
      setReady(false);
    };
  }, [airport]);

  // A pose that has never been set starts at the middle of the field.
  const unplaced = editing !== null && editing.draft.lat === 0 && editing.draft.lon === 0;
  useEffect(() => {
    if (editing && unplaced && airport) {
      onDraft.current({ ...editing.draft, lat: airport.lat, lon: airport.lon });
    }
  }, [editing, unplaced, airport]);
  const draft = useMemo(() => (editing && !unplaced ? editing.draft : null), [editing, unplaced]);

  // The scene shows every camera's cone, the one being edited with the draft pose and its handles.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!ready || !scene) return;
    const list: PublicCamera[] = cameras.flatMap((c) => {
      const pose = editing?.id === c.id ? (draft ?? undefined) : c.pose;
      if (!pose) return [];
      return [
        { id: c.id, airport: c.airport, name: c.name, kind: c.kind, src: '', refreshSeconds: 60, pose },
      ];
    });
    scene.setCameras(list);
    scene.setConesVisible(true);
    scene.setActiveCamera(editing?.id ?? null);
    if (looking && editing) scene.matchCamera(editing.id, { animate: false });
    scene.editPose(draft && !looking ? { pose: draft, onChange: (pose) => onDraft.current(pose) } : null);
  }, [ready, cameras, editing, draft, looking]);

  const camera = cameras.find((c) => c.id === editing?.id);

  return (
    <div className="pose-editor">
      <div className="pose-scene" ref={containerRef} data-testid="pose-scene" />
      {!ready && <div className="scene-loading muted">{problem ?? 'Starting the 3D view…'}</div>}
      <aside className="pose-form">
        {!editing || !draft || !camera ? (
          <p className="muted">
            Cameras with a pose are drawn here as view cones. Choose “Set pose” on a camera to place it.
          </p>
        ) : (
          <>
            <h2>{camera.name}</h2>
            <p className="muted small">
              Click on the ground to put the camera there. Drag the yellow handle to turn it and the blue
              handle to set how much it sees.
            </p>
            <p className="mono small">
              {draft.lat.toFixed(6)}, {draft.lon.toFixed(6)}
            </p>
            {FIELDS.map((field) => (
              <label key={field.key} className="pose-field">
                <span>{field.label}</span>
                <input
                  type="range"
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={draft[field.key]}
                  onChange={(e) => props.onDraft({ ...draft, [field.key]: Number(e.target.value) })}
                />
                <output>
                  {draft[field.key]}
                  {field.unit}
                </output>
              </label>
            ))}
            <div className="admin-actions">
              <button
                type="button"
                className={looking ? 'on' : ''}
                aria-pressed={looking}
                onClick={() => {
                  if (looking) {
                    sceneRef.current?.endMatch();
                    sceneRef.current?.setView('overhead');
                  }
                  setLooking(!looking);
                }}
              >
                {looking ? 'Back to the map' : 'Look through it'}
              </button>
              <button
                type="button"
                disabled={props.busy}
                onClick={() => {
                  setLooking(false);
                  sceneRef.current?.setView('overhead');
                  props.onSave();
                }}
                data-testid="pose-save"
              >
                Save pose
              </button>
              {/* Only a pose saved on this page can be taken away here. */}
              {camera.poseFrom === 'admin' && (
                <button type="button" disabled={props.busy} onClick={props.onRemove}>
                  {camera.origin === 'config' ? 'Back to config.yaml' : 'Remove pose'}
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  setLooking(false);
                  sceneRef.current?.setView('overhead');
                  props.onCancel();
                }}
              >
                Cancel
              </button>
            </div>
            {camera.origin === 'config' && (
              <p className="muted small">
                A pose saved here takes the place of the one in config.yaml for this camera, until it is
                removed here.
              </p>
            )}
          </>
        )}
      </aside>
    </div>
  );
}
