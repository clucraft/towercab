import * as Cesium from 'cesium';
import { describe, expect, it } from 'vitest';
import { askAgain, RETRY_AFTER_MS, type RetryTile, TileRefusals, UNLOADED } from './tileRetry';

const FAILED = 5;
const READY = 3;

function tile(name: string, state: number, children: RetryTile[] = []): RetryTile {
  return {
    children,
    _contentState: state,
    _contentResource: { url: `https://tiles.test/${name}` },
    get contentFailed() {
      return this._contentState === FAILED;
    },
  };
}

const url = (name: string) => `https://tiles.test/${name}`;

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
  it('waits, asks for all that were refused, and forgets about it when they come', () => {
    const r = new TileRefusals();
    expect(r.refused(url('a'), 1000)).toBe('first');
    expect(r.refused(url('b'), 1200)).toBe('waiting');
    expect(r.missing).toBe(2);
    expect(r.due(1000 + RETRY_AFTER_MS[0] - 1)).toBeNull();
    expect([...(r.due(1000 + RETRY_AFTER_MS[0]) ?? [])]).toEqual([url('a'), url('b')]);
    expect(r.missing).toBe(0);
    expect(r.due(1e9)).toBeNull();
  });

  it('waits longer every time, and then gives up', () => {
    const r = new TileRefusals();
    let now = 0;
    const answers = RETRY_AFTER_MS.map((wait) => {
      const answer = r.refused(url('a'), now);
      expect(r.due(now + wait - 1)).toBeNull();
      now += wait;
      expect(r.due(now)?.size).toBe(1);
      now += 500;
      return answer;
    });
    expect(answers).toEqual(['first', 'waiting', 'waiting', 'waiting']);
    expect(r.refused(url('a'), now)).toBe('give up');
  });

  it('starts over when it was quiet for a while', () => {
    const r = new TileRefusals();
    r.refused(url('a'), 0);
    r.due(15_000);
    expect(r.refused(url('a'), 16_000)).toBe('waiting');
    r.due(46_000);
    expect(r.refused(url('b'), 200_000)).toBe('first');
    expect(r.due(215_000)?.size).toBe(1);
  });

  it('asks again at once, and from the beginning, when someone wants Photoreal back', () => {
    const r = new TileRefusals();
    let now = 0;
    for (const wait of RETRY_AFTER_MS) {
      r.refused(url('a'), now);
      now += wait;
      r.due(now);
    }
    expect(r.refused(url('a'), now)).toBe('give up');
    expect([...r.restart(now)]).toEqual([url('a')]);
    expect(r.refused(url('a'), now + 500)).toBe('first');
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
