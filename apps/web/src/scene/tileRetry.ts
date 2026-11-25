/**
 * What to do when Google answers "too many requests" (HTTP 429) for a tile.
 *
 * There is a limit on tiles per minute. With Cesium ion it belongs to ion's account at Google and is shared by
 * everyone who uses it, so it can be reached without this page doing anything unusual. Often it is only a few tiles
 * that are refused, and a minute later it is over. Cesium does not ask again for a tile that failed, so this does:
 * soon, and then more and more slowly. Nothing is said about it unless it lasts.
 *
 * Marking a tile as not loaded yet is not part of Cesium's public interface. The version is pinned, and
 * `tileRetry.test.ts` fails if an upgrade changes it.
 */

/** How long to wait before asking for a tile again: the first time, the second time, and so on. */
export const RETRY_AFTER_MS = [3_000, 12_000, 30_000, 60_000, 120_000] as const;
/** A tile that was refused more often than this is worth a word, however few there are. */
export const SILENT_REFUSALS = 2;
/** A refusal this long after asking again has nothing to do with the ones before. */
const CALM_AFTER_MS = 60_000;
/** Finding the tiles means going through all of them, so those that are due about now are asked for together. */
const TOGETHER_MS = 1_000;
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

interface Refusal {
  times: number;
  /** When to ask again, or null when that has been done and there is no answer yet. */
  dueAt: number | null;
  askedAt: number;
}

/** Keeps track of the tiles that were refused and of when to ask for each of them again. */
export class TileRefusals {
  private readonly tiles = new Map<string, Refusal>();
  private told = false;
  private lastLookAt = Number.NEGATIVE_INFINITY;

  /** How many tiles are missing because they were refused. */
  get missing(): number {
    let n = 0;
    for (const tile of this.tiles.values()) if (tile.dueAt !== null) n += 1;
    return n;
  }

  /**
   * A tile was refused, while `drawn` tiles are on screen. The answer is `tell` when that has gone on for long
   * enough to say something (once each time it happens), and `give up` when most of the scene has been missing for
   * minutes.
   */
  refused(url: string, now: number, drawn: number): 'quiet' | 'tell' | 'give up' {
    // With all that were refused long here, this is a new time.
    if (this.tiles.size === 0) this.told = false;
    let tile = this.tiles.get(url);
    if (!tile || (tile.dueAt === null && now - tile.askedAt > CALM_AFTER_MS)) {
      tile = { times: 0, dueAt: null, askedAt: Number.NEGATIVE_INFINITY };
      this.tiles.set(url, tile);
    }
    const wait = RETRY_AFTER_MS[Math.min(tile.times, RETRY_AFTER_MS.length - 1)] as number;
    tile.dueAt = now + wait;
    tile.times += 1;

    const mostly = this.missing > drawn;
    if (mostly && tile.times > RETRY_AFTER_MS.length) return 'give up';
    const lasting = tile.times > SILENT_REFUSALS || (tile.times > 1 && mostly);
    if (!lasting || this.told) return 'quiet';
    this.told = true;
    return 'tell';
  }

  /** The tiles to ask for again, when there are any that it is time for. */
  due(now: number): ReadonlySet<string> | null {
    if (this.tiles.size === 0 || now - this.lastLookAt < TOGETHER_MS) return null;
    this.lastLookAt = now;
    const urls = new Set<string>();
    for (const [url, tile] of this.tiles) {
      if (tile.dueAt === null) {
        if (now - tile.askedAt > CALM_AFTER_MS) this.tiles.delete(url);
      } else if (tile.dueAt <= now) {
        tile.dueAt = null;
        tile.askedAt = now;
        urls.add(url);
      }
    }
    return urls.size > 0 ? urls : null;
  }

  /** All that are missing, to ask for right now and as if for the first time: someone wants Photoreal back. */
  restart(): ReadonlySet<string> {
    const urls = new Set<string>();
    for (const [url, tile] of this.tiles) if (tile.dueAt !== null) urls.add(url);
    this.tiles.clear();
    this.told = false;
    return urls;
  }
}
