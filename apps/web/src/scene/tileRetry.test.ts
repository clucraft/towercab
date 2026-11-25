import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import {
  askAgain,
  RETRY_AFTER_MS,
  type RetryTile,
  SILENT_REFUSALS,
  TileRefusals,
  UNLOADED,
} from './tileRetry';

const FAILED = 5;
const READY = 3;

function tile(name: string, state: number, children: RetryTile[] = []): RetryTile {
  return {
    children,
    _contentState: state,
    _contentResource: { url: url(name) },
    get contentFailed() {
      return this._contentState === FAILED;
    },
  };
}

function url(name: string) {
  return `https://tiles.test/${name}`;
}

describe('askAgain', () => {
  it('marks the refused tiles as not loaded yet, wherever they are, and leaves the others alone', () => {
    const refused = tile('a', FAILED);
    const broken = tile('b', FAILED);
    const fine = tile('c', READY);
    const deep = tile('d', FAILED);
    const root = tile('root', READY, [refused, tile('e', READY, [broken, fine, tile('f', READY, [deep])])]);
    expect(askAgain(root, new Set([url('a'), url('c'), url('d')]))).toBe(2);
    expect([refused, broken, fine, deep].map((t) => t._contentState)).toEqual([
      UNLOADED,
      FAILED,
      READY,
      UNLOADED,
    ]);
  });

  it('has nothing to do for tiles that are gone, or without any', () => {
    expect(askAgain(tile('root', READY), new Set([url('a')]))).toBe(0);
    expect(askAgain(tile('root', FAILED), new Set())).toBe(0);
  });
});

describe('TileRefusals', () => {
  /** A scene that is there, with several hundred tiles on screen. */
  const DRAWN = 300;

  /** Refuses tiles for as long as `refusing` says so, asking again whenever it is time. Returns what was answered. */
  function run(names: string[], drawn: number, refusing: (now: number) => boolean, untilMs: number) {
    const r = new TileRefusals();
    const answers: { at: number; answer: string }[] = [];
    const refuse = (which: Iterable<string>, now: number) => {
      for (const u of which) {
        const answer = r.refused(u, now, drawn);
        if (answer !== 'quiet') answers.push({ at: now, answer });
      }
    };
    refuse(names.map(url), 0);
    for (let now = 0; now <= untilMs; now += 100) {
      const again = r.due(now);
      if (again && refusing(now)) refuse(again, now);
    }
    return { answers, missing: r.missing };
  }

  it('asks again soon, and says nothing when the tiles come then', () => {
    const r = new TileRefusals();
    expect(r.refused(url('a'), 1000, DRAWN)).toBe('quiet');
    expect(r.refused(url('b'), 1200, DRAWN)).toBe('quiet');
    expect(r.missing).toBe(2);
    expect(r.due(3900)).toBeNull();
    expect([...(r.due(5000) ?? [])]).toEqual([url('a'), url('b')]);
    expect(r.missing).toBe(0);
    expect(r.due(6100)).toBeNull();
  });

  it('says nothing about a few tiles that come within a quarter of a minute', () => {
    expect(run(['a', 'b', 'c'], DRAWN, (now) => now < 14_000, 120_000)).toEqual({ answers: [], missing: 0 });
  });

  it('says so, once, when a few tiles stay missing', () => {
    const { answers, missing } = run(['a', 'b', 'c'], DRAWN, () => true, 40_000);
    expect(answers.map((a) => a.answer)).toEqual(['tell']);
    expect(answers[0]?.at).toBeGreaterThanOrEqual(15_000);
    expect(answers[0]?.at).toBeLessThan(18_000);
    expect(missing).toBe(3);
  });

  it('says so after the first time of asking again when most of the scene is missing', () => {
    const names = Array.from({ length: 18 }, (_, i) => `t${i}`);
    const { answers } = run(names, 0, () => true, 12_000);
    expect(answers.map((a) => a.answer)).toEqual(['tell']);
    expect(answers[0]?.at).toBeGreaterThanOrEqual(3_000);
    expect(answers[0]?.at).toBeLessThan(5_000);
  });

  it('waits longer every time, and gives up when most of the scene has been missing for minutes', () => {
    const { answers } = run(['a', 'b'], 0, () => true, 260_000);
    const all = RETRY_AFTER_MS.reduce((sum, wait) => sum + wait, 0);
    const gaveUp = answers.find((a) => a.answer === 'give up');
    expect(gaveUp?.at).toBeGreaterThanOrEqual(all);
    expect(gaveUp?.at).toBeLessThan(all + 10_000);
  });

  it('does not give up for the sake of a few tiles', () => {
    const { answers, missing } = run(['a', 'b'], DRAWN, () => true, 1_000_000);
    expect(answers.map((a) => a.answer)).toEqual(['tell']);
    expect(missing).toBe(2);
  });

  it('says so again when it happens another time', () => {
    const r = new TileRefusals();
    const lasting = (from: number) => {
      const answers = [r.refused(url('a'), from, 0)];
      r.due(from + 4000);
      answers.push(r.refused(url('a'), from + 4100, 0));
      r.due(from + 20_000);
      return answers;
    };
    expect(lasting(0)).toEqual(['quiet', 'tell']);
    expect(r.due(90_000)).toBeNull();
    expect(lasting(100_000)).toEqual(['quiet', 'tell']);
  });

  it('does not add up refusals of different tiles that all came after a moment', () => {
    const r = new TileRefusals();
    for (let i = 0; i < 40; i += 1) {
      const now = i * 8000;
      expect(r.refused(url(`tile${i}`), now, DRAWN)).toBe('quiet');
      expect([...(r.due(now + RETRY_AFTER_MS[0]) ?? [])]).toEqual([url(`tile${i}`)]);
    }
    expect(r.missing).toBe(0);
  });

  it('starts over when it was quiet for a while', () => {
    const r = new TileRefusals();
    let now = 0;
    for (let i = 0; i < SILENT_REFUSALS; i += 1) {
      expect(r.refused(url('a'), now, DRAWN)).toBe('quiet');
      now += 40_000;
      expect(r.due(now)?.size).toBe(1);
    }
    expect(r.refused(url('a'), now + 61_000, DRAWN)).toBe('quiet');
    expect(r.due(now + 61_000 + RETRY_AFTER_MS[0])?.size).toBe(1);
  });

  it('asks for all of them at once, as if for the first time, when someone wants Photoreal back', () => {
    const r = new TileRefusals();
    r.refused(url('a'), 0, 0);
    r.due(4000);
    expect(r.refused(url('a'), 4100, 0)).toBe('tell');
    r.refused(url('b'), 4200, 0);
    expect([...r.restart()]).toEqual([url('a'), url('b')]);
    expect(r.missing).toBe(0);
    expect(r.refused(url('a'), 5000, 0)).toBe('quiet');
  });
});

describe('what is used of Cesium without being public', () => {
  it('is there in this version', () => {
    const classes = Cesium as unknown as Record<string, { prototype: object } | undefined>;
    const made = Object.create(classes.Cesium3DTile?.prototype ?? null) as RetryTile & {
      contentUnloaded: boolean;
    };
    made._contentState = FAILED;
    expect([made.contentFailed, made.contentUnloaded]).toEqual([true, false]);
    made._contentState = UNLOADED;
    expect([made.contentFailed, made.contentUnloaded]).toEqual([false, true]);
  });
});
