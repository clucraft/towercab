/**
 * What to do when Google answers "too many requests" (HTTP 429) for a tile.
 *
 * There is a limit on tiles per minute. With Cesium ion it belongs to ion's account at Google and is shared by
 * everyone who uses it, so it can be reached without this page doing anything unusual, and a minute later it is
 * over. Cesium does not ask again for a tile that failed, so this does: after a while, and then more and more
 * slowly. Only when that does not help is a quota used up.
 *
 * Marking a tile as not loaded yet is not part of Cesium's public interface. The version is pinned, and
 * `tileRetry.test.ts` fails if an upgrade changes it.
 */

/** How long to wait before asking again, the first time and after each time that was refused too. */
export const RETRY_AFTER_MS = [15_000, 30_000, 60_000, 120_000] as const;
/** A refusal this long after asking again has nothing to do with the ones before. */
const CALM_AFTER_MS = 60_000;
/** Cesium's `Cesium3DTileContentState.UNLOADED`: the tile is asked for when it is next needed. */
export const UNLOADED = 0;

/** What is used of Cesium's tiles. */
export interface RetryTile {
  readonly children: readonly RetryTile[];
  readonly contentFailed: boolean;
  readonly _contentResource?: { readonly url: string };
  _contentState: number;
}

/** Marks the tiles with these addresses that failed as not loaded yet. Returns how many there were. */
export function askAgain(root: RetryTile, urls: ReadonlySet<string>): number {
  if (urls.size === 0) return 0;
  let found = 0;
  const stack = [root];
  for (let tile = stack.pop(); tile; tile = stack.pop()) {
    for (const child of tile.children) stack.push(child);
    if (!tile.contentFailed || !tile._contentResource || !urls.has(tile._contentResource.url)) continue;
    tile._contentState = UNLOADED;
    found += 1;
  }
  return found;
}

/** Keeps track of the tiles that were refused and of when to ask for them again. */
export class TileRefusals {
  private urls = new Set<string>();
  private tries = 0;
  private dueAt: number | null = null;
  private askedAt = Number.NEGATIVE_INFINITY;

  /** How many tiles are missing because they were refused. */
  get missing(): number {
    return this.urls.size;
  }

  /**
   * A tile was refused. The answer is `first` when this is the beginning of it, `waiting` when asking again is
   * under way, and `give up` when that has been done often enough.
   */
  refused(url: string, now: number): 'first' | 'waiting' | 'give up' {
    this.urls.add(url);
    if (this.dueAt !== null) return 'waiting';
    if (now - this.askedAt > CALM_AFTER_MS) this.tries = 0;
    const wait = RETRY_AFTER_MS[this.tries];
    if (wait === undefined) return 'give up';
    this.dueAt = now + wait;
    this.tries += 1;
    return this.tries === 1 ? 'first' : 'waiting';
  }

  /** The tiles to ask for again, when it is time to. */
  due(now: number): ReadonlySet<string> | null {
    if (this.dueAt === null || now < this.dueAt) return null;
    return this.take(now);
  }

  /** The tiles to ask for again, right now and as if for the first time: someone has asked for them. */
  restart(now: number): ReadonlySet<string> {
    this.tries = 0;
    return this.take(now);
  }

  private take(now: number): ReadonlySet<string> {
    const urls = this.urls;
    this.urls = new Set();
    this.dueAt = null;
    this.askedAt = now;
    return urls;
  }
}
