import { ProviderError, type RateInfo } from './types';

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface HttpJsonRequest {
  url: string;
  userAgent: string;
  headers?: Record<string, string>;
  method?: 'GET' | 'POST';
  body?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: FetchLike;
  now?: () => number;
}

export interface HttpJsonResponse {
  status: number;
  json: unknown;
  headers: Headers;
  receivedAt: number;
  latencyMs: number;
  rate: RateInfo | undefined;
}

/**
 * GET (or POST) a JSON document. Every failure becomes a `ProviderError` with a kind the backoff logic can
 * act on, and any retry-after or quota headers attached.
 */
export async function fetchJson(req: HttpJsonRequest): Promise<HttpJsonResponse> {
  const now = req.now ?? Date.now;
  const fetchImpl = req.fetchImpl ?? (globalThis.fetch as FetchLike);
  const timeout = AbortSignal.timeout(req.timeoutMs ?? 8000);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;
  const startedAt = now();

  let res: Response;
  try {
    res = await fetchImpl(req.url, {
      method: req.method ?? 'GET',
      body: req.body,
      signal,
      redirect: 'follow',
      headers: { Accept: 'application/json', 'User-Agent': req.userAgent, ...req.headers },
    });
  } catch (err) {
    const e = err as Error;
    if (e.name === 'TimeoutError' || timeout.aborted) {
      throw new ProviderError('timeout', `no answer within ${req.timeoutMs ?? 8000} ms`);
    }
    if (e.name === 'AbortError') throw new ProviderError('network', 'request aborted');
    const cause = (e as { cause?: { code?: string; message?: string } }).cause;
    throw new ProviderError('network', cause?.code ?? cause?.message ?? e.message);
  }

  const receivedAt = now();
  const rate = parseRateHeaders(res.headers, receivedAt);
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const detail = summarise(text);
    const details = { status: res.status, retryAfterMs: parseRetryAfter(res.headers, receivedAt), rate };
    const message = `HTTP ${res.status}${detail ? `: ${detail}` : ''}`;
    if (res.status === 429) throw new ProviderError('rate_limited', message, details);
    if (res.status === 401 || res.status === 403) throw new ProviderError('forbidden', message, details);
    if (res.status >= 500) throw new ProviderError('server', message, details);
    throw new ProviderError('bad_request', message, details);
  }

  let json: unknown;
  try {
    json = res.status === 204 ? null : await res.json();
  } catch {
    throw new ProviderError('parse', 'response is not valid JSON', { status: res.status, rate });
  }
  return {
    status: res.status,
    json,
    headers: res.headers,
    receivedAt,
    latencyMs: receivedAt - startedAt,
    rate,
  };
}

/** `Retry-After` as seconds or an HTTP date, plus OpenSky's `X-Rate-Limit-Retry-After-Seconds`. */
export function parseRetryAfter(headers: Headers, now: number): number | undefined {
  const raw = headers.get('retry-after') ?? headers.get('x-rate-limit-retry-after-seconds');
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

/**
 * Quota headers in the forms seen live:
 * adsb.lol sends `x-ratelimit-limit: 500, 500;w=86400`, `x-ratelimit-remaining: 499`, `x-ratelimit-reset: 20760`
 * (seconds until the window resets). OpenSky sends `X-Rate-Limit-Remaining: 399` only.
 */
export function parseRateHeaders(headers: Headers, now: number): RateInfo | undefined {
  const remainingRaw = headers.get('x-ratelimit-remaining') ?? headers.get('x-rate-limit-remaining');
  if (remainingRaw == null) return undefined;
  const remaining = Number(remainingRaw);
  if (!Number.isFinite(remaining)) return undefined;
  const info: RateInfo = { remaining };
  const limit = Number.parseInt(headers.get('x-ratelimit-limit') ?? '', 10);
  if (Number.isFinite(limit)) info.limit = limit;
  const reset = Number(headers.get('x-ratelimit-reset') ?? Number.NaN);
  if (Number.isFinite(reset) && reset >= 0) info.resetAt = now + reset * 1000;
  return info;
}

function summarise(body: string): string {
  const text = body.trim();
  if (!text) return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const msg = parsed.error ?? parsed.message ?? parsed.msg ?? parsed.detail;
    if (typeof msg === 'string') return msg.slice(0, 200);
  } catch {
    // not JSON: fall through to plain text
  }
  return text
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}
