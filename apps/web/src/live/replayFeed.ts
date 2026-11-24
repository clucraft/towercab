import type { Aircraft, AirportStatus, ServerMessage, TrailPoint } from '@towercab/shared';
import type { Feed, FeedFactory } from './store';

/**
 * Replay of a recorded session (`?replay=<name>`), so the app can be shown and worked on with nothing flying.
 *
 * A recording is a JSON Lines file made by `scripts/record.ts`: a `meta` line, then the server's own
 * messages exactly as they were sent. Playback sends them again with the same spacing, moved to the present:
 * every timestamp in a message is shifted by the same amount, so the scene cannot tell a replay from live
 * data. At the end the recording starts over.
 */

export interface ReplayMeta {
  type: 'meta';
  version: 1;
  airport: string;
  /** When the recording was made, epoch ms. */
  recordedAt: number;
  /** Where the positions came from, and the licence they are redistributed under. */
  sources: string[];
  license: string;
  /** Spacing of the recorded positions, when it is wider than the live feed's. */
  intervalMs?: number;
  note?: string;
}

export interface Recording {
  meta: ReplayMeta;
  messages: ServerMessage[];
}

/** Parses a recording. Lines that are not valid JSON are skipped; a recording with no snapshot is refused. */
export function parseRecording(text: string): Recording {
  let meta: ReplayMeta | null = null;
  const messages: ServerMessage[] = [];
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const type = (value as { type?: unknown }).type;
    if (type === 'meta') meta = value as ReplayMeta;
    else if (type === 'snapshot' || type === 'delta' || type === 'status')
      messages.push(value as ServerMessage);
  }
  const first = messages.findIndex((m) => m.type === 'snapshot');
  if (!meta || first === -1) throw new Error('not a TowerCab recording: it needs a meta line and a snapshot');
  return { meta, messages: messages.slice(first) };
}

const shiftAircraft = (a: Aircraft, by: number): Aircraft => ({
  ...a,
  posTime: a.posTime + by,
  seenTime: a.seenTime + by,
  source: 'replay',
});

function shiftStatus(status: AirportStatus, by: number): AirportStatus {
  return {
    ...status,
    lastPollAt: status.lastPollAt === undefined ? undefined : status.lastPollAt + by,
    providers: status.providers.map((p) => ({
      ...p,
      lastSuccessAt: p.lastSuccessAt === undefined ? undefined : p.lastSuccessAt + by,
      lastErrorAt: p.lastErrorAt === undefined ? undefined : p.lastErrorAt + by,
      backoffUntil: p.backoffUntil === undefined ? undefined : p.backoffUntil + by,
    })),
  };
}

/** Moves every timestamp in a message by `by` milliseconds and renumbers it. */
export function shiftMessage(message: ServerMessage, by: number, seq: number): ServerMessage {
  switch (message.type) {
    case 'snapshot': {
      const trails: Record<string, TrailPoint[]> = {};
      for (const [hex, points] of Object.entries(message.trails)) {
        trails[hex] = points.map(([t, lat, lon, h]) => [t + by, lat, lon, h]);
      }
      return {
        ...message,
        serverTime: message.serverTime + by,
        seq,
        aircraft: message.aircraft.map((a) => shiftAircraft(a, by)),
        trails,
        status: shiftStatus(message.status, by),
      };
    }
    case 'delta':
      return {
        ...message,
        serverTime: message.serverTime + by,
        seq,
        upserts: message.upserts.map((a) => shiftAircraft(a, by)),
      };
    case 'status':
      return { ...message, serverTime: message.serverTime + by, status: shiftStatus(message.status, by) };
    default:
      return { ...message, serverTime: message.serverTime + by };
  }
}

export interface ReplayOptions {
  /** Loads the recording text. The default fetches `/replays/<name>.jsonl`. */
  load?: (name: string) => Promise<string>;
  now?: () => number;
  /** Pause between the end of the recording and its restart. */
  loopGapMs?: number;
}

const defaultLoad = async (name: string): Promise<string> => {
  const res = await fetch(`/replays/${encodeURIComponent(name)}.jsonl`);
  if (!res.ok) throw new Error(`there is no recording called "${name}"`);
  return res.text();
};

export function replayFeed(name: string, options: ReplayOptions = {}): FeedFactory {
  const now = options.now ?? Date.now;
  const load = options.load ?? defaultLoad;
  const loopGapMs = options.loopGapMs ?? 1500;

  return (handlers): Feed => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    let renderDelayMs: number | undefined;

    const play = (recording: Recording, icao: string) => {
      const { messages } = recording;
      const first = messages[0] as ServerMessage;
      let shift = now() - first.serverTime;
      let index = 0;
      let seq = 0;

      const step = () => {
        timer = null;
        if (stopped) return;
        // Send everything that is due.
        while (index < messages.length && (messages[index] as ServerMessage).serverTime + shift <= now()) {
          const original = messages[index] as ServerMessage;
          index += 1;
          if (original.type === 'snapshot') {
            // A snapshot in the middle of a recording (a reconnect while recording) restarts numbering.
            seq = 0;
          } else if (original.type === 'delta') {
            seq += 1;
          }
          const message = shiftMessage({ ...original, icao } as ServerMessage, shift, seq);
          if (message.type === 'snapshot') {
            handlers.onSnapshot?.(message);
            handlers.onStatus?.(icao, message.status);
          } else if (message.type === 'delta') handlers.onDelta?.(message);
          else if (message.type === 'status') handlers.onStatus?.(icao, message.status);
        }
        if (index >= messages.length) {
          // Start over, as if the first message were happening a moment from now.
          index = 0;
          shift = now() + loopGapMs - first.serverTime;
          timer = setTimeout(step, loopGapMs);
          return;
        }
        const wait = (messages[index] as ServerMessage).serverTime + shift - now();
        timer = setTimeout(step, Math.max(10, Math.min(wait, 1000)));
      };
      step();
    };

    return {
      start(icao) {
        stopped = false;
        handlers.onState?.('connecting');
        load(name).then(
          (text) => {
            if (stopped) return;
            let recording: Recording;
            try {
              recording = parseRecording(text);
            } catch (err) {
              handlers.onState?.('closed');
              handlers.onError?.({
                type: 'error',
                serverTime: now(),
                code: 'airport_unavailable',
                message: (err as Error).message,
              });
              return;
            }
            // Draw far enough behind that there is always a later position to move towards.
            const spacing = recording.meta.intervalMs;
            renderDelayMs = spacing && spacing > 2000 ? spacing + 1500 : undefined;
            handlers.onState?.('open');
            play(recording, icao);
          },
          (err: Error) => {
            handlers.onState?.('closed');
            handlers.onError?.({
              type: 'error',
              serverTime: now(),
              code: 'airport_unavailable',
              message: err.message,
            });
          },
        );
      },
      stop() {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        handlers.onState?.('closed');
      },
      serverNow: () => now(),
      renderDelayMs: () => renderDelayMs,
    };
  };
}
