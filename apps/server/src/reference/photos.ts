import { type FetchLike, fetchJson } from '../providers/http';

/**
 * Aircraft photos from the planespotters.net public API, looked up by ICAO hex.
 * Checked live on 2026-11-24: `GET https://api.planespotters.net/pub/photos/hex/{hex}` answers
 * `{ photos: [{ id, thumbnail, thumbnail_large, link, photographer }] }` with `Cache-Control: max-age=3600`,
 * and refuses generic User-Agents with 403. Every photo shown must credit the photographer and link back.
 */
export const PLANESPOTTERS_URL = 'https://api.planespotters.net/pub/photos/hex';

export interface AircraftPhoto {
  thumbnail: string;
  width: number | null;
  height: number | null;
  /** Page on planespotters.net the thumbnail must link to. */
  link: string;
  photographer: string;
}

export function parsePhotoResponse(json: unknown): AircraftPhoto | null {
  const photos = (json as { photos?: unknown } | null)?.photos;
  if (!Array.isArray(photos)) return null;
  const first = photos[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  const image = (first.thumbnail_large ?? first.thumbnail) as
    | { src?: unknown; size?: { width?: unknown; height?: unknown } }
    | undefined;
  if (!image || typeof image.src !== 'string' || typeof first.link !== 'string') return null;
  // Only ever hand the browser https URLs.
  if (!image.src.startsWith('https://') || !first.link.startsWith('https://')) return null;
  return {
    thumbnail: image.src,
    width: typeof image.size?.width === 'number' ? image.size.width : null,
    height: typeof image.size?.height === 'number' ? image.size.height : null,
    link: first.link,
    photographer: typeof first.photographer === 'string' ? first.photographer : 'unknown',
  };
}

export interface PhotoServiceOptions {
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
}

/** Looks photos up on demand and remembers the answer (including "no photo") in memory. */
export class PhotoService {
  private readonly cache = new Map<string, { photo: AircraftPhoto | null; at: number }>();
  private readonly inFlight = new Map<string, Promise<AircraftPhoto | null>>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;

  constructor(private readonly options: PhotoServiceOptions) {
    this.now = options.now ?? Date.now;
    this.ttlMs = options.ttlMs ?? 6 * 3_600_000;
    this.maxEntries = options.maxEntries ?? 2000;
  }

  get(hex: string): Promise<AircraftPhoto | null> {
    const key = hex.toLowerCase();
    const cached = this.cache.get(key);
    if (cached && this.now() - cached.at < this.ttlMs) return Promise.resolve(cached.photo);
    const running = this.inFlight.get(key);
    if (running) return running;

    const request = fetchJson({
      url: `${PLANESPOTTERS_URL}/${key}`,
      userAgent: this.options.userAgent,
      fetchImpl: this.options.fetchImpl,
      now: this.now,
      timeoutMs: 8000,
    })
      .then((res) => parsePhotoResponse(res.json))
      // A failed lookup is remembered as "no photo" too, so a broken upstream is not asked on every click.
      .catch(() => null)
      .then((photo) => {
        if (this.cache.size >= this.maxEntries) {
          const oldest = this.cache.keys().next().value;
          if (oldest !== undefined) this.cache.delete(oldest);
        }
        this.cache.set(key, { photo, at: this.now() });
        return photo;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });
    this.inFlight.set(key, request);
    return request;
  }
}
