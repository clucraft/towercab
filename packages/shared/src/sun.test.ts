import { describe, expect, it } from 'vitest';
import {
  dayPhase,
  isTimeZone,
  localDay,
  localTime,
  refractionDeg,
  SUNRISE_ELEVATION_DEG,
  sunPosition,
  sunTimes,
  zoneAbbreviation,
} from './sun';

const KLAF = { lat: 40.4123, lon: -86.9369, zone: 'America/Indiana/Indianapolis' };
const EGLL = { lat: 51.4706, lon: -0.4619, zone: 'Europe/London' };
const YSSY = { lat: -33.9461, lon: 151.1772, zone: 'Australia/Sydney' };
const SEQM = { lat: -0.1292, lon: -78.3575, zone: 'America/Guayaquil' };
const PABR = { lat: 71.2854, lon: -156.766, zone: 'America/Anchorage' };
const RJTT = { lat: 35.5533, lon: 139.7811, zone: 'Asia/Tokyo' };

const at = (iso: string) => Date.parse(iso);

describe('sunPosition', () => {
  // JPL Horizons, airless azimuth and elevation, asked on 2026-11-25.
  it.each([
    ['KLAF', KLAF, '2026-11-25T15:00:00Z', 141.8436, 18.9645],
    ['KLAF', KLAF, '2026-11-25T21:30:00Z', 233.7848, 7.9082],
    ['KLAF', KLAF, '2026-06-21T12:00:00Z', 73.2541, 16.8349],
    ['KLAF at night', KLAF, '2026-11-26T03:00:00Z', 288.9405, -51.8433],
    ['Sydney, where the sun is in the north', YSSY, '2026-12-21T02:00:00Z', 351.4435, 79.3823],
    ['Tokyo', RJTT, '2026-01-05T03:00:00Z', 183.7725, 31.7319],
    ['London', EGLL, '2026-11-25T09:00:00Z', 140.5376, 8.8564],
    ['Utqiagvik in the polar night', PABR, '2026-12-21T22:00:00Z', 174.1692, -4.8286],
    ['Utqiagvik, midnight sun', PABR, '2026-06-21T10:00:00Z', 353.3582, 4.855],
    ['Quito, nearly overhead', SEQM, '2026-09-23T17:00:00Z', 95.7828, 88.5602],
  ])('%s', (_name, place, iso, azimuth, elevation) => {
    const sun = sunPosition(place.lat, place.lon, at(iso));
    expect(Math.abs(sun.elevationDeg - elevation)).toBeLessThan(0.02);
    // An azimuth means less the nearer the sun is to the zenith.
    const tolerance = 0.02 / Math.cos((elevation * Math.PI) / 180);
    expect(Math.abs(sun.azimuthDeg - azimuth)).toBeLessThan(tolerance);
  });
});

describe('sunTimes', () => {
  /** Within half a minute, which is more than almanacs give. */
  const expectAt = (actual: number | null, iso: string) => {
    expect(actual).not.toBeNull();
    expect(
      Math.abs((actual as number) - at(iso)),
      `${new Date(actual as number).toISOString()}`,
    ).toBeLessThan(30_000);
  };
  const on = (place: typeof KLAF, iso: string) => {
    const day = localDay(at(iso), place.zone);
    return sunTimes(place.lat, place.lon, day.start, day.end);
  };

  // From JPL Horizons: when the middle of the sun is 0.833 degrees below the horizon.
  it('gives the sunrise and sunset of the local day', () => {
    const autumn = on(KLAF, '2026-11-25T18:00:00Z');
    expectAt(autumn.sunrise, '2026-11-25T12:45:19Z');
    expectAt(autumn.sunset, '2026-11-25T22:23:57Z');
    expect(autumn.always).toBeNull();

    const london = on(EGLL, '2026-11-25T12:00:00Z');
    expectAt(london.sunrise, '2026-11-25T07:36:04Z');
    expectAt(london.sunset, '2026-11-25T16:01:08Z');

    expectAt(on(SEQM, '2026-09-23T17:00:00Z').sunrise, '2026-09-23T11:02:30Z');
  });

  it('belongs to the airport’s day, not to the day in UTC or where the viewer is', () => {
    // In Indiana the sun sets on 21 June at 01:21 UTC on the 22nd.
    const summer = on(KLAF, '2026-06-21T18:00:00Z');
    expectAt(summer.sunrise, '2026-06-21T10:17:46Z');
    expectAt(summer.sunset, '2026-06-22T01:21:28Z');
    // In Sydney it rose on the 21st while it was still the 20th in UTC.
    const sydney = on(YSSY, '2026-12-21T02:00:00Z');
    expectAt(sydney.sunrise, '2026-12-20T18:40:34Z');
    expectAt(sydney.sunset, '2026-12-21T09:05:44Z');
    // And in Tokyo on the 5th, with the 4th in UTC.
    expectAt(on(RJTT, '2026-01-05T03:00:00Z').sunrise, '2026-01-04T21:50:46Z');
  });

  it('says so when the sun does not set or does not rise', () => {
    expect(on(PABR, '2026-06-21T20:00:00Z')).toEqual({ sunrise: null, sunset: null, always: 'up' });
    expect(on(PABR, '2026-12-21T20:00:00Z')).toEqual({ sunrise: null, sunset: null, always: 'down' });
  });
});

