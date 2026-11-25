import { describe, expect, it } from 'vitest';
import { chooseQuality, DetailGovernor, PROFILES } from './quality';

describe('choosing a quality', () => {
  it('gives phones and tablets the lite profile', () => {
    expect(chooseQuality({ coarsePointer: true, memoryGb: 8, cores: 8 })).toBe('lite');
  });

  it('gives an ordinary computer the high profile, including one that tells nothing', () => {
    expect(chooseQuality({ coarsePointer: false, memoryGb: 8, cores: 8 })).toBe('high');
    expect(chooseQuality({})).toBe('high');
  });

  it('gives a computer with little memory or a weak processor the lite profile', () => {
    expect(chooseQuality({ coarsePointer: false, memoryGb: 4, cores: 8 })).toBe('lite');
    expect(chooseQuality({ coarsePointer: false, memoryGb: 8, cores: 2 })).toBe('lite');
  });

  it('lets the address bar decide, and ignores nonsense there', () => {
    expect(chooseQuality({ coarsePointer: true }, 'high')).toBe('high');
    expect(chooseQuality({}, 'lite')).toBe('lite');
    expect(chooseQuality({}, 'ultra')).toBe('high');
  });

  it('has profiles whose steps only get cheaper', () => {
    for (const profile of Object.values(PROFILES)) {
      profile.steps.forEach((step, i) => {
        const before = profile.steps[i - 1];
        if (!before) return;
        expect(step.error).toBeGreaterThanOrEqual(before.error);
        expect(step.resolution).toBeLessThanOrEqual(before.resolution);
        expect(step).not.toEqual(before);
      });
      expect(profile.steps[profile.start]).toBeDefined();
    }
    expect(PROFILES.lite.tiles.cacheBytes).toBeLessThan(PROFILES.high.tiles.cacheBytes);
  });
});

/** Feeds `seconds` of frames of `ms` each and collects what the governor answered. */
function run(governor: DetailGovernor, ms: number, seconds: number, loading = false): string[] {
  const answers: string[] = [];
  for (let t = 0; t < seconds * 1000; t += ms) {
    const answer = governor.frame(ms, loading);
    if (answer) answers.push(answer);
  }
  return answers;
}

describe('the detail governor', () => {
  it('leaves a scene alone that runs well', () => {
    const governor = new DetailGovernor(4);
    expect(run(governor, 33, 120)).toEqual([]);
    expect(governor.current).toBe(0);
  });

  it('steps down while the scene stays slow, then says it is struggling, once', () => {
    const governor = new DetailGovernor(3);
    expect(run(governor, 120, 120)).toEqual(['step', 'step', 'struggling']);
    expect(governor.current).toBe(2);
  });

  it('gives each step time to take effect', () => {
    const governor = new DetailGovernor(4);
    run(governor, 100, 6);
    expect(governor.current).toBe(1);
    run(governor, 100, 3);
    expect(governor.current).toBe(1);
  });

  it('is not impressed by short hitches or by a tab in the background', () => {
    const governor = new DetailGovernor(4);
    for (let i = 0; i < 30; i += 1) {
      run(governor, 200, 1);
      run(governor, 30, 2);
    }
    expect(run(governor, 5000, 60)).toEqual([]);
    expect(governor.current).toBe(0);
  });

  it('tries the better step once when the scene runs well, and goes back if that was too much', () => {
    const governor = new DetailGovernor(4, 1);
    expect(governor.current).toBe(1);
    expect(run(governor, 33, 9)).toEqual([]);
    expect(run(governor, 33, 2)).toEqual(['step']);
    expect(governor.current).toBe(0);
    // It only just manages that: back, and there it stays however well it runs.
    run(governor, 40, 8);
    expect(governor.current).toBe(1);
    expect(run(governor, 33, 120)).toEqual([]);
    expect(governor.current).toBe(1);
  });

  it('keeps the better step when it runs well there too', () => {
    const governor = new DetailGovernor(4, 1);
    run(governor, 33, 60);
    expect(governor.current).toBe(0);
  });

  it('does not reach for more on a device that only just manages, or while tiles are arriving', () => {
    const governor = new DetailGovernor(4, 1);
    expect(run(governor, 40, 60)).toEqual([]);
    expect(run(governor, 33, 60, true)).toEqual([]);
    expect(governor.current).toBe(1);
  });

  it('is slower to judge while tiles are arriving', () => {
    const loading = new DetailGovernor(4);
    run(loading, 100, 7, true);
    expect(loading.current).toBe(0);
    run(loading, 100, 2, true);
    expect(loading.current).toBe(1);
  });

  it('starts over when the base map changes', () => {
    const governor = new DetailGovernor(3);
    run(governor, 120, 60);
    governor.reset();
    expect(governor.current).toBe(0);
    expect(run(governor, 120, 8)).toEqual(['step']);
  });
});
