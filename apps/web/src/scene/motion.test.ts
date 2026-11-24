import { destinationPoint, distanceM } from '@towercab/shared';
import { describe, expect, it } from 'vitest';
import {
  bankFromTurnRate,
  EXTRAPOLATE_MAX_MS,
  FADE_OUT_MS,
  MotionBuffer,
  type MotionSample,
  pitchFromVerticalRate,
  turnTowards,
} from './motion';

const START = { lat: 40.4129, lon: -86.9394 };
const KT = 0.514444;

/** A report `seconds` into a straight run east at a steady speed. */
function report(seconds: number, extra: Partial<MotionSample> = {}, gsKt = 90): MotionSample {
  const p = destinationPoint(START.lat, START.lon, 90, gsKt * KT * seconds);
  return {
    t: seconds * 1000,
    lat: p.lat,
    lon: p.lon,
    heightM: 400,
    onGround: false,
    headingDeg: 90,
    trackDeg: 90,
    gsKt,
    vertRateFpm: 0,
    ...extra,
  };
}

/** Metres travelled east from the start, measured along the track. */
const eastOf = (s: { lat: number; lon: number }) =>
  Math.sign(s.lon - START.lon) * distanceM(START.lat, START.lon, s.lat, s.lon);

/** Runs the buffer frame by frame and returns the eastward distance at every frame. */
function play(buffer: MotionBuffer, fromMs: number, toMs: number, onFrame?: (t: number) => void): number[] {
  const out: number[] = [];
  for (let t = fromMs; t <= toMs; t += 16) {
    onFrame?.(t);
    const state = buffer.sample(t);
    if (state) out.push(eastOf(state));
  }
  return out;
}

