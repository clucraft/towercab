import { describe, expect, it } from 'vitest';
import {
  baroCorrectionFt,
  ellipsoidToMslM,
  estimateAltitude,
  fieldElevationEllipsoidM,
  groundHeightEllipsoidM,
  mslToEllipsoidM,
  pressureAltToMslFt,
  temperatureCorrectionFt,
} from './altitude';

// EGM96 undulation near Indianapolis. The server computes the real value; this is close enough for the maths.
const N_INDIANA = -33.4;

describe('barometric correction', () => {
  it('is zero at standard pressure', () => {
    expect(baroCorrectionFt(1013.25)).toBeCloseTo(0, 6);
  });

  it('is about 27 ft per hPa near sea level', () => {
    expect(baroCorrectionFt(1014.25)).toBeCloseTo(27.3, 0);
    expect(baroCorrectionFt(1012.25)).toBeCloseTo(-27.3, 0);
  });

  it('matches the inches-of-mercury rule of thumb: 1 inHg is roughly 1,000 ft', () => {
    // 30.92 inHg = 1047.07 hPa, one inch above standard.
    expect(baroCorrectionFt(1047.07)).toBeGreaterThan(900);
    expect(baroCorrectionFt(1047.07)).toBeLessThan(950);
  });

  it('raises the altitude on a high-pressure day and lowers it on a low-pressure day', () => {
    expect(pressureAltToMslFt(1000, 1032.9)).toBeGreaterThan(1500);
    expect(pressureAltToMslFt(1000, 990)).toBeLessThan(400);
  });
});

describe('temperature correction', () => {
  it('is zero in a standard atmosphere and at the station itself', () => {
    // Standard temperature at 797 ft is 15 - 1.98 * 0.797 = 13.4 C.
    expect(temperatureCorrectionFt(5000, 797, 13.42)).toBeCloseTo(0, 0);
    expect(temperatureCorrectionFt(797, 797, -20)).toBeCloseTo(0, 9);
  });

  it('lowers the altitude in cold air by about 4 ft per 1,000 ft per degree', () => {
    // 10 C colder than standard, 4,000 ft above the station: 160 ft lower than indicated.
    expect(temperatureCorrectionFt(4797, 797, 3.42)).toBeCloseTo(-160, 0);
    expect(temperatureCorrectionFt(4797, 797, 23.42)).toBeCloseTo(160, 0);
  });

  it('brings a real cold-day approach into line with its GNSS altitude', () => {
    // FDX3604 at KIND, 2026-11-24: alt_baro 4675, alt_geom 4925, altimeter 1032.9 hPa, 5 C at the field.
    const input = { altGeomFt: null, altBaroFt: 4675, qnhHpa: 1032.9, geoidUndulationM: -33.9 };
    const geomM = 4925 * 0.3048;
    const plain = estimateAltitude(input);
    const corrected = estimateAltitude({ ...input, station: { elevationFt: 797, tempC: 5 } });
    expect(Math.abs((plain.ellipsoidM as number) - geomM)).toBeGreaterThan(45);
    expect(Math.abs((corrected.ellipsoidM as number) - geomM)).toBeLessThan(10);
    expect(corrected.source).toBe('baro-qnh');
  });

  it('is not applied without a METAR altimeter setting or to geometric altitudes', () => {
    const station = { elevationFt: 797, tempC: -10 };
    expect(
      estimateAltitude({ altGeomFt: null, altBaroFt: 4000, qnhHpa: null, geoidUndulationM: 0, station })
        .mslFt,
    ).toBe(4000);
    expect(
      estimateAltitude({ altGeomFt: 4000, altBaroFt: 3700, qnhHpa: 1030, geoidUndulationM: 0, station })
        .ellipsoidM,
    ).toBeCloseTo(1219.2, 1);
  });
});

describe('geoid conversion', () => {
  it('ellipsoid height is MSL plus the undulation, and back', () => {
    expect(mslToEllipsoidM(242.9, N_INDIANA)).toBeCloseTo(209.5, 1);
    expect(ellipsoidToMslM(mslToEllipsoidM(184.7, N_INDIANA), N_INDIANA)).toBeCloseTo(184.7, 9);
  });

  it('puts the KIND field elevation (797 ft) about 33 m lower on the ellipsoid', () => {
    const msl = 797 * 0.3048;
    expect(fieldElevationEllipsoidM(797, N_INDIANA)).toBeCloseTo(msl + N_INDIANA, 6);
    expect(fieldElevationEllipsoidM(797, N_INDIANA)).toBeLessThan(msl);
  });
});

