import { levelFromSamples } from './level';

export type PlayerState = 'tuning' | 'on' | 'error';

/** Stream types fed in piece by piece when the browser can (Media Source Extensions). */
const FED_TYPES = new Set(['audio/mpeg', 'audio/aac']);
/** Playing starts once this much is in hand. */
const START_AHEAD_S = 1;
/** Further behind the stream than this, playing jumps to just behind its newest sound. */
const MAX_AHEAD_S = 8;
const CATCH_UP_TO_S = 1.5;
/** Sound played longer ago than this is let go. */
const KEEP_BEHIND_S = 20;

export interface PlayerOptions {
  /** The address to load. Called again for every request: some servers want a new address each time. */
  url(): string;
  /** The stream comes from the page's own origin, so the plain way can be measured too. */
  sameOrigin: boolean;
  volume: number;
  /** The page's audio context, made on first use. Null where there is no Web Audio. */
  context(): AudioContext | null;
  report(state: PlayerState, error?: string): void;
}

interface Graph {
  analyser: AnalyserNode;
  gain: GainNode;
  samples: Uint8Array<ArrayBuffer>;
  disconnect(): void;
}

export function canFeed(type = 'audio/mpeg'): boolean {
  return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type);
}

/**
 * One live stream, from pressing play to pressing stop.
 *
 * A plain audio element wants a good deal of a stream before it starts: about 30 s of LiveATC's 8 kbps feeds
 * (tried on 2026-11-25). So where the browser can, the stream is fetched here and fed to the element as it
 * arrives, which starts within a second of the first sound, as LiveATC's own player does. Fed this way the sound
 * is on the page's origin and the meter can measure it. Where the browser cannot, or the stream's server does
 * not allow it to be fetched from another site, the element plays the address itself.
 */
export class StreamPlayer {
  private element: HTMLAudioElement | null = null;
  private graph: Graph | null = null;
  private readonly abort = new AbortController();
  private objectUrl: string | null = null;
  private stopped = false;
  private failed = false;
  private volume: number;

  constructor(private readonly options: PlayerOptions) {
    this.volume = options.volume;
  }

  /** Call from the click that asked for it: browsers allow sound to start only then. */
  start(): void {
    this.options.report('tuning');
    if (canFeed()) {
      const element = this.newElement(true);
      const source = new MediaSource();
      this.objectUrl = URL.createObjectURL(source);
      element.src = this.objectUrl;
      // Played and paused at once, inside the click: the element may then be played again once there is enough
      // of the stream, which can be seconds later.
      element.play().catch(() => {});
      element.pause();
      void this.feed(element, source);
    } else {
      this.plain();
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.abort.abort();
    this.release();
  }

  setVolume(volume: number): void {
    this.volume = volume;
    if (this.graph) this.graph.gain.gain.value = volume;
    else if (this.element) this.element.volume = volume;
  }

  /** 0 to 1, or null when the sound cannot be measured. */
  level(): number | null {
    const g = this.graph;
    if (!g) return null;
    g.analyser.getByteTimeDomainData(g.samples);
    return levelFromSamples(g.samples);
  }

  private async feed(element: HTMLAudioElement, source: MediaSource): Promise<void> {
    let response: Response;
    try {
      [response] = await Promise.all([
        fetch(this.options.url(), { signal: this.abort.signal, cache: 'no-store' }),
        new Promise((resolve) => source.addEventListener('sourceopen', resolve, { once: true })),
      ]);
    } catch {
      // Refused (no CORS headers) or unreachable: let the element try the address itself.
      if (!this.stopped) this.plain();
      return;
    }
    if (this.stopped || element !== this.element) return;
    const type = (response.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase() ?? '';
    if (!response.ok) {
      void response.body?.cancel();
      this.fail('No signal from this station.');
      return;
    }
    if (!response.body || !FED_TYPES.has(type) || !canFeed(type)) {
      void response.body?.cancel();
      this.plain();
      return;
    }

    const buffer = source.addSourceBuffer(type);
    buffer.mode = 'sequence';
    const pending: Uint8Array[] = [];
    let started = false;
    /** The stream has ended: what is in hand is played out, then the element says it has ended. */
    let finished = false;

    const ahead = () => {
      const ranges = buffer.buffered;
      return ranges.length ? ranges.end(ranges.length - 1) - element.currentTime : 0;
    };
    const next = () => {
      if (this.stopped || buffer.updating) return;
      const ranges = buffer.buffered;
      if (ranges.length) {
        const end = ranges.end(ranges.length - 1);
        // Live and fallen behind (servers send a burst of the last seconds on connecting): catch up.
        if (started && !finished && end - element.currentTime > MAX_AHEAD_S) {
          element.currentTime = end - CATCH_UP_TO_S;
        }
        const first = ranges.start(0);
        if (element.currentTime - first > KEEP_BEHIND_S) {
          buffer.remove(first, element.currentTime - KEEP_BEHIND_S / 2);
          return;
        }
      }
      if (!started && (ahead() >= START_AHEAD_S || (finished && ahead() > 0))) {
        started = true;
        this.play(element);
      }
      if (pending.length === 0) {
        if (finished && source.readyState === 'open') source.endOfStream();
        return;
      }
      const size = pending.reduce((n, p) => n + p.length, 0);
      const joined = new Uint8Array(size);
      let at = 0;
      for (const piece of pending.splice(0)) {
        joined.set(piece, at);
        at += piece.length;
      }
      try {
        buffer.appendBuffer(joined);
      } catch {
        // Full: let go of what has been played and try again with the next piece.
        pending.unshift(joined);
        if (ranges.length && element.currentTime > ranges.start(0) + 1)
          buffer.remove(ranges.start(0), element.currentTime - 1);
      }
    };
    buffer.addEventListener('updateend', next);

    const reader = response.body.getReader();
    let received = 0;
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        if (this.stopped) return;
        received += value.length;
        pending.push(value);
        next();
      }
      if (this.stopped) return;
      finished = true;
      // Nothing at all came: there is nothing to play out. Otherwise the last piece may still be going in.
      if (received === 0) this.fail('The station stopped sending.');
      else next();
    } catch {
      if (!this.stopped) this.fail('The station stopped sending.');
    }
  }

