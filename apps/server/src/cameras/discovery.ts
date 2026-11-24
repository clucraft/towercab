import { distanceM } from '@towercab/shared';
import { z } from 'zod';
import { type FetchLike, fetchJson } from '../providers/http';
import type { DiscoveryResult } from './store';

/**
 * Camera discovery: asks YouTube for live videos and Windy for webcams near an airport. Everything found
 * goes into the approval queue; nothing is shown to viewers until an admin approves it.
 *
 * The request and response shapes follow the providers' documentation as read on 2026-11-24. The error
 * responses were checked against the live services (fixtures `youtube-error-*.json`, `windy-error-*.json`);
 * successful responses could not be, for want of API keys, so the parsers accept only what they need and
 * ignore the rest. See docs/DECISIONS.md.
 */
export interface DiscoveryAirport {
  icao: string;
  name: string;
  city?: string;
  lat: number;
  lon: number;
}

interface Common {
  userAgent: string;
  fetchImpl?: FetchLike;
}

// ---- YouTube Data API v3, search.list ----

export const YOUTUBE_SEARCH_URL = 'https://www.googleapis.com/youtube/v3/search';

const YouTubeSearchSchema = z.object({
  items: z
    .array(
      z.object({
        id: z.object({ videoId: z.string().optional() }).optional(),
        snippet: z
          .object({
            title: z.string().optional(),
            description: z.string().optional(),
            channelTitle: z.string().optional(),
            liveBroadcastContent: z.string().optional(),
            thumbnails: z.record(z.string(), z.object({ url: z.string() }).partial()).optional(),
          })
          .optional(),
      }),
    )
    .default([]),
});

/** search.list returns titles with HTML entities in them. */
export function decodeEntities(text: string): string {
  return text
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, code: string) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** The searches run for one airport: one by location, the rest by keyword. */
export function youtubeQueries(airport: DiscoveryAirport): { label: string; q?: string; near: boolean }[] {
  const queries: { label: string; q?: string; near: boolean }[] = [
    { label: 'live near the airport', near: true },
    { label: `"${airport.icao} live"`, q: `${airport.icao} live`, near: false },
  ];
  if (airport.city) {
    queries.push({ label: `"${airport.city} airport live"`, q: `${airport.city} airport live`, near: false });
    queries.push({
      label: `"plane spotting ${airport.city}"`,
      q: `plane spotting ${airport.city}`,
      near: false,
    });
  }
  return queries;
}

export function parseYouTubeSearch(json: unknown, airport: string, foundBy: string): DiscoveryResult[] {
  const parsed = YouTubeSearchSchema.parse(json);
  const out: DiscoveryResult[] = [];
  for (const item of parsed.items) {
    const videoId = item.id?.videoId;
    // Only videos that are live now; a search can also return upcoming streams and channels.
    if (!videoId || !/^[A-Za-z0-9_-]{11}$/.test(videoId)) continue;
    if (item.snippet?.liveBroadcastContent && item.snippet.liveBroadcastContent !== 'live') continue;
    const thumbs = item.snippet?.thumbnails ?? {};
    const thumbnail = thumbs.medium?.url ?? thumbs.high?.url ?? thumbs.default?.url;
    const channel = item.snippet?.channelTitle ? decodeEntities(item.snippet.channelTitle) : undefined;
    out.push({
      id: `yt-${videoId}`,
      airport,
      provider: 'youtube',
      externalId: videoId,
      name: decodeEntities(item.snippet?.title ?? `YouTube live ${videoId}`).slice(0, 120),
      kind: 'youtube',
      source: videoId,
      attribution: channel ? `${channel} on YouTube` : 'YouTube',
      link: `https://www.youtube.com/watch?v=${videoId}`,
      thumbnail,
      detail: {
        channel,
        description: item.snippet?.description
          ? decodeEntities(item.snippet.description).slice(0, 300)
          : undefined,
        foundBy,
      },
    });
  }
  return out;
}

export interface YouTubeOptions extends Common {
  apiKey: string;
  radiusKm: number;
}

/** Runs the searches for one airport. Each is one call to search.list. Results are merged by video. */
export async function searchYouTube(
  airport: DiscoveryAirport,
  options: YouTubeOptions,
): Promise<DiscoveryResult[]> {
  const byId = new Map<string, DiscoveryResult>();
  for (const query of youtubeQueries(airport)) {
    const params = new URLSearchParams({
      part: 'snippet',
      type: 'video',
      eventType: 'live',
      maxResults: '25',
    });
    if (query.q) params.set('q', query.q);
    if (query.near) {
      params.set('location', `${airport.lat.toFixed(5)},${airport.lon.toFixed(5)}`);
      params.set('locationRadius', `${Math.round(options.radiusKm)}km`);
    }
    const res = await fetchJson({
      url: `${YOUTUBE_SEARCH_URL}?${params}`,
      userAgent: options.userAgent,
      // The key travels in a header, not in the address, so it cannot end up in a log line.
      headers: { 'X-Goog-Api-Key': options.apiKey },
      fetchImpl: options.fetchImpl,
      timeoutMs: 15_000,
    });
    for (const found of parseYouTubeSearch(res.json, airport.icao, query.label)) {
      // The location search is the stronger evidence; keep its entry when a keyword search finds the same video.
      if (!byId.has(found.id)) byId.set(found.id, found);
    }
  }
  return [...byId.values()];
}

