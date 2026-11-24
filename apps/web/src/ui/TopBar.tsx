import type { AirportSummary } from '@towercab/shared';
import type { SceneMode } from '../scene/SceneController';
import type { ViewPreset } from '../scene/views';

interface Props {
  icao: string;
  airports: AirportSummary[];
  mode: SceneMode;
  photorealAvailable: boolean;
  presets: ViewPreset[];
  view: string;
  hasSelection: boolean;
  trails: boolean;
  panelOpen: boolean;
  onAirport(icao: string): void;
  onMode(mode: SceneMode): void;
  onView(id: string): void;
  onTrails(enabled: boolean): void;
  onPanel(): void;
}

/** Airport switcher, base map switch and view presets. */
export function TopBar(props: Props) {
  const { presets, view } = props;
  const runwayEnds = presets.filter((p) => p.id.startsWith('rwy-'));
  const simple = presets.filter((p) => !p.id.startsWith('rwy-'));
  const shortcut: Record<string, string> = { tower: '1', overhead: '2', orbit: '4', follow: '5' };

  return (
    <header className="topbar">
      <a className="brand" href="/" aria-label="TowerCab home">
        TowerCab
      </a>

      <label className="field">
        <span className="visually-hidden">Airport</span>
        <select
          value={props.icao}
          onChange={(e) => props.onAirport(e.target.value)}
          data-testid="airport-switcher"
        >
          {props.airports.map((a) => (
            <option key={a.icao} value={a.icao} disabled={!a.available}>
              {a.icao} · {a.name}
            </option>
          ))}
        </select>
      </label>

      <fieldset className="segmented" aria-label="Base map">
        <button
          type="button"
          className={props.mode === 'photoreal' ? 'on' : ''}
          aria-pressed={props.mode === 'photoreal'}
          disabled={!props.photorealAvailable}
          title={
            props.photorealAvailable
              ? 'Google Photorealistic 3D Tiles'
              : 'Needs a Cesium ion token or a Google Maps key'
          }
          onClick={() => props.onMode('photoreal')}
        >
          Photoreal
        </button>
        <button
          type="button"
          className={props.mode === 'schematic' ? 'on' : ''}
          aria-pressed={props.mode === 'schematic'}
          title="Schematic (S)"
          onClick={() => props.onMode('schematic')}
        >
          Schematic
        </button>
      </fieldset>

      <nav className="views" aria-label="Views">
        {simple.map((preset) => {
          const disabled = !preset.available || (preset.kind === 'follow' && !props.hasSelection);
          const key = shortcut[preset.id];
          return (
            <button
              key={preset.id}
              type="button"
              className={view === preset.id ? 'on' : ''}
              aria-pressed={view === preset.id}
              disabled={disabled}
              title={[
                preset.label,
                key ? `(${key})` : '',
                disabled || preset.note ? `· ${preset.note ?? ''}` : '',
              ]
                .filter(Boolean)
                .join(' ')}
              onClick={() => props.onView(preset.id)}
              data-testid={`view-${preset.id}`}
            >
              {preset.label}
            </button>
          );
        })}
        {runwayEnds.length > 0 && (
          <label className="field">
            <span className="visually-hidden">Runway end</span>
            <select
              className={view.startsWith('rwy-') ? 'on' : ''}
              value={view.startsWith('rwy-') ? view : ''}
              onChange={(e) => e.target.value && props.onView(e.target.value)}
              title="Runway ends (3)"
            >
              <option value="">Runway…</option>
              {runwayEnds.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
        )}
      </nav>

      <span className="spacer" />

      <label className="check">
        <input type="checkbox" checked={props.trails} onChange={(e) => props.onTrails(e.target.checked)} />
        Trails
      </label>
      <a className="link" href={`/debug/${props.icao}`}>
        Table
      </a>
      <button
        type="button"
        className={props.panelOpen ? 'on' : ''}
        aria-pressed={props.panelOpen}
        onClick={props.onPanel}
        data-testid="panel-toggle"
        title="Aircraft list, weather and data sources"
      >
        Panel
      </button>
    </header>
  );
}
