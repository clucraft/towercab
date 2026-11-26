import { destinationPoint, type Phase } from '@towercab/shared';
import { describe, expect, it } from 'vitest';
import { parseReadsbResponse } from '../src/providers/readsb';
import { geoidUndulationM } from '../src/reference/geoid';
import { parseMetar } from '../src/reference/metar';
import {
  classifyPhase,
  finalApproachTo,
  isOnGround,
  newPhaseMemory,
  type PhaseInput,
  resolveHeading,
  runwayAt,
} from '../src/tracking/classify';
import { AirportTracker, findShadows, type TrackerContext } from '../src/tracking/tracker';
import { fixtureJson, KLAF, KLAF_RUNWAYS, obs } from './helpers';

const RWY10 = KLAF_RUNWAYS[1]?.ends[0] as { lat: number; lon: number };
const RWY28 = KLAF_RUNWAYS[1]?.ends[1] as { lat: number; lon: number };
const MID_10_28 = { lat: (RWY10.lat + RWY28.lat) / 2, lon: (RWY10.lon + RWY28.lon) / 2 };
/** A spot on the ramp, well clear of both runways. */
const RAMP = { lat: 40.4165, lon: -86.9365 };

describe('isOnGround', () => {
  const base = { fieldElevationFt: 606, overRunway: false };

  it('trusts alt_baro === "ground", which is a string and not a number', () => {
    expect(isOnGround({ ...base, altBaro: 'ground', altMslFt: null, gsKt: 140 })).toBe(true);
  });

  it('treats a slow aircraft near field elevation as on the ground (light aircraft never send "ground")', () => {
    expect(isOnGround({ ...base, altBaro: 600, altMslFt: 615, gsKt: 12 })).toBe(true);
    expect(isOnGround({ ...base, altBaro: 600, altMslFt: 740, gsKt: 0 })).toBe(true);
    expect(isOnGround({ ...base, altBaro: 600, altMslFt: 470, gsKt: 5 })).toBe(true);
  });

  it('does not ground an aircraft that is slow but high, or low but fast', () => {
    expect(isOnGround({ ...base, altBaro: 900, altMslFt: 900, gsKt: 30 })).toBe(false);
    expect(isOnGround({ ...base, altBaro: 650, altMslFt: 650, gsKt: 70 })).toBe(false);
  });

  it('puts a fast aircraft on the surface when it is over a runway within 50 ft of field elevation', () => {
    expect(
      isOnGround({ fieldElevationFt: 606, overRunway: true, altBaro: 625, altMslFt: 640, gsKt: 65 }),
    ).toBe(true);
    expect(
      isOnGround({ fieldElevationFt: 606, overRunway: true, altBaro: 700, altMslFt: 700, gsKt: 65 }),
    ).toBe(false);
  });

  it('with no altitude at all, goes by speed alone', () => {
    expect(isOnGround({ ...base, altBaro: null, altMslFt: null, gsKt: 8 })).toBe(true);
    expect(isOnGround({ ...base, altBaro: null, altMslFt: null, gsKt: 120 })).toBe(false);
    expect(isOnGround({ ...base, altBaro: null, altMslFt: null, gsKt: null })).toBe(false);
  });
});

describe('runway geometry', () => {
  it('finds the runway under a point and nothing under the ramp', () => {
    expect(runwayAt(MID_10_28.lat, MID_10_28.lon, KLAF_RUNWAYS)?.id).toBe('10/28');
    expect(runwayAt(RAMP.lat, RAMP.lon, KLAF_RUNWAYS)).toBeNull();
    // 60 m off the centreline of a 150 ft wide runway is on the grass.
    const grass = destinationPoint(MID_10_28.lat, MID_10_28.lon, 10, 60);
    expect(runwayAt(grass.lat, grass.lon, KLAF_RUNWAYS)).toBeNull();
  });

  it('recognises a final approach by position and track', () => {
    const threeMileFinal = destinationPoint(RWY10.lat, RWY10.lon, 280, 3 * 1852);
    expect(finalApproachTo(threeMileFinal.lat, threeMileFinal.lon, 100, KLAF_RUNWAYS)).toBe('10');
    // Same place, flying the other way: that is a departure off runway 28, not an approach.
    expect(finalApproachTo(threeMileFinal.lat, threeMileFinal.lon, 280, KLAF_RUNWAYS)).toBeNull();
    // Abeam the field on downwind.
    const downwind = destinationPoint(MID_10_28.lat, MID_10_28.lon, 10, 1852);
    expect(finalApproachTo(downwind.lat, downwind.lon, 280, KLAF_RUNWAYS)).toBeNull();
    expect(finalApproachTo(threeMileFinal.lat, threeMileFinal.lon, null, KLAF_RUNWAYS)).toBeNull();
  });
});