describe('MotionBuffer', () => {
  it('has nothing to show before the first report', () => {
    expect(new MotionBuffer().sample(1000)).toBeNull();
  });

  it('interpolates between the two reports around the render time', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    buffer.push(report(4));
    const state = buffer.sample(3000);
    expect(state).not.toBeNull();
    // 90 kt for 3 s is 138.9 m.
    expect(eastOf(state as { lat: number; lon: number })).toBeCloseTo(90 * KT * 3, 0);
    expect(state?.u).toBeCloseTo(0.5, 6);
    expect(state?.from.t).toBe(2000);
    expect(state?.to.t).toBe(4000);
    expect(state?.speedMps).toBeCloseTo(90 * KT, 0);
    expect(state?.overdueMs).toBeLessThan(0);
  });

  it('is on the ground only between two reports that are both on the ground', () => {
    // A landing, with reports seven seconds apart as in a recording.
    const landing = new MotionBuffer();
    landing.push(report(0, { heightM: 160, vertRateFpm: -300 }));
    landing.push(report(7, { heightM: null, onGround: true }));
    landing.push(report(14, { heightM: null, onGround: true }));
    // Still coming down, right up to the first report on the ground.
    expect(landing.sample(1000)?.onGround).toBe(false);
    expect(landing.sample(6900)?.onGround).toBe(false);
    expect(landing.sample(7100)?.onGround).toBe(true);

    // A take-off: climbing from the moment it leaves the last report on the ground.
    const takeoff = new MotionBuffer();
    takeoff.push(report(0, { heightM: null, onGround: true }));
    takeoff.push(report(7, { heightM: null, onGround: true }));
    takeoff.push(report(14, { heightM: 170, vertRateFpm: 500 }));
    expect(takeoff.sample(6900)?.onGround).toBe(true);
    expect(takeoff.sample(7100)?.onGround).toBe(false);
  });

  it('refuses a report that is not newer than the newest one', () => {
    const buffer = new MotionBuffer();
    expect(buffer.push(report(4))).toBe(true);
    expect(buffer.push(report(2))).toBe(false);
    expect(buffer.push(report(4))).toBe(false);
    expect(buffer.push(report(6))).toBe(true);
    expect(buffer.length).toBe(2);
  });

  it('moves steadily and without jumps through normal updates', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    // Reports every 2 s, arriving about a second after the position they describe; drawn 2.5 s behind.
    let next = 4;
    const positions = play(buffer, 0, 30_000, (t) => {
      const now = t + 2500;
      if (now >= next * 1000 + 1000) {
        buffer.push(report(next));
        next += 2;
      }
    });
    const speed = 90 * KT * 0.016;
    for (let i = 1; i < positions.length; i += 1) {
      const step = (positions[i] as number) - (positions[i - 1] as number);
      expect(step).toBeGreaterThan(speed * 0.9);
      expect(step).toBeLessThan(speed * 1.1);
    }
  });

  it('carries on along the last track when the next report is late', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    buffer.settle();
    const state = buffer.sample(6000);
    // Four seconds past the last report at 90 kt.
    expect(eastOf(state as { lat: number; lon: number })).toBeCloseTo(90 * KT * 6, 0);
    expect(state?.alpha).toBe(1);
    expect(state?.overdueMs).toBe(4000);
    expect(state?.from).toBe(state?.to);
  });

  it('stops dead reckoning after 10 s and fades out', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    buffer.settle();
    const limit = 2000 + EXTRAPOLATE_MAX_MS;
    const atLimit = buffer.sample(limit);
    expect(atLimit?.alpha).toBe(1);
    const farthest = eastOf(atLimit as { lat: number; lon: number });
    expect(farthest).toBeCloseTo(90 * KT * 12, 0);

    const fading = buffer.sample(limit + FADE_OUT_MS / 2);
    expect(fading?.alpha).toBeCloseTo(0.5, 2);
    // It does not keep flying while it fades.
    expect(eastOf(fading as { lat: number; lon: number })).toBeCloseTo(farthest, 3);
    expect(fading?.speedMps).toBe(0);
    expect(buffer.sample(limit + FADE_OUT_MS + 1)?.alpha).toBe(0);
  });

  it('keeps a standing aircraft where it is, solid, however long it has been', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0, { gsKt: 0, onGround: true, heightM: null, trackDeg: 310 }));
    buffer.settle();
    const state = buffer.sample(120_000);
    expect(state?.alpha).toBe(1);
    expect(eastOf(state as { lat: number; lon: number })).toBeCloseTo(0, 6);
  });

  it('climbs and descends while dead reckoning, using the last vertical rate', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0, { vertRateFpm: 600 }));
    // 600 ft/min for 5 s is 50 ft, 15.24 m.
    expect(buffer.sample(5000)?.extraHeightM).toBeCloseTo(15.24, 1);
    const ground = new MotionBuffer();
    ground.push(report(0, { onGround: true, heightM: null, vertRateFpm: 600, gsKt: 20 }));
    expect(ground.sample(5000)?.extraHeightM).toBe(0);
  });

  it('never moves an aircraft backwards when a late report shows it was not as far along as assumed', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    // Nothing for 8 s: the aircraft is dead-reckoned at 90 kt. In fact it had slowed to 60 kt.
    const actual = (seconds: number) => {
      const metres = 90 * KT * 2 + 60 * KT * (seconds - 2);
      const p = destinationPoint(START.lat, START.lon, 90, metres);
      return report(seconds, { lat: p.lat, lon: p.lon, gsKt: 60 });
    };
    let delivered = false;
    const positions = play(buffer, 2000, 20_000, (t) => {
      if (!delivered && t >= 10_000) {
        delivered = true;
        buffer.push(actual(10));
        buffer.push(actual(12));
      } else if (delivered && t % 2000 < 16 && t > 10_500) {
        buffer.push(actual(t / 1000 + 2));
      }
    });
    for (let i = 1; i < positions.length; i += 1) {
      const step = (positions[i] as number) - (positions[i - 1] as number);
      expect(step, `frame ${i}`).toBeGreaterThanOrEqual(-1e-6);
      // And it does not leap forward either: never more than 90 kt worth of movement in a frame.
      expect(step, `frame ${i}`).toBeLessThan(90 * KT * 0.016 * 1.05);
    }
    // In the end it is where the reports say it is.
    const final = buffer.sample(20_000);
    const truth = 90 * KT * 2 + 60 * KT * 18;
    expect(Math.abs(eastOf(final as { lat: number; lon: number }) - truth)).toBeLessThan(3);
  });

  it('closes a sideways error gradually rather than snapping across', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    buffer.sample(5000);
    buffer.sample(5016);
    // The aircraft had in fact turned: the new report is 60 m north of the assumed path.
    const turned = destinationPoint(report(6).lat, report(6).lon, 0, 60);
    buffer.push(report(6, { lat: turned.lat, lon: turned.lon }));
    const before = buffer.sample(5016) as { lat: number; lon: number };
    let previous = before;
    let largestStep = 0;
    for (let t = 5032; t < 12_000; t += 16) {
      if (t === 7000)
        buffer.push(
          report(8, { lat: turned.lat, lon: destinationPoint(turned.lat, turned.lon, 90, 90 * KT * 2).lon }),
        );
      const state = buffer.sample(t) as { lat: number; lon: number };
      largestStep = Math.max(largestStep, distanceM(previous.lat, previous.lon, state.lat, state.lon));
      previous = state;
    }
    // A snap would be a single step of tens of metres. Frame-to-frame movement stays near normal flight.
    expect(largestStep).toBeLessThan(3);
  });

  it('turns the nose the short way round between reports', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0, { headingDeg: 350 }));
    buffer.push(report(2, { headingDeg: 10 }));
    expect(buffer.sample(1000)?.headingDeg).toBeCloseTo(0, 6);
    expect(buffer.sample(500)?.headingDeg).toBeCloseTo(355, 6);
  });

  it('works the heading out from movement when the aircraft does not report one', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0, { headingDeg: null, trackDeg: null }));
    buffer.push(report(2, { headingDeg: null, trackDeg: null }));
    expect(buffer.sample(1000)?.headingDeg).toBeCloseTo(90, 0);
    // Not moving and nothing reported: unknown.
    const still = new MotionBuffer();
    still.push(report(0, { headingDeg: null, trackDeg: null, gsKt: 0 }, 0));
    still.push(report(2, { headingDeg: null, trackDeg: null, gsKt: 0 }, 0));
    expect(still.sample(1000)?.headingDeg).toBeNull();
  });

  it('fades a newly seen aircraft in, unless it was there from the start', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(0));
    buffer.push(report(2));
    expect(buffer.sample(1000)?.alpha).toBe(0);
    expect(buffer.sample(1400)?.alpha).toBeCloseTo(0.5, 2);
    expect(buffer.sample(1800)?.alpha).toBe(1);
    const settled = new MotionBuffer();
    settled.push(report(0));
    settled.settle();
    expect(settled.sample(500)?.alpha).toBe(1);
  });

  it('holds at the first report until the render time reaches it', () => {
    const buffer = new MotionBuffer();
    buffer.push(report(5));
    buffer.push(report(7));
    const state = buffer.sample(3000);
    expect(eastOf(state as { lat: number; lon: number })).toBeCloseTo(90 * KT * 5, 0);
    expect(state?.speedMps).toBe(0);
  });

  it('forgets reports it no longer needs', () => {
    const buffer = new MotionBuffer();
    for (let s = 0; s <= 120; s += 2) buffer.push(report(s));
    buffer.sample(118_000);
    expect(buffer.length).toBeLessThan(15);
    expect(eastOf(buffer.sample(118_000) as { lat: number; lon: number })).toBeCloseTo(90 * KT * 118, -1);
  });
});