  /** The element loads the address itself. Measured only on the page's own origin. */
  private plain(): void {
    this.release();
    const element = this.newElement(this.options.sameOrigin);
    element.src = this.options.url();
    this.play(element);
  }

  private newElement(measure: boolean): HTMLAudioElement {
    const element = new Audio();
    element.preload = 'none';
    this.element = element;
    const mine = () => !this.stopped && this.element === element;
    element.addEventListener('playing', () => {
      if (mine()) this.options.report('on');
    });
    element.addEventListener('waiting', () => {
      if (mine()) this.options.report('tuning');
    });
    element.addEventListener('error', () => {
      if (mine()) this.fail('No signal from this station.');
    });
    element.addEventListener('ended', () => {
      if (mine()) this.fail('The station stopped sending.');
    });
    // Sound from another origin must not go through Web Audio: without CORS headers it would come out silent.
    const ctx = measure ? this.options.context() : null;
    if (ctx) {
      try {
        const source = ctx.createMediaElementSource(element);
        const analyser = ctx.createAnalyser();
        analyser.fftSize = 1024;
        const gain = ctx.createGain();
        gain.gain.value = this.volume;
        source.connect(analyser);
        source.connect(gain);
        gain.connect(ctx.destination);
        void ctx.resume();
        this.graph = {
          analyser,
          gain,
          samples: new Uint8Array(new ArrayBuffer(analyser.fftSize)),
          disconnect: () => {
            source.disconnect();
            gain.disconnect();
          },
        };
      } catch {
        this.graph = null;
      }
    }
    if (!this.graph) element.volume = this.volume;
    return element;
  }

  private play(element: HTMLAudioElement): void {
    element.play().catch((err: Error) => {
      if (this.stopped || this.element !== element) return;
      // Aborted by a new source being set is expected; anything else is worth saying.
      if (err.name === 'AbortError') return;
      this.fail(
        err.name === 'NotAllowedError'
          ? 'The browser did not allow playing. Press play again.'
          : 'No signal from this station.',
      );
    });
  }

  private fail(message: string): void {
    if (this.failed || this.stopped) return;
    this.failed = true;
    this.options.report('error', message);
    this.abort.abort();
    this.release();
  }

  private release(): void {
    const element = this.element;
    this.element = null;
    if (element) {
      element.pause();
      // Without a source the element closes its connection; `pause` alone would keep downloading.
      element.removeAttribute('src');
      element.load();
    }
    this.graph?.disconnect();
    this.graph = null;
    if (this.objectUrl) URL.revokeObjectURL(this.objectUrl);
    this.objectUrl = null;
  }
}
