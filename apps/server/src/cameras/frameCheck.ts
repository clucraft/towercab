import type { FetchLike } from '../providers/http';

/**
 * Whether a page's response headers forbid showing it in a frame on `embedder` (this app's public origin,
 * when known). A browser gives a page no way to find this out for itself: a refused frame just stays blank.
 * So the server looks at the headers, and the player offers "Open in new tab" instead of a blank box.
 */
export function framingBlocked(headers: Headers, embedder?: URL): boolean {
  // `frame-ancestors` replaces X-Frame-Options when both are sent.
  const policies = (headers.get('content-security-policy') ?? '')
    .split(',')
    .flatMap((policy) => policy.split(';'))
    .map((directive) => directive.trim().split(/\s+/))
    .filter((words) => words[0]?.toLowerCase() === 'frame-ancestors');
  if (policies.length > 0) {
    // Every policy has to allow it.
    return !policies.every((words) => words.slice(1).some((source) => sourceAllows(source, embedder)));
  }
  const xfo = (headers.get('x-frame-options') ?? '').trim().toLowerCase();
  // DENY, SAMEORIGIN, and the obsolete ALLOW-FROM (which browsers treat as no permission) all refuse us.
  return xfo !== '';
}

function sourceAllows(source: string, embedder?: URL): boolean {
  const s = source.toLowerCase();
  if (s === '*') return true;
  if (s === "'none'" || s === "'self'") return false;
  if (s === 'https:' || s === 'http:') return embedder ? embedder.protocol === s : true;
  if (!embedder) return false;
  // A host source: [scheme://]host[:port], where the host may start with "*.".
  const match = /^(?:([a-z][a-z0-9+.-]*):\/\/)?([^/:]+)(?::(\d+|\*))?/.exec(s);
  if (!match) return false;
  const [, scheme, host, port] = match;
  if (scheme && `${scheme}:` !== embedder.protocol) return false;
  if (port && port !== '*' && port !== (embedder.port || (embedder.protocol === 'https:' ? '443' : '80'))) {
    return false;
  }
  const name = embedder.hostname.toLowerCase();
  return host?.startsWith('*.') ? name.endsWith(host.slice(1)) : name === host;
}

export interface FrameCheckerOptions {
  userAgent: string;
  fetchImpl?: FetchLike;
  /** This app's public address, from `PUBLIC_URL`. */
  publicUrl?: string;
  now?: () => number;
  ttlMs?: number;
  timeoutMs?: number;
}

/** Looks up, once in a while, whether each `iframe` camera's page may be framed. */
export class FrameChecker {
  private readonly known = new Map<string, { blocked: boolean; at: number }>();
  private readonly pending = new Map<string, Promise<boolean>>();
  private readonly embedder: URL | undefined;

  constructor(private readonly options: FrameCheckerOptions) {
    this.embedder = options.publicUrl ? new URL(options.publicUrl) : undefined;
  }

  /** The answer if there is a fresh one. */
  cached(url: string): boolean | undefined {
    const entry = this.known.get(url);
    if (!entry) return undefined;
    const now = (this.options.now ?? Date.now)();
    return now - entry.at < (this.options.ttlMs ?? 6 * 3600_000) ? entry.blocked : undefined;
  }

  /**
   * Asks the page for its headers. A page that cannot be reached is not called blocked: the browser may
   * well reach it (it may be on the viewer's network), and the player has its own time-out as a fallback.
   */
  check(url: string): Promise<boolean> {
    const fresh = this.cached(url);
    if (fresh !== undefined) return Promise.resolve(fresh);
    let request = this.pending.get(url);
    if (!request) {
      request = this.fetchHeaders(url).finally(() => this.pending.delete(url));
      this.pending.set(url, request);
    }
    return request;
  }

  private async fetchHeaders(url: string): Promise<boolean> {
    const fetchImpl = this.options.fetchImpl ?? (globalThis.fetch as FetchLike);
    let blocked = false;
    try {
      const res = await fetchImpl(url, {
        method: 'GET',
        redirect: 'follow',
        signal: AbortSignal.timeout(this.options.timeoutMs ?? 4000),
        headers: { 'User-Agent': this.options.userAgent, Accept: 'text/html,*/*' },
      });
      blocked = framingBlocked(res.headers, this.embedder);
      // Only the headers matter.
      void res.body?.cancel().catch(() => undefined);
    } catch {
      blocked = false;
    }
    this.known.set(url, { blocked, at: (this.options.now ?? Date.now)() });
    return blocked;
  }
}