describe('attitude helpers', () => {
  it('turnTowards limits the step and goes the short way', () => {
    expect(turnTowards(350, 10, 5)).toBe(355);
    expect(turnTowards(10, 350, 5)).toBe(5);
    expect(turnTowards(88, 90, 5)).toBe(90);
    expect(turnTowards(0, 170, 30)).toBe(30);
    expect(turnTowards(0, 190, 30)).toBe(330);
  });

  it('pitches gently with the flight path and not at all on the ground', () => {
    // 700 ft/min at 75 kt (a climbing Cessna) is about 5 degrees.
    expect(pitchFromVerticalRate(700, 75 * KT, false)).toBeCloseTo(5.3, 0);
    // A normal 3 degree approach: 700 ft/min down at 135 kt.
    expect(pitchFromVerticalRate(-700, 135 * KT, false)).toBeCloseTo(-2.9, 0);
    expect(pitchFromVerticalRate(6000, 100, false)).toBe(15);
    expect(pitchFromVerticalRate(-6000, 60, false)).toBe(-10);
    expect(pitchFromVerticalRate(700, 75 * KT, true)).toBe(0);
    expect(pitchFromVerticalRate(null, 75 * KT, false)).toBe(0);
    expect(pitchFromVerticalRate(300, 5, false)).toBe(0);
  });

  it('banks into a turn', () => {
    // A standard rate turn (3 degrees per second) at 90 kt needs about 14 degrees of bank.
    expect(bankFromTurnRate(3, 90 * KT, false)).toBeCloseTo(13.6, 0);
    expect(bankFromTurnRate(-3, 90 * KT, false)).toBeCloseTo(-13.6, 0);
    expect(bankFromTurnRate(40, 120, false)).toBe(35);
    expect(bankFromTurnRate(3, 90 * KT, true)).toBe(0);
    expect(bankFromTurnRate(30, 8, false)).toBe(0);
  });
});
