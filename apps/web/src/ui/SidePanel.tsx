import {
  type Aircraft,
  type AirportDetail,
  type AirportStatus,
  aircraftLabel,
  describeWind,
  hpaToInHg,
  type Metar,
  type Phase,
  type ProviderHealth,
  rankRunwaysByWind,
} from '@towercab/shared';
import type { SkySetting } from '../scene/sky';
import { Daylight } from './Daylight';

interface Props {
  airport: AirportDetail;
  aircraft: Aircraft[];
  status: AirportStatus | null;
  metar: Metar | null;
  /** The server's clock, for data ages. */
  now: number;
  /** What the sky does. */
  sky: SkySetting;
  onSky(sky: SkySetting): void;
  /** "replay" or "simulated" when the traffic is not live. */
  feedLabel: string | null;
  selected: string | null;
  onSelect(hex: string): void;
  onClose(): void;
}

/** The list groups, in the order a controller would care about them. Vehicles come after, on their own. */
const GROUPS: { title: string; phases: Phase[] }[] = [
  { title: 'Departing', phases: ['takeoff_roll', 'departing'] },
  { title: 'Arriving', phases: ['arriving', 'landing_roll'] },
  { title: 'Pattern', phases: ['pattern'] },
  { title: 'Taxiing', phases: ['taxiing'] },
  { title: 'Parked', phases: ['parked'] },
  { title: 'Passing through', phases: ['transit'] },
  { title: 'Vehicles', phases: ['vehicle'] },
];

/** How many aircraft there are. The vehicles that are tracked along with them do not count. */
export function countAircraft(tracked: Iterable<Aircraft>): number {
  let n = 0;
  for (const a of tracked) if (a.phase !== 'vehicle') n += 1;
  return n;
}

function age(now: number, then: number | undefined): string {
  if (then === undefined) return 'never';
  const s = Math.max(0, Math.round((now - then) / 1000));
  if (s < 90) return `${s} s ago`;
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  return `${Math.round(s / 3600)} h ago`;
}

function AircraftRow({
  a,
  selected,
  onSelect,
}: {
  a: Aircraft;
  selected: boolean;
  onSelect(hex: string): void;
}) {
  const detail = a.onGround
    ? a.gsKt !== undefined && a.gsKt >= 2
      ? `${Math.round(a.gsKt)} kt`
      : ''
    : [
        a.altMslFt === undefined ? '' : `${Math.round(a.altMslFt / 100) * 100} ft`,
        a.gsKt === undefined ? '' : `${Math.round(a.gsKt)} kt`,
      ]
        .filter(Boolean)
        .join(' · ');
  return (
    <li>
      <button
        type="button"
        className={`aircraft-row phase-edge-${a.phase}${selected ? ' selected' : ''}`}
        aria-pressed={selected}
        onClick={() => onSelect(a.hex)}
      >
        <span className="callsign">{aircraftLabel(a)}</span>
        <span className="type">{a.typeCode ?? ''}</span>
        <span className="detail">{detail}</span>
      </button>
    </li>
  );
}

function Weather({ airport, metar, now }: { airport: AirportDetail; metar: Metar | null; now: number }) {
  if (!metar) return <p className="muted">No METAR available.</p>;
  const ranked = rankRunwaysByWind(airport.runways, metar.windDirDeg, metar.windSpeedKt);
  const best = ranked[0];
  return (
    <>
      <p className="metar-raw mono">{metar.raw}</p>
      <dl className="facts">
        <dt>Wind</dt>
        <dd>{describeWind(metar)}</dd>
        {metar.altimHpa !== null && (
          <>
            <dt>Altimeter</dt>
            <dd>
              {hpaToInHg(metar.altimHpa).toFixed(2)} inHg · {Math.round(metar.altimHpa)} hPa
            </dd>
          </>
        )}
        {metar.tempC !== null && (
          <>
            <dt>Temperature</dt>
            <dd>
              {Math.round(metar.tempC)} °C
              {metar.dewpointC !== null ? `, dew point ${Math.round(metar.dewpointC)} °C` : ''}
            </dd>
          </>
        )}
        {metar.visibility !== null && (
          <>
            <dt>Visibility</dt>
            <dd>{metar.visibility} SM</dd>
          </>
        )}
        {metar.flightCategory && (
          <>
            <dt>Conditions</dt>
            <dd>
              <span className={`category category-${metar.flightCategory}`}>{metar.flightCategory}</span>
            </dd>
          </>
        )}
        <dt>Observed</dt>
        <dd>{age(now, metar.obsTime)}</dd>
      </dl>
      <p className="runway-hint" data-testid="runway-hint">
        {best ? (
          <>
            Wind favours <strong>runway {best.ident}</strong>: {Math.round(best.headwindKt)} kt headwind,{' '}
            {Math.round(best.crosswindKt)} kt crosswind.
            <span className="muted"> A guess from the wind alone; the tower decides.</span>
          </>
        ) : (
          <span className="muted">Wind is calm or variable, so it favours no runway.</span>
        )}
      </p>
    </>
  );
}