describe('estimateAltitude', () => {
  it('uses alt_geom directly: it is already an ellipsoid height', () => {
    const est = estimateAltitude({
      altGeomFt: 1250,
      altBaroFt: 825,
      qnhHpa: 1032.9,
      geoidUndulationM: N_INDIANA,
    });
    expect(est.source).toBe('geom');
    expect(est.ellipsoidM).toBeCloseTo(381.0, 1);
    // MSL is higher than the ellipsoid height here because the geoid is below the ellipsoid.
    expect(est.mslFt).toBeCloseTo(1250 + 33.4 * 3.28084, 0);
  });

  it('falls back to QNH-corrected pressure altitude plus the geoid offset', () => {
    const est = estimateAltitude({
      altGeomFt: null,
      altBaroFt: 825,
      qnhHpa: 1032.9,
      geoidUndulationM: N_INDIANA,
    });
    expect(est.source).toBe('baro-qnh');
    expect(est.mslFt).toBeCloseTo(825 + baroCorrectionFt(1032.9), 6);
    expect(est.ellipsoidM).toBeCloseTo((est.mslFt as number) * 0.3048 + N_INDIANA, 6);
  });

  /**
   * Real data, captured at KIND on 2026-11-24 (test fixture adsblol-v2-kind.json): FDX3648 on approach reported
   * alt_baro 825 ft and alt_geom 1250 ft while the METAR altimeter was 1032.9 hPa. The two routes through the
   * pipeline have to agree, or aircraft without alt_geom would float or sink relative to those with it.
   */
  it('both routes agree for a real aircraft on approach', () => {
    const geom = estimateAltitude({
      altGeomFt: 1250,
      altBaroFt: 825,
      qnhHpa: 1032.9,
      geoidUndulationM: N_INDIANA,
    });
    const baro = estimateAltitude({
      altGeomFt: null,
      altBaroFt: 825,
      qnhHpa: 1032.9,
      geoidUndulationM: N_INDIANA,
    });
    const differenceM = Math.abs((geom.ellipsoidM as number) - (baro.ellipsoidM as number));
    expect(differenceM).toBeLessThan(12);
  });

  it('without a METAR the pressure altitude is used as it is, and says so', () => {
    const est = estimateAltitude({
      altGeomFt: null,
      altBaroFt: 2000,
      qnhHpa: null,
      geoidUndulationM: N_INDIANA,
    });
    expect(est.source).toBe('baro-std');
    expect(est.mslFt).toBe(2000);
  });

  it('ignores an implausible altimeter setting', () => {
    const est = estimateAltitude({
      altGeomFt: null,
      altBaroFt: 2000,
      qnhHpa: 29.92,
      geoidUndulationM: N_INDIANA,
    });
    expect(est.source).toBe('baro-std');
  });

  it('reports nothing when the aircraft reports nothing', () => {
    expect(estimateAltitude({ altGeomFt: null, altBaroFt: null, qnhHpa: 1013, geoidUndulationM: 0 })).toEqual(
      {
        ellipsoidM: null,
        mslFt: null,
        source: 'none',
      },
    );
    expect(
      estimateAltitude({ altGeomFt: Number.NaN, altBaroFt: undefined, qnhHpa: 1013, geoidUndulationM: 0 })
        .source,
    ).toBe('none');
  });
});

describe('ground height', () => {
  it('prefers the sampled terrain height', () => {
    expect(groundHeightEllipsoidM(151.2, 606, N_INDIANA)).toBe(151.2);
  });

  it('falls back to field elevation through the geoid when sampling is not possible', () => {
    const expected = 606 * 0.3048 + N_INDIANA;
    expect(groundHeightEllipsoidM(null, 606, N_INDIANA)).toBeCloseTo(expected, 6);
    expect(groundHeightEllipsoidM(undefined, 606, N_INDIANA)).toBeCloseTo(expected, 6);
    expect(groundHeightEllipsoidM(Number.NaN, 606, N_INDIANA)).toBeCloseTo(expected, 6);
  });
});