describe('classifyPhase', () => {
  const at = (p: { lat: number; lon: number }, rest: Partial<PhaseInput>): PhaseInput => ({
    onGround: true,
    lat: p.lat,
    lon: p.lon,
    gsKt: 0,
    trackDeg: null,
    vertRateFpm: null,
    aglFt: 0,
    distNm: 0.3,
    runways: KLAF_RUNWAYS,
    time: 0,
    ...rest,
  });

  it('follows a departure: parked, taxi, line up, take-off roll, climb out', () => {
    const memory = newPhaseMemory();
    const seen: Phase[] = [];
    const step = (input: PhaseInput) => seen.push(classifyPhase(input, memory));

    step(at(RAMP, { gsKt: 0, time: 0 }));
    step(at(RAMP, { gsKt: 9, trackDeg: 200, time: 10_000 }));
    step(at(RWY10, { gsKt: 0, time: 60_000 })); // lined up and waiting
    step(at(RWY10, { gsKt: 22, trackDeg: 100, time: 64_000 }));
    step(at(MID_10_28, { gsKt: 58, trackDeg: 100, time: 72_000 }));
    const climb = destinationPoint(RWY28.lat, RWY28.lon, 100, 900);
    step(
      at(climb, {
        onGround: false,
        gsKt: 78,
        trackDeg: 100,
        vertRateFpm: 700,
        aglFt: 350,
        distNm: 1.2,
        time: 90_000,
      }),
    );
    expect(seen).toEqual(['parked', 'taxiing', 'taxiing', 'taxiing', 'takeoff_roll', 'departing']);
  });

  it('follows an arrival: final, landing roll, taxi in, parked after standing a while', () => {
    const memory = newPhaseMemory();
    const seen: Phase[] = [];
    const step = (input: PhaseInput) => seen.push(classifyPhase(input, memory));

    const final = destinationPoint(RWY10.lat, RWY10.lon, 280, 2 * 1852);
    step(
      at(final, {
        onGround: false,
        gsKt: 70,
        trackDeg: 100,
        vertRateFpm: -500,
        aglFt: 650,
        distNm: 2.6,
        time: 0,
      }),
    );
    step(at(MID_10_28, { gsKt: 52, trackDeg: 100, time: 60_000 }));
    step(at(MID_10_28, { gsKt: 24, trackDeg: 100, time: 66_000 })); // still slowing on the runway
    step(at(RAMP, { gsKt: 11, trackDeg: 20, time: 120_000 }));
    step(at(RAMP, { gsKt: 0, time: 150_000 })); // just stopped: could be holding
    step(at(RAMP, { gsKt: 0, time: 200_000 })); // 50 s later: parked
    expect(seen).toEqual(['arriving', 'landing_roll', 'landing_roll', 'taxiing', 'taxiing', 'parked']);
  });

  it('recognises a touch-and-go and the pattern that follows', () => {
    const memory = newPhaseMemory();
    const final = destinationPoint(RWY10.lat, RWY10.lon, 280, 1852);
    expect(
      classifyPhase(
        at(final, { onGround: false, gsKt: 65, trackDeg: 100, vertRateFpm: -450, aglFt: 320, distNm: 1.5 }),
        memory,
      ),
    ).toBe('arriving');
    expect(classifyPhase(at(MID_10_28, { gsKt: 48, trackDeg: 100, time: 30_000 }), memory)).toBe(
      'landing_roll',
    );
    expect(classifyPhase(at(MID_10_28, { gsKt: 60, trackDeg: 100, time: 34_000 }), memory)).toBe(
      'takeoff_roll',
    );
    const upwind = destinationPoint(RWY28.lat, RWY28.lon, 100, 700);
    expect(
      classifyPhase(
        at(upwind, {
          onGround: false,
          gsKt: 72,
          trackDeg: 100,
          vertRateFpm: 600,
          aglFt: 400,
          distNm: 1.1,
          time: 50_000,
        }),
        memory,
      ),
    ).toBe('departing');
    // Turned downwind, level at pattern altitude, a mile north of the runway.
    const downwind = destinationPoint(MID_10_28.lat, MID_10_28.lon, 10, 1852);
    expect(
      classifyPhase(
        at(downwind, {
          onGround: false,
          gsKt: 90,
          trackDeg: 280,
          vertRateFpm: 0,
          aglFt: 1000,
          distNm: 1.0,
          time: 110_000,
        }),
        memory,
      ),
    ).toBe('pattern');
  });

  it('labels a first-seen aircraft from what it is doing', () => {
    const far = destinationPoint(KLAF.lat, KLAF.lon, 0, 5 * 1852);
    const airborne = (rest: Partial<PhaseInput>) =>
      at(far, { onGround: false, gsKt: 120, trackDeg: 90, aglFt: 3000, distNm: 5, ...rest });
    expect(classifyPhase(airborne({ vertRateFpm: 900 }), newPhaseMemory())).toBe('departing');
    expect(classifyPhase(airborne({ vertRateFpm: -700 }), newPhaseMemory())).toBe('arriving');
    expect(classifyPhase(airborne({ vertRateFpm: 0 }), newPhaseMemory())).toBe('transit');
    const close = destinationPoint(KLAF.lat, KLAF.lon, 0, 2 * 1852);
    expect(
      classifyPhase(
        at(close, { onGround: false, gsKt: 95, trackDeg: 270, vertRateFpm: 0, aglFt: 1000, distNm: 2 }),
        newPhaseMemory(),
      ),
    ).toBe('pattern');
  });

  it('never calls 40 kt or more on the ground taxiing, even off the mapped runway', () => {
    // Seen live at KLAF: a PA44 reporting "ground" at 81 kt.
    expect(classifyPhase(at(RAMP, { gsKt: 81 }), newPhaseMemory())).toBe('takeoff_roll');
    const landing = newPhaseMemory();
    landing.phase = 'arriving';
    expect(classifyPhase(at(RAMP, { gsKt: 81 }), landing)).toBe('landing_roll');
    // Below 40 kt and off the runway it is an ordinary (fast) taxi.
    expect(classifyPhase(at(RAMP, { gsKt: 35, trackDeg: 90 }), newPhaseMemory())).toBe('taxiing');
  });

  it('does not call an aircraft stopped on a runway parked', () => {
    const memory = newPhaseMemory();
    expect(classifyPhase(at(MID_10_28, { gsKt: 0, time: 0 }), memory)).toBe('taxiing');
    expect(classifyPhase(at(MID_10_28, { gsKt: 0, time: 120_000 }), memory)).toBe('taxiing');
  });
});