function Source({ p, now }: { p: ProviderHealth; now: number }) {
  const detail: string[] = [];
  if (p.state === 'idle') detail.push('not asked yet');
  else detail.push(`answered ${age(now, p.lastSuccessAt)}`);
  if (p.quota)
    detail.push(`${p.quota.remaining}${p.quota.limit ? ` of ${p.quota.limit}` : ''} requests left today`);
  if (p.backoffUntil !== undefined)
    detail.push(`retrying in ${Math.max(0, Math.round((p.backoffUntil - now) / 1000))} s`);
  if (p.lastError) detail.push(p.lastError);
  return (
    <li className="source">
      <span className={`dot dot-${p.state}`} title={p.state} />
      <span className="source-name">{p.label}</span>
      <span className={`state state-${p.state}`}>{p.state}</span>
      <span className="source-detail muted">{detail.join(' · ')}</span>
    </li>
  );
}

/** The right-hand panel: who is out there, the weather, how healthy the data is, and where to look next. */
export function SidePanel({
  airport,
  aircraft,
  status,
  metar,
  now,
  sky,
  onSky,
  feedLabel,
  selected,
  onSelect,
  onClose,
}: Props) {
  const sources = status?.providers.filter((p) => p.enabled) ?? [];
  const byLabel = (a: Aircraft, b: Aircraft) => aircraftLabel(a).localeCompare(aircraftLabel(b));
  const count = countAircraft(aircraft);

  return (
    <aside className="side-panel" data-testid="side-panel" aria-label="Airport information">
      <header>
        <div>
          <h2>{airport.icao}</h2>
          <span className="muted">{airport.name}</span>
        </div>
        <button type="button" className="icon" onClick={onClose} aria-label="Hide panel" title="Hide panel">
          ›
        </button>
      </header>

      <details open>
        <summary>
          Aircraft <span className="count">{count}</span>
        </summary>
        {count === 0 && <p className="muted">No aircraft inside {airport.radiusNm} NM right now.</p>}
        {GROUPS.map((group) => {
          const members = aircraft.filter((a) => group.phases.includes(a.phase)).sort(byLabel);
          if (members.length === 0) return null;
          return (
            <section
              key={group.title}
              className="group"
              data-testid={`group-${group.title.toLowerCase().replace(/\s+/g, '-')}`}
            >
              <h3>
                {group.title} <span className="count">{members.length}</span>
              </h3>
              <ul>
                {members.map((a) => (
                  <AircraftRow key={a.hex} a={a} selected={a.hex === selected} onSelect={onSelect} />
                ))}
              </ul>
            </section>
          );
        })}
      </details>

      <details open>
        <summary>Weather</summary>
        {feedLabel && (
          <p className="muted small">
            The weather is current; the traffic is {feedLabel === 'replay' ? 'a recording' : 'simulated'}.
          </p>
        )}
        <Weather airport={airport} metar={metar} now={now} />
      </details>

      <details open>
        <summary>Daylight</summary>
        <Daylight airport={airport} now={now} sky={sky} onSky={onSky} />
      </details>

      <details open>
        <summary>
          Data sources{' '}
          <span className="count">
            {status ? (status.pollState === 'active' ? (feedLabel ?? 'live') : status.pollState) : '…'}
          </span>
        </summary>
        <ul className="sources">
          {sources.map((p) => (
            <Source key={p.id} p={p} now={now} />
          ))}
        </ul>
        {status?.qnhHpa !== undefined && (
          <p className="muted small">Altitudes corrected with {status.qnhHpa} hPa.</p>
        )}
      </details>

      <details open>
        <summary>Elsewhere</summary>
        <ul className="links">
          <li>
            <a href={airport.links.liveatc} target="_blank" rel="noreferrer noopener">
              LiveATC: listen to {airport.icao}
            </a>
          </li>
          {airport.links.diagram && (
            <li>
              <a href={airport.links.diagram} target="_blank" rel="noreferrer noopener">
                {new URL(airport.links.diagram).hostname.endsWith('faa.gov') ? 'FAA airport' : 'Airport'}{' '}
                diagram
              </a>
            </li>
          )}
          <li>
            <a href={airport.links.flightaware} target="_blank" rel="noreferrer noopener">
              FlightAware: {airport.icao} arrivals and departures
            </a>
          </li>
        </ul>
      </details>
    </aside>
  );
}
