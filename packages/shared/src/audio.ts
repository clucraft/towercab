import { z } from 'zod';

/**
 * A radio station for one airport: an audio stream the browser plays, such as a receiver of your own
 * streaming to Icecast. See docs/RADIO.md.
 */
export const AudioStationSchema = z.object({
  /** What the radio shows, e.g. "Purdue Tower". */
  name: z.string().trim().min(1).max(40),
  /** The frequency as written on charts, e.g. "118.300". Shown on the radio, nothing more. */
  frequency: z.string().trim().min(1).max(20).optional(),
  /** The stream: an Icecast or Shoutcast mount (MP3 or AAC), or anything else a browser's audio element plays. */
  url: z.url({ protocol: /^https?$/, error: 'expected an http or https address' }),
  /**
   * Fetch the stream through this server. Needed for a receiver on your own network, which visitors cannot
   * reach, and for a plain http stream on an https site. Only hosts on `proxy.allowlist`.
   */
  proxy: z.boolean().default(false),
  /** Credit shown under the radio, e.g. who runs the receiver. */
  attribution: z.string().trim().min(1).max(120).optional(),
  /** Where the credit links to. */
  link: z.url().optional(),
});
export type AudioStation = z.infer<typeof AudioStationSchema>;
export type AudioStationInput = z.input<typeof AudioStationSchema>;

/** How many stations one airport may have. */
export const MAX_AUDIO_STATIONS = 8;

/** A station as the browser gets it with the airport. */
export interface PublicAudioStation {
  name: string;
  frequency?: string;
  /** What the audio element loads: the stream's own address, or a path on this server when it is proxied. */
  src: string;
  /** The stream comes through this server, from the same origin as the page. */
  proxied: boolean;
  attribution?: string;
  link?: string;
}

/**
 * Streams from LiveATC.net. Their terms of use set conditions on these; see docs/RADIO.md. (The host is taken
 * out by hand: this package runs in the browser and in Node alike and leans on neither.)
 */
export function isLiveAtcUrl(url: string | { href: string }): boolean {
  const href = typeof url === 'string' ? url : url.href;
  const host = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/?#]*@)?([^:/?#]+)/i.exec(href.trim())?.[1]?.toLowerCase();
  if (!host) return false;
  const bare = host.endsWith('.') ? host.slice(0, -1) : host;
  return bare === 'liveatc.net' || bare.endsWith('.liveatc.net');
}

/**
 * The address to load for a station right now. LiveATC's stream servers answer only a request whose address is
 * new: the same address again hangs and is then reset (tried on 2026-11-25), and their own player adds a fresh
 * `nocache` value every time. So does this, for their streams only.
 */
export function streamUrlNow(station: Pick<PublicAudioStation, 'src' | 'proxied'>, now = Date.now()): string {
  if (station.proxied || !isLiveAtcUrl(station.src)) return station.src;
  const separator = station.src.includes('?') ? '&' : '?';
  return `${station.src}${separator}nocache=${now}`;
}

/** The path under which this server passes on a proxied station. */
export function audioProxyPath(icao: string, index: number): string {
  return `/proxy/audio/${encodeURIComponent(icao)}/${index}`;
}

/** Turns configured stations into what the browser is given. */
export function publicAudioStations(icao: string, stations: readonly AudioStation[]): PublicAudioStation[] {
  return stations.map((s, i) => {
    const out: PublicAudioStation = {
      name: s.name,
      src: s.proxy ? audioProxyPath(icao, i) : s.url,
      proxied: s.proxy,
    };
    if (s.frequency) out.frequency = s.frequency;
    if (s.attribution) out.attribution = s.attribution;
    if (s.link) out.link = s.link;
    // LiveATC asks for a prominent credit wherever its streams are used (terms of use, 3.15).
    if (isLiveAtcUrl(s.url)) {
      out.attribution ??= 'Audio from LiveATC.net';
      out.link ??= 'https://www.liveatc.net';
    }
    return out;
  });
}
