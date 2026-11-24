import {
  type Aircraft,
  type AirportDetail,
  aircraftLabel,
  describeAddrType,
  PHASE_LABELS,
  PHASES,
  type ProviderHealth,
} from '@towercab/shared';
import { useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { useLiveAirport } from '../ws/useLiveAirport';

const phaseOrder = new Map(PHASES.map((p, i) => [p, i]));

function ageSeconds(now: number, then: number | undefined): string {
  if (then === undefined) return '';
  const s = Math.max(0, (now - then) / 1000);
  return s < 10 ? s.toFixed(1) : String(Math.round(s));
}

function altitude(a: Aircraft): string {
  if (a.onGround) return 'ground';
  if (a.altMslFt === undefined) return '';
  return `${a.altMslFt.toLocaleString('en-US')} ft`;
}

function providerDetail(p: ProviderHealth, now: number): string {
  const parts: string[] = [];
  if (p.lastSuccessAt !== undefined) parts.push(`last answer ${ageSeconds(now, p.lastSuccessAt)} s ago`);
  if (p.latencyMs !== undefined) parts.push(`${p.latencyMs} ms`);
  if (p.lastCount !== undefined) parts.push(`${p.lastCount} aircraft`);
  if (p.quota) parts.push(`quota ${p.quota.remaining}${p.quota.limit ? ` of ${p.quota.limit}` : ''}`);
  if (p.backoffUntil !== undefined)
    parts.push(`retry in ${Math.max(0, Math.round((p.backoffUntil - now) / 1000))} s`);
  if (p.lastError) parts.push(p.lastError);
  return parts.join(' · ');
}

/** `/debug/:icao`: everything the server knows about an airport's traffic, as a plain live table. */
export function DebugPage({ icao }: { icao: string }) {
  const live = useLiveAirport(icao);
  const [airport, setAirport] = useState<AirportDetail | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [, setTick] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setAirport(null);
    setLoadError(null);
    api
      .airport(icao, controller.signal)
      .then(setAirport)
      .catch((err: Error) => {
        if (err.name !== 'AbortError') setLoadError(err.message);
      });
    return () => controller.abort();
  }, [icao]);

  // Data ages count up between updates.
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 500);
    return () => clearInterval(timer);
  }, []);

  const now = live.serverNow();
  const rows = [...live.aircraft].sort(
    (a, b) =>
      (phaseOrder.get(a.phase) ?? 99) - (phaseOrder.get(b.phase) ?? 99) ||
      aircraftLabel(a).localeCompare(aircraftLabel(b)),
  );
  const providers = live.status?.providers.filter((p) => p.enabled) ?? [];

  return (
    <main className="debug">
      <header className="debug-header">
        <div>
          <h1>
            {icao} <span className="muted">{airport?.name ?? ''}</span>
          </h1>
          <p className="muted">
            {airport
              ? `Field elevation ${airport.elevationFt} ft · geoid ${airport.geoidUndulationM} m · radius ${airport.radiusNm} NM · ceiling ${airport.ceilingFtAgl} ft AGL · ${airport.runways.length} runways`
              : (loadError ?? 'Loading airport…')}
          </p>
        </div>
        <div className="debug-status">
          <span className={`pill pill-${live.connection}`} data-testid="connection">
            {live.connection}
          </span>
          <span className="pill">polling {live.status?.pollState ?? '…'}</span>
          <span className="pill">{live.status?.viewers ?? 0} viewers</span>
          {live.status?.qnhHpa !== undefined && <span className="pill">QNH {live.status.qnhHpa} hPa</span>}
          <button type="button" className="link" onClick={() => navigate(`/${icao}`)}>
            Open 3D view
          </button>
        </div>
      </header>

      {live.error && <p role="alert">{live.error.message}</p>}

      <section>
        <h2>Data sources</h2>
        <table className="data">
          <thead>
            <tr>
              <th>Source</th>
              <th>State</th>
              <th className="num">Requests</th>
              <th className="num">Failed</th>
              <th className="num">429s</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {providers.map((p) => (
              <tr key={p.id} data-testid={`provider-${p.id}`}>
                <td>{p.label}</td>
                <td>
                  <span className={`state state-${p.state}`}>{p.state}</span>
                </td>
                <td className="num">{p.requests}</td>
                <td className="num">{p.failures}</td>
                <td className="num">{p.rateLimited}</td>
                <td className="muted">{providerDetail(p, now)}</td>
              </tr>
            ))}
            {providers.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  Waiting for the server…
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <section>
        <h2>
          Aircraft <span className="muted">{rows.length}</span>
        </h2>
        <table className="data" data-testid="aircraft-table">
          <thead>
            <tr>
              <th>Hex</th>
              <th>Callsign</th>
              <th>Reg</th>
              <th>Type</th>
              <th>Phase</th>
              <th className="num">Altitude</th>
              <th className="num">AGL</th>
              <th className="num">Speed</th>
              <th className="num">Heading</th>
              <th className="num">V/S</th>
              <th>Squawk</th>
              <th>Link</th>
              <th>Source</th>
              <th className="num">Age</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.hex} data-testid="aircraft-row" className={`phase-${a.phase}`}>
                <td className="mono">{a.hex}</td>
                <td>{a.callsign ?? ''}</td>
                <td>{a.registration ?? ''}</td>
                <td title={a.typeDesc}>{a.typeCode ?? a.category ?? ''}</td>
                <td>
                  <span className={`phase phase-${a.phase}`}>{PHASE_LABELS[a.phase]}</span>
                </td>
                <td className="num" title={`source: ${a.altSource}`}>
                  {altitude(a)}
                </td>
                <td className="num">
                  {a.onGround || a.aglFt === undefined ? '' : a.aglFt.toLocaleString('en-US')}
                </td>
                <td className="num">{a.gsKt === undefined ? '' : `${Math.round(a.gsKt)} kt`}</td>
                <td className="num">
                  {a.headingDeg === undefined
                    ? ''
                    : `${String(Math.round(a.headingDeg) % 360).padStart(3, '0')}°`}
                </td>
                <td className="num">{a.vertRateFpm === undefined ? '' : a.vertRateFpm}</td>
                <td className="mono">{a.squawk ?? ''}</td>
                <td>{describeAddrType(a.addrType)}</td>
                <td>{a.source}</td>
                <td className="num">{ageSeconds(now, a.posTime)} s</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={14} className="muted">
                  {live.connection === 'open' ? 'No aircraft inside the geofence right now.' : 'Connecting…'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>

      <footer className="muted">Not for navigation or operational use.</footer>
    </main>
  );
}
