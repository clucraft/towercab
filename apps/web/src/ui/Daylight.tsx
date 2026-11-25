import {
  type AirportDetail,
  type DayPhase,
  dayPhase,
  localDay,
  localTime,
  sunPosition,
  sunTimes,
  zoneAbbreviation,
} from '@towercab/shared';
import { useMemo } from 'react';
import type { SkySetting } from '../scene/sky';

interface Props {
  airport: AirportDetail;
  /** The server's clock. */
  now: number;
  sky: SkySetting;
  onSky(sky: SkySetting): void;
}

const PHASES: Record<DayPhase, string> = {
  day: 'Day',
  civil: 'Civil twilight',
  nautical: 'Nautical twilight',
  astronomical: 'Astronomical twilight',
  night: 'Night',
};

const MINUTE_MS = 60_000;

/** `in 2 h 5 min`, or nothing for what is over. */
export function until(now: number, then: number): string {
  const minutes = Math.round((then - now) / MINUTE_MS);
  if (minutes <= 0) return '';
  if (minutes < 60) return `in ${minutes} min`;
  return `in ${Math.floor(minutes / 60)} h ${minutes % 60} min`;
}

/** What time it is at the airport, when the sun rises and sets there, and whether the sky goes along. */
export function Daylight({ airport, now, sky, onSky }: Props) {
  const fixed = typeof sky === 'number';
  const { lat, lon, timezone } = airport;
  // To the minute is enough, and saves working it out twice a second.
  const time = Math.floor((fixed ? sky : now) / MINUTE_MS) * MINUTE_MS;
  const { sunrise, sunset, always, phase } = useMemo(() => {
    const { start, end } = localDay(time, timezone);
    return {
      ...sunTimes(lat, lon, start, end),
      phase: dayPhase(sunPosition(lat, lon, time).elevationDeg),
    };
  }, [lat, lon, timezone, time]);

  const event = (label: string, exact: number | null) => {
    if (exact === null) return null;
    // To the nearest minute, as in an almanac.
    const at = Math.round(exact / MINUTE_MS) * MINUTE_MS;
    return (
      <>
        <dt>{label}</dt>
        <dd>
          {localTime(at, timezone)} <span className="muted">{until(time, at)}</span>
        </dd>
      </>
    );
  };

  return (
    <div data-testid="daylight">
      <dl className="facts">
        <dt>Local time</dt>
        <dd title={timezone}>
          {localTime(time, timezone)} {zoneAbbreviation(time, timezone)}
        </dd>
        {event('Sunrise', sunrise)}
        {event('Sunset', sunset)}
        <dt>Now</dt>
        <dd>{PHASES[phase]}</dd>
      </dl>
      {always !== null && (
        <p className="muted small">The sun does not {always === 'up' ? 'set' : 'rise'} today.</p>
      )}
      <label className="check">
        <input
          type="checkbox"
          checked={sky !== 'day'}
          onChange={(e) => onSky(e.target.checked ? 'real' : 'day')}
          data-testid="sky-toggle"
        />
        Sky follows the sun
      </label>
      {fixed && (
        <p className="muted small">
          The sky and these times are those of{' '}
          {new Date(sky).toLocaleDateString('en-US', {
            timeZone: timezone,
            day: 'numeric',
            month: 'long',
            year: 'numeric',
          })}
          , as set in the address.{' '}
          <button type="button" className="link" onClick={() => onSky('real')}>
            Back to now
          </button>
        </p>
      )}
    </div>
  );
}