// ---- Windy Webcams API v3 ----

export const WINDY_WEBCAMS_URL = 'https://api.windy.com/webcams/api/v3/webcams';
/** The courtesy line Windy's terms ask for wherever its webcams are shown. */
export const WINDY_ATTRIBUTION = 'Webcams provided by Windy.com';

const WindyWebcamSchema = z.object({
  webcamId: z.union([z.number(), z.string()]),
  title: z.string().optional(),
  status: z.string().optional(),
  images: z
    .object({
      current: z
        .object({ icon: z.string(), thumbnail: z.string(), preview: z.string() })
        .partial()
        .optional(),
    })
    .optional(),
  location: z.object({ latitude: z.number(), longitude: z.number(), city: z.string() }).partial().optional(),
  urls: z.object({ detail: z.string(), provider: z.string() }).partial().optional(),
});
type WindyWebcam = z.infer<typeof WindyWebcamSchema>;
const WindyListSchema = z.object({ webcams: z.array(WindyWebcamSchema).default([]) });

export function parseWindyWebcams(json: unknown, airport: DiscoveryAirport): DiscoveryResult[] {
  const out: DiscoveryResult[] = [];
  for (const cam of WindyListSchema.parse(json).webcams) {
    const id = String(cam.webcamId);
    if (!/^\d{1,12}$/.test(id)) continue;
    if (cam.status && cam.status !== 'active') continue;
    // Every image has to link to the webcam's page on Windy; without that address it cannot be shown.
    const link = cam.urls?.detail;
    if (!link || !/^https:\/\//.test(link)) continue;
    const { latitude, longitude } = cam.location ?? {};
    const distanceKm =
      latitude !== undefined && longitude !== undefined
        ? Math.round(distanceM(airport.lat, airport.lon, latitude, longitude) / 100) / 10
        : undefined;
    out.push({
      id: `windy-${id}`,
      airport: airport.icao,
      provider: 'windy',
      externalId: id,
      name: (cam.title ?? `Windy webcam ${id}`).slice(0, 120),
      kind: 'snapshot',
      source: `windy:${id}`,
      attribution: WINDY_ATTRIBUTION,
      link,
      detail: { distanceKm, foundBy: 'near the airport' },
    });
  }
  return out;
}

export interface WindyOptions extends Common {
  apiKey: string;
  radiusKm: number;
}

export async function searchWindy(
  airport: DiscoveryAirport,
  options: WindyOptions,
): Promise<DiscoveryResult[]> {
  const params = new URLSearchParams({
    nearby: `${airport.lat.toFixed(4)},${airport.lon.toFixed(4)},${Math.round(options.radiusKm)}`,
    include: 'images,location,urls',
    limit: '50',
  });
  const res = await fetchJson({
    url: `${WINDY_WEBCAMS_URL}?${params}`,
    userAgent: options.userAgent,
    headers: { 'x-windy-api-key': options.apiKey },
    fetchImpl: options.fetchImpl,
    timeoutMs: 15_000,
  });
  return parseWindyWebcams(res.json, airport);
}

/**
 * Current image addresses for Windy webcams. On the free tier an address stops working about ten minutes
 * after it was issued, so the server asks again when its copy is eight minutes old, and only while somebody
 * is actually looking at that webcam. The browser loads the image from Windy itself, as the terms require.
 */
export class WindyImages {
  private readonly cache = new Map<string, { url: string; fetchedAt: number }>();
  private readonly pending = new Map<string, Promise<string | null>>();

  constructor(
    private readonly options: Common & {
      apiKey: () => string | undefined;
      now?: () => number;
      maxAgeMs?: number;
    },
  ) {}

  get available(): boolean {
    return Boolean(this.options.apiKey());
  }

  /** The webcam's current image address, or null when Windy has none (or there is no key). */
  async imageUrl(webcamId: string): Promise<string | null> {
    const apiKey = this.options.apiKey();
    if (!apiKey || !/^\d{1,12}$/.test(webcamId)) return null;
    const now = (this.options.now ?? Date.now)();
    const cached = this.cache.get(webcamId);
    if (cached && now - cached.fetchedAt < (this.options.maxAgeMs ?? 8 * 60_000)) return cached.url;
    // Several viewers asking at once share one request.
    let request = this.pending.get(webcamId);
    if (!request) {
      request = this.fetchOne(webcamId, apiKey, now).finally(() => this.pending.delete(webcamId));
      this.pending.set(webcamId, request);
    }
    return request;
  }

  private async fetchOne(webcamId: string, apiKey: string, now: number): Promise<string | null> {
    const res = await fetchJson({
      url: `${WINDY_WEBCAMS_URL}/${webcamId}?include=images`,
      userAgent: this.options.userAgent,
      headers: { 'x-windy-api-key': apiKey },
      fetchImpl: this.options.fetchImpl,
      timeoutMs: 10_000,
    });
    const single = WindyWebcamSchema.safeParse(res.json);
    const cam: WindyWebcam | undefined = single.success
      ? single.data
      : WindyListSchema.safeParse(res.json).data?.webcams[0];
    const url = cam?.images?.current?.preview ?? cam?.images?.current?.thumbnail ?? null;
    if (url && /^https:\/\//.test(url)) {
      this.cache.set(webcamId, { url, fetchedAt: now });
      return url;
    }
    return null;
  }
}