describe('refractionDeg', () => {
  it('lifts the sun by half a degree at the horizon and hardly at all higher up', () => {
    expect(refractionDeg(0)).toBeGreaterThan(0.45);
    expect(refractionDeg(0)).toBeLessThan(0.52);
    expect(refractionDeg(45)).toBeLessThan(0.02);
    expect(Math.abs(refractionDeg(90))).toBeLessThan(0.01);
    expect(refractionDeg(-10)).toBe(0);
  });

  it('puts the upper edge of the sun on the horizon at sunrise and sunset', () => {
    const middle = SUNRISE_ELEVATION_DEG + refractionDeg(SUNRISE_ELEVATION_DEG);
    const upperEdge = middle + 0.267;
    expect(Math.abs(upperEdge)).toBeLessThan(0.1);
  });
});

describe('dayPhase', () => {
  it('divides the day the way almanacs do', () => {
    expect([30, 0, -0.8, -0.9, -5.9, -6.1, -11.9, -12.1, -17.9, -18.1].map(dayPhase)).toEqual([
      'day',
      'day',
      'day',
      'civil',
      'civil',
      'nautical',
      'nautical',
      'astronomical',
      'astronomical',
      'night',
    ]);
  });
});

describe('local time', () => {
  it('knows when a day begins and ends in a time zone', () => {
    const day = localDay(at('2026-11-25T03:00:00Z'), KLAF.zone);
    // Still the evening of the 24th there.
    expect(new Date(day.start).toISOString()).toBe('2026-11-24T05:00:00.000Z');
    expect(new Date(day.end).toISOString()).toBe('2026-11-25T05:00:00.000Z');
    expect(localDay(at('2026-12-21T02:00:00Z'), YSSY.zone)).toEqual({
      start: at('2026-12-20T13:00:00Z'),
      end: at('2026-12-21T13:00:00Z'),
    });
  });

  it('copes with the days on which the clocks change', () => {
    const hours = (iso: string, zone: string) => {
      const day = localDay(at(iso), zone);
      return (day.end - day.start) / 3_600_000;
    };
    expect(hours('2026-03-08T18:00:00Z', KLAF.zone)).toBe(23);
    expect(hours('2026-11-01T18:00:00Z', KLAF.zone)).toBe(25);
    expect(hours('2026-11-25T18:00:00Z', KLAF.zone)).toBe(24);
    expect(hours('2026-10-04T02:00:00Z', YSSY.zone)).toBe(23);
  });

  it('shows times the way the clock at the airport does', () => {
    expect(localTime(at('2026-11-25T22:23:57Z'), KLAF.zone)).toBe('17:23');
    expect(localTime(at('2026-11-25T05:05:00Z'), KLAF.zone)).toBe('00:05');
    expect(zoneAbbreviation(at('2026-11-25T12:00:00Z'), KLAF.zone)).toBe('EST');
    expect(zoneAbbreviation(at('2026-06-21T12:00:00Z'), KLAF.zone)).toBe('EDT');
  });

  it('tells a time zone from something else', () => {
    expect(isTimeZone('America/Indiana/Indianapolis')).toBe(true);
    expect(isTimeZone('UTC')).toBe(true);
    expect(isTimeZone('Indiana')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });
});