describe('resolveHeading', () => {
  it('prefers true heading, then track', () => {
    expect(resolveHeading(null, 11.25, 200, 8)).toBe(11.25);
    expect(resolveHeading(null, null, 200, 8)).toBe(200);
  });

  it('freezes the heading below 2 kt, because track is noise when standing still', () => {
    expect(resolveHeading(135, null, 310, 0.4)).toBe(135);
    expect(resolveHeading(135, null, 310, 1.9)).toBe(135);
    expect(resolveHeading(135, null, 310, 2.5)).toBe(310);
    // Nothing better to go on for an aircraft first seen standing still.
    expect(resolveHeading(null, null, 310, 0)).toBe(310);
    expect(resolveHeading(135, null, null, 30)).toBe(135);
  });
});

describe('AirportTracker', () => {
  const T0 = 1_000_000;
  const context = (overrides: Partial<TrackerContext> = {}): TrackerContext => ({
    lat: KLAF.lat,
    lon: KLAF.lon,
    elevationFt: KLAF.elevationFt,
    geoidUndulationM: -33.5,
    radiusNm: 6,
    ceilingFtAgl: 5000,
    runways: KLAF_RUNWAYS,
    qnhHpa: 1013.25,
    ...overrides,
  });
  const tracker = (overrides: Partial<TrackerContext> = {}) => new AirportTracker(() => context(overrides));

  it('reports a new aircraft once, and nothing when nothing changed', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0 })], 1, T0);
    expect(t.commit(T0).upserts.map((a) => a.hex)).toEqual(['a00001']);
    expect(t.commit(T0 + 1000)).toEqual({ upserts: [], removed: [] });
    t.ingest([obs({ hex: 'a00001', posTime: T0 })], 1, T0 + 2000);
    expect(t.commit(T0 + 2000).upserts).toEqual([]);
  });

  it('keeps the freshest position: fetch time minus seen_pos decides, not arrival order', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0, lat: 40.41, source: 'adsbfi' })], 1, T0);
    // A second source answers later but its position is older.
    t.ingest([obs({ hex: 'a00001', posTime: T0 - 3000, lat: 40.4, source: 'adsblol' })], 2, T0 + 500);
    const [a] = t.commit(T0 + 500).upserts;
    expect(a).toMatchObject({ lat: 40.41, source: 'adsbfi', posTime: T0 });
  });

  it('prefers the local receiver when two positions are equally fresh', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0, lat: 40.41, source: 'adsbfi' })], 1, T0);
    t.ingest([obs({ hex: 'a00001', posTime: T0 - 100, lat: 40.4101, source: 'readsb' })], 0, T0);
    expect(t.commit(T0).upserts[0]).toMatchObject({ source: 'readsb', lat: 40.4101 });

    // And a public source does not displace the receiver on a tie.
    t.ingest([obs({ hex: 'a00001', posTime: T0 + 2000, lat: 40.42, source: 'readsb' })], 0, T0 + 2000);
    t.ingest([obs({ hex: 'a00001', posTime: T0 + 2100, lat: 40.4201, source: 'adsbfi' })], 1, T0 + 2000);
    expect(t.commit(T0 + 2000).upserts[0]).toMatchObject({ source: 'readsb', lat: 40.42 });
  });

  it('never accepts a position older than the one already sent to clients', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0, lat: 40.41, source: 'adsbfi' })], 1, T0);
    expect(t.commit(T0).upserts[0]?.posTime).toBe(T0);

    // Even the highest-priority source may not move the aircraft back in time.
    t.ingest([obs({ hex: 'a00001', posTime: T0 - 200, lat: 40.3, source: 'readsb' })], 0, T0 + 1000);
    t.ingest([obs({ hex: 'a00001', posTime: T0, lat: 40.3, source: 'readsb' })], 0, T0 + 1000);
    expect(t.commit(T0 + 1000).upserts).toEqual([]);

    // Position times seen by clients only ever increase, whatever order sources answer in.
    const sent: number[] = [T0];
    const feed = [T0 + 2000, T0 + 1500, T0 + 4000, T0 + 3900, T0 + 4000, T0 + 6000];
    feed.forEach((posTime, i) => {
      t.ingest(
        [obs({ hex: 'a00001', posTime, source: i % 2 ? 'adsblol' : 'adsbfi' })],
        i % 2 ? 2 : 1,
        T0 + 7000 + i,
      );
      for (const a of t.commit(T0 + 7000 + i).upserts) sent.push(a.posTime);
    });
    expect(sent).toEqual([...sent].sort((a, b) => a - b));
    expect(new Set(sent).size).toBe(sent.length);
    expect(sent[sent.length - 1]).toBe(T0 + 6000);
  });

  it('does not let a radar-derived TIS-B report displace a fresh ADS-B position for the same address', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0, lat: 40.41, addrType: 'adsb_icao' })], 1, T0);
    t.commit(T0);
    t.ingest([obs({ hex: 'a00001', posTime: T0 + 3000, lat: 40.45, addrType: 'tisb_icao' })], 1, T0 + 3000);
    expect(t.commit(T0 + 3000).upserts).toEqual([]);
    // Once ADS-B has been silent for a while, TIS-B is better than nothing.
    t.ingest(
      [obs({ hex: 'a00001', posTime: T0 + 12_000, lat: 40.45, addrType: 'tisb_icao' })],
      1,
      T0 + 12_000,
    );
    expect(t.commit(T0 + 12_000).upserts[0]).toMatchObject({ addrType: 'tisb_icao', lat: 40.45 });
  });

  it('keeps an aircraft for 30 s after it was last heard, then removes it', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0 })], 1, T0);
    t.commit(T0);
    expect(t.commit(T0 + 29_000).removed).toEqual([]);
    expect(t.size).toBe(1);
    expect(t.commit(T0 + 31_000).removed).toEqual(['a00001']);
    expect(t.size).toBe(0);
  });

  it('keeps a parked aircraft for as long as a source still lists it, however old its position', () => {
    const t = tracker();
    const parked = obs({
      hex: 'a00002',
      altBaro: 'ground',
      gsKt: 0,
      lat: 40.4165,
      lon: -86.9365,
      posTime: T0,
    });
    t.ingest([parked], 1, T0);
    t.commit(T0);
    // Surface positions arrive rarely with weak reception; the aircraft has not gone anywhere.
    t.ingest([parked], 1, T0 + 45_000);
    expect(t.commit(T0 + 50_000).removed).toEqual([]);
    expect(t.size).toBe(1);
    expect(t.commit(T0 + 80_000).removed).toEqual(['a00002']);
  });

  it('stops showing a moving aircraft once its position is 30 s old, even if a source still lists it', () => {
    const t = tracker();
    const flying = obs({ hex: 'a00003', altBaro: 1500, gsKt: 95, posTime: T0 });
    t.ingest([flying], 1, T0);
    t.commit(T0);
    // The aggregator keeps returning the same old position for up to a minute.
    t.ingest([flying], 1, T0 + 28_000);
    expect(t.commit(T0 + 28_000).removed).toEqual([]);
    t.ingest([flying], 1, T0 + 32_000);
    expect(t.commit(T0 + 32_000).removed).toEqual(['a00003']);
    // It is not re-added while the position stays stale...
    t.ingest([flying], 1, T0 + 40_000);
    expect(t.commit(T0 + 40_000)).toEqual({ upserts: [], removed: [] });
    // ...and comes back as soon as there is a fresh one.
    t.ingest([obs({ hex: 'a00003', altBaro: 1600, gsKt: 95, posTime: T0 + 44_000 })], 1, T0 + 45_000);
    expect(t.commit(T0 + 45_000).upserts.map((a) => a.hex)).toEqual(['a00003']);
  });

  it('keeps a taxiing aircraft for a minute after its last position while a source still lists it', () => {
    const t = tracker();
    const taxiing = obs({
      hex: 'a00005',
      altBaro: 'ground',
      gsKt: 14,
      lat: 40.4165,
      lon: -86.9365,
      posTime: T0,
    });
    t.ingest([taxiing], 1, T0);
    expect(t.commit(T0).upserts.map((a) => a.hex)).toEqual(['a00005']);
    // Receivers often miss aircraft on the taxiways for half a minute and more.
    for (const at of [20_000, 40_000, 58_000]) {
      t.ingest([taxiing], 1, T0 + at);
      expect(t.commit(T0 + at).removed).toEqual([]);
    }
    t.ingest([taxiing], 1, T0 + 62_000);
    expect(t.commit(T0 + 62_000).removed).toEqual(['a00005']);
  });

  it('drops an aircraft lost on its take-off roll 30 s after its last position, like one in the air', () => {
    const t = tracker();
    const rolling = obs({
      hex: 'a00006',
      altBaro: 'ground',
      gsKt: 110,
      lat: 40.4165,
      lon: -86.9365,
      posTime: T0,
    });
    t.ingest([rolling], 1, T0);
    t.commit(T0);
    t.ingest([rolling], 1, T0 + 28_000);
    expect(t.commit(T0 + 28_000).removed).toEqual([]);
    t.ingest([rolling], 1, T0 + 32_000);
    expect(t.commit(T0 + 32_000).removed).toEqual(['a00006']);
  });

  it('works out the heading from movement when a rolling aircraft sends neither heading nor track', () => {
    const t = tracker();
    const start = { lat: 40.4165, lon: -86.9365 };
    const next = destinationPoint(start.lat, start.lon, 135, 40);
    const rolling = {
      hex: 'a00004',
      altBaro: 'ground' as const,
      gsKt: 14,
      trackDeg: null,
      trueHeadingDeg: null,
    };
    t.ingest([obs({ ...rolling, ...start, posTime: T0 })], 1, T0);
    const first = t.commit(T0).upserts[0];
    expect(first?.headingDeg).toBeUndefined();
    t.ingest([obs({ ...rolling, ...next, posTime: T0 + 5000 })], 1, T0 + 5000);
    const second = t.commit(T0 + 5000).upserts[0];
    expect(second?.headingDeg).toBeCloseTo(135, 0);
    expect(second?.trackDeg).toBeCloseTo(135, 0);
    // Too small a move says nothing about direction: the heading stays where it was.
    const nudge = destinationPoint(next.lat, next.lon, 0, 2);
    t.ingest([obs({ ...rolling, ...nudge, gsKt: 1, posTime: T0 + 10_000 })], 1, T0 + 10_000);
    expect(t.commit(T0 + 10_000).upserts[0]?.headingDeg).toBeCloseTo(135, 0);
  });

  it('merges identity details across sources', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0, callsign: 'PDU67' })], 1, T0);
    // The other source has an older position but knows the operator and type.
    t.ingest(
      [
        obs({
          hex: 'a00001',
          posTime: T0 - 1000,
          registration: 'N867PU',
          typeCode: 'P28A',
          operator: 'PURDUE UNIVERSITY',
        }),
      ],
      2,
      T0,
    );
    expect(t.commit(T0).upserts[0]).toMatchObject({
      callsign: 'PDU67',
      registration: 'N867PU',
      typeCode: 'P28A',
      operator: 'PURDUE UNIVERSITY',
    });
    // A newer position from a source without the details keeps them.
    t.ingest([obs({ hex: 'a00001', posTime: T0 + 2000 })], 1, T0 + 2000);
    expect(t.commit(T0 + 2000).upserts[0]).toMatchObject({
      registration: 'N867PU',
      operator: 'PURDUE UNIVERSITY',
    });
  });

  describe('geofence', () => {
    it('drops aircraft outside the radius', () => {
      const t = tracker({ radiusNm: 6 });
      const inside = destinationPoint(KLAF.lat, KLAF.lon, 90, 5.5 * 1852);
      const outside = destinationPoint(KLAF.lat, KLAF.lon, 90, 6.5 * 1852);
      t.ingest(
        [obs({ hex: 'a00001', ...inside, posTime: T0 }), obs({ hex: 'a00002', ...outside, posTime: T0 })],
        1,
        T0,
      );
      expect(t.commit(T0).upserts.map((a) => a.hex)).toEqual(['a00001']);
    });

    it('hides traffic above the ceiling: pattern and approach traffic, not airliners at FL350', () => {
      const t = tracker({ ceilingFtAgl: 5000 });
      t.ingest(
        [
          obs({ hex: 'a00001', altBaro: 1600, posTime: T0 }),
          obs({ hex: 'a00002', altBaro: 35_000, posTime: T0 }),
          obs({ hex: 'a00003', altBaro: 5500, posTime: T0 }), // 4,894 ft above a 606 ft field
          obs({ hex: 'a00004', altBaro: 5700, posTime: T0 }), // 5,094 ft above the field
        ],
        1,
        T0,
      );
      expect(
        t
          .commit(T0)
          .upserts.map((a) => a.hex)
          .sort(),
      ).toEqual(['a00001', 'a00003']);
    });

    it('removes an aircraft that climbs out through the ceiling, with a little hysteresis', () => {
      const t = tracker({ ceilingFtAgl: 5000 });
      t.ingest([obs({ hex: 'a00001', altBaro: 5500, posTime: T0 })], 1, T0);
      t.commit(T0);
      t.ingest([obs({ hex: 'a00001', altBaro: 5800, posTime: T0 + 2000 })], 1, T0 + 2000);
      expect(t.commit(T0 + 2000).removed).toEqual([]);
      t.ingest([obs({ hex: 'a00001', altBaro: 6200, posTime: T0 + 4000 })], 1, T0 + 4000);
      expect(t.commit(T0 + 4000).removed).toEqual(['a00001']);
    });

    it('always shows aircraft on the ground inside the radius', () => {
      const t = tracker();
      t.ingest(
        [obs({ hex: 'a00001', altBaro: 'ground', gsKt: 0, posTime: T0, lat: 40.4165, lon: -86.9365 })],
        1,
        T0,
      );
      expect(t.commit(T0).upserts[0]).toMatchObject({
        onGround: true,
        altSource: 'ground',
        phase: 'parked',
        aglFt: 0,
      });
    });
  });

  describe('vehicles', () => {
    // As adsb.fi sends them at KDEN: emitter category C1, some with the type "SERV", speeds of up to 46 kt.
    const ops = (extra: object) => obs({ hex: 'a7f001', callsign: 'OPS8', category: 'C1', ...extra });

    it('are vehicles whatever they do, and always on the ground', () => {
      const t = tracker();
      const phases: unknown[] = [];
      [0, 46, 70, 12, 0].forEach((gsKt, i) => {
        const at = T0 + i * 2000;
        t.ingest([ops({ altBaro: 1400, gsKt, posTime: at, lat: 40.4165 + i * 1e-4, lon: -86.9365 })], 1, at);
        const [a] = t.commit(at).upserts;
        phases.push([a?.phase, a?.onGround, a?.aglFt, a?.heightM]);
      });
      expect(phases).toEqual(Array(5).fill(['vehicle', true, 0, undefined]));
    });

    it('become vehicles when a source says so later', () => {
      const t = tracker();
      const here = { lat: 40.4165, lon: -86.9365, altBaro: 'ground' as const, gsKt: 46 };
      t.ingest([obs({ hex: 'a7f001', ...here, posTime: T0 })], 1, T0);
      expect(t.commit(T0).upserts[0]?.phase).toBe('takeoff_roll');
      t.ingest([ops({ ...here, typeCode: 'SERV', posTime: T0 + 2000 })], 1, T0 + 2000);
      expect(t.commit(T0 + 2000).upserts[0]?.phase).toBe('vehicle');
    });

    it('do not include an aircraft whose transponder is set up wrong', () => {
      const t = tracker();
      t.ingest([ops({ typeCode: 'C172', altBaro: 1600, gsKt: 90, posTime: T0 })], 1, T0);
      expect(t.commit(T0).upserts[0]).toMatchObject({ onGround: false });
      expect(t.snapshot().aircraft[0]?.phase).not.toBe('vehicle');
    });
  });

  describe('altitude pipeline', () => {
    it('sends an ellipsoid height for airborne aircraft and none for aircraft on the ground', () => {
      const t = tracker({ qnhHpa: 1032.9 });
      t.ingest(
        [
          obs({ hex: 'a00001', altBaro: 1175, altGeomFt: 1525, posTime: T0 }),
          obs({
            hex: 'a00002',
            altBaro: 'ground',
            gsKt: 8.2,
            trueHeadingDeg: 11.25,
            trackDeg: null,
            posTime: T0,
            lat: 40.4165,
            lon: -86.9365,
          }),
        ],
        1,
        T0,
      );
      const [air, ground] = t.commit(T0).upserts.sort((a, b) => a.hex.localeCompare(b.hex));
      expect(air).toMatchObject({ altSource: 'geom', onGround: false, altBaroFt: 1175, altGeomFt: 1525 });
      expect(air?.heightM).toBeCloseTo(1525 * 0.3048, 1);
      expect(ground?.heightM).toBeUndefined();
      expect(ground).toMatchObject({ onGround: true, headingDeg: 11.3, phase: 'taxiing' });
    });

    it('agrees between geometric and corrected barometric altitude for every airborne aircraft captured live', () => {
      // adsb.lol at KIND and KLAF on 2026-11-24, with the METARs issued at the same time
      // (fixture metar-klaf-kind.json: altimeter 1032.9 hPa at KIND, 5 C, a cold high-pressure day).
      const metars = fixtureJson('metar-klaf-kind.json');
      let compared = 0;
      let errorWithTemp = 0;
      let errorWithoutTemp = 0;
      for (const [file, icao, lat, lon, elevationFt] of [
        ['adsblol-v2-kind.json', 'KIND', 39.7173, -86.294403, 797],
        ['adsblol-v2-klaf.json', 'KLAF', 40.412875, -86.939363, 606],
      ] as const) {
        const json = fixtureJson(file) as { now: number };
        const metar = parseMetar(metars, icao, json.now);
        const shared = {
          lat,
          lon,
          elevationFt,
          geoidUndulationM: geoidUndulationM(lat, lon),
          qnhHpa: metar?.altimHpa ?? null,
          radiusNm: 20,
          ceilingFtAgl: 60_000,
        };
        for (const o of parseReadsbResponse(json, json.now, 'adsblol')) {
          if (typeof o.altBaro !== 'number' || o.altGeomFt == null) continue;
          const height = (ctx: Partial<TrackerContext>, withGeom: boolean) => {
            const t = new AirportTracker(() => context({ ...shared, ...ctx }));
            t.ingest([withGeom ? o : { ...o, altGeomFt: null }], 1, json.now);
            return t.commit(json.now).upserts[0];
          };
          const geom = height({}, true);
          const baro = height({ tempC: metar?.tempC }, false);
          const baroNoTemp = height({ tempC: null }, false);
          if (geom?.heightM == null || baro?.heightM == null || baroNoTemp?.heightM == null) continue;
          compared += 1;
          expect(geom.altSource, `${file} ${o.hex}`).toBe('geom');
          expect(baro.altSource, `${file} ${o.hex}`).toBe('baro-qnh');
          // Within 25 m all the way up to 7,900 ft, for airliners and light aircraft alike. Uncorrected, the
          // worst case in this sample is 71 m.
          expect(Math.abs(geom.heightM - baro.heightM), `${file} ${o.hex}`).toBeLessThan(25);
          errorWithTemp += Math.abs(geom.heightM - baro.heightM);
          errorWithoutTemp += Math.abs(geom.heightM - baroNoTemp.heightM);
        }
      }
      // Low aircraft are within encoder noise either way; over all of them the temperature correction
      // cuts the error by more than half on this cold day.
      expect(errorWithTemp).toBeLessThan(errorWithoutTemp / 2);
      expect(compared).toBeGreaterThanOrEqual(8);
    });

    it('cannot place an airborne aircraft that reports no altitude, so it is not shown', () => {
      const t = tracker();
      t.ingest([obs({ hex: 'a00001', altBaro: null, altGeomFt: null, gsKt: 110, posTime: T0 })], 1, T0);
      expect(t.commit(T0).upserts).toEqual([]);
    });

    it('offers the altimeter setting aircraft report when there is no METAR', () => {
      const t = tracker({ qnhHpa: null });
      expect(t.aircraftQnhHpa()).toBeNull();
      t.ingest(
        [
          obs({ hex: 'a00001', navQnhHpa: 1032.8, posTime: T0 }),
          obs({ hex: 'a00002', navQnhHpa: 1032.8, posTime: T0 }),
          obs({ hex: 'a00003', navQnhHpa: 1013.2, posTime: T0 }),
        ],
        1,
        T0,
      );
      expect(t.aircraftQnhHpa()).toBe(1032.8);
    });
  });

  describe('TIS-B / ADS-R duplicates', () => {
    it('suppresses a ~ address that shadows a real ADS-B track', () => {
      const t = tracker();
      t.ingest(
        [
          obs({ hex: 'a8cd91', callsign: 'N6665G', lat: 40.42, lon: -86.9, altBaro: 1200, posTime: T0 }),
          obs({
            hex: '~2a1b3c',
            addrType: 'tisb_trackfile',
            lat: 40.4203,
            lon: -86.9004,
            altBaro: 1300,
            posTime: T0 - 4000,
          }),
          // Same place but 3,000 ft higher: a different aircraft.
          obs({
            hex: '~2a1b3d',
            addrType: 'tisb_trackfile',
            lat: 40.4203,
            lon: -86.9004,
            altBaro: 4200,
            posTime: T0,
          }),
          // A TIS-B target with nothing near it is real traffic without ADS-B.
          obs({
            hex: '~2a1b3e',
            addrType: 'tisb_other',
            lat: 40.38,
            lon: -86.99,
            altBaro: 2500,
            posTime: T0,
          }),
        ],
        1,
        T0,
      );
      expect(
        t
          .commit(T0)
          .upserts.map((a) => a.hex)
          .sort(),
      ).toEqual(['a8cd91', '~2a1b3d', '~2a1b3e'].sort());
    });

    it('needs matching callsigns when both have one', () => {
      const real = {
        hex: 'a8cd91',
        addrType: 'adsb_icao',
        lat: 40.42,
        lon: -86.9,
        posTime: T0,
        seenTime: T0,
        altSource: 'geom',
        onGround: false,
        phase: 'transit',
        source: 'adsbfi',
        altMslFt: 1500,
        gsKt: 100,
      } as const;
      const shadow = { ...real, hex: '~2a1b3c', addrType: 'tisb_icao' };
      expect(
        findShadows([
          { ...real, callsign: 'N6665G' },
          { ...shadow, callsign: 'N6665G' },
        ]).has('~2a1b3c'),
      ).toBe(true);
      expect(
        findShadows([
          { ...real, callsign: 'N6665G' },
          { ...shadow, callsign: 'N123AB' },
        ]).size,
      ).toBe(0);
      expect(findShadows([{ ...real, callsign: 'N6665G' }, shadow]).has('~2a1b3c')).toBe(true);
    });

    it('removes a shadow that was already showing once the real track appears', () => {
      const t = tracker();
      t.ingest(
        [
          obs({
            hex: '~2a1b3c',
            addrType: 'tisb_trackfile',
            lat: 40.42,
            lon: -86.9,
            altBaro: 1300,
            posTime: T0,
          }),
        ],
        1,
        T0,
      );
      expect(t.commit(T0).upserts.map((a) => a.hex)).toEqual(['~2a1b3c']);
      t.ingest(
        [obs({ hex: 'a8cd91', lat: 40.4201, lon: -86.9001, altBaro: 1250, posTime: T0 + 2000 })],
        1,
        T0 + 2000,
      );
      const delta = t.commit(T0 + 2000);
      expect(delta.upserts.map((a) => a.hex)).toEqual(['a8cd91']);
      expect(delta.removed).toEqual(['~2a1b3c']);
    });
  });

  it('keeps a trail and hands it over with the snapshot', () => {
    const t = tracker();
    for (let i = 0; i < 5; i += 1) {
      t.ingest([obs({ hex: 'a00001', lat: 40.41 + i * 0.001, posTime: T0 + i * 2000 })], 1, T0 + i * 2000);
      t.commit(T0 + i * 2000);
    }
    const snap = t.snapshot(180_000, T0 + 10_000);
    expect(snap.aircraft).toHaveLength(1);
    expect(snap.trails.a00001).toHaveLength(5);
    expect(snap.trails.a00001?.[0]).toEqual([T0, 40.41, -86.9394, expect.any(Number)]);
    // A snapshot carries only the recent part of the trail.
    expect(t.snapshot(5000, T0 + 10_000).trails.a00001).toHaveLength(2);
  });

  it('forgets everything on clear and says what disappeared', () => {
    const t = tracker();
    t.ingest([obs({ hex: 'a00001', posTime: T0 }), obs({ hex: 'a00002', posTime: T0 })], 1, T0);
    t.commit(T0);
    expect(t.clear().sort()).toEqual(['a00001', 'a00002']);
    expect(t.snapshot().aircraft).toEqual([]);
  });

  it('promotes a stopped aircraft to parked with no new data', () => {
    const t = tracker();
    const ramp = { lat: 40.4165, lon: -86.9365 };
    t.ingest([obs({ hex: 'a00001', ...ramp, altBaro: 'ground', gsKt: 9, trackDeg: 30, posTime: T0 })], 1, T0);
    expect(t.commit(T0).upserts[0]?.phase).toBe('taxiing');
    t.ingest(
      [obs({ hex: 'a00001', ...ramp, altBaro: 'ground', gsKt: 0, trackDeg: 30, posTime: T0 + 5000 })],
      1,
      T0 + 5000,
    );
    expect(t.commit(T0 + 5000).upserts[0]?.phase).toBe('taxiing');
    // Heard again (same position), so it is not stale, and 45 s have passed since it stopped.
    t.ingest(
      [obs({ hex: 'a00001', ...ramp, altBaro: 'ground', gsKt: 0, trackDeg: 30, posTime: T0 + 5000 })],
      1,
      T0 + 40_000,
    );
    expect(t.commit(T0 + 55_000).upserts[0]).toMatchObject({ hex: 'a00001', phase: 'parked' });
  });
});
