import { typeArticle } from '@towercab/shared';
import { type FetchLike, fetchJson } from '../providers/http';
import { ProviderError } from '../providers/types';

/**
 * A picture of an aircraft type from Wikimedia Commons, for aircraft nobody has photographed themselves.
 *
 * Checked live on 2026-11-24. Two questions, one after the other:
 * - en.wikipedia.org, `prop=pageimages`: the lead image of the article about the type. `pilicense=free` leaves out
 *   anything that is not freely licensed.
 * - commons.wikimedia.org, `prop=imageinfo`: a thumbnail of that file, its author and its licence.
 *
 * Wikimedia asks callers to send requests one after another, to cache the answers and to say who they are. Showing
 * a thumbnail straight from its servers is allowed, with the credit the licence asks for; 500 pixels is one of its
 * standard widths. Only the address and the credit pass through this server, never the picture.
 */
export const WIKIPEDIA_API = 'https://en.wikipedia.org/w/api.php';
export const COMMONS_API = 'https://commons.wikimedia.org/w/api.php';
const THUMBNAIL_WIDTH = 500;

export interface TypePhoto {
  /** What the picture shows: the title of the article it comes from. */
  subject: string;
  thumbnail: string;
  width: number | null;
  height: number | null;
  /** The file's page on Commons, with everything about its author and licence. */
  link: string;
  author: string;
  license: string;
  licenseUrl: string | null;
}

/** The lead image's file name and the title of the article (after redirects), or null when there is none. */
export function parsePageImage(json: unknown): { title: string; file: string } | null {
  const pages = (json as { query?: { pages?: unknown } } | null)?.query?.pages;
  if (!Array.isArray(pages)) return null;
  const page = pages[0] as { title?: unknown; pageimage?: unknown } | undefined;
  if (typeof page?.title !== 'string' || typeof page.pageimage !== 'string') return null;
  return { title: page.title, file: page.pageimage };
}

/** Plain text of a piece of HTML from Commons, on one line. It is shown as text, never as HTML. */
export function plainText(html: string): string {
  return (
    html
      .replace(/<(style|script)[\s\S]*?<\/\1>/gi, '')
      // Commons writes "Unknown author" twice, once hidden.
      .replace(/<(\w+)[^>]*display:\s*none[^>]*>[^<]*<\/\1>/gi, '')
      .replace(/<[^>]*>/g, '')
      .replace(/&#(\d+);/g, (_, n: string) => codePoint(Number(n)))
      .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => codePoint(Number.parseInt(n, 16)))
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&nbsp;/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function codePoint(n: number): string {
  return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : '';
}

function isWikimediaUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname.endsWith('.wikimedia.org');
  } catch {
    return false;
  }
}

export function parseImageInfo(json: unknown, subject: string): TypePhoto | null {
  const pages = (json as { query?: { pages?: unknown } } | null)?.query?.pages;
  const page = Array.isArray(pages) ? (pages[0] as { imageinfo?: unknown } | undefined) : undefined;
  const info = Array.isArray(page?.imageinfo)
    ? (page.imageinfo[0] as Record<string, unknown> | undefined)
    : undefined;
  if (!info || !isWikimediaUrl(info.thumburl) || !isWikimediaUrl(info.descriptionurl)) return null;

  const meta = (info.extmetadata ?? {}) as Record<string, { value?: unknown } | undefined>;
  const text = (name: string): string => {
    const value = meta[name]?.value;
    return typeof value === 'string' ? plainText(value) : '';
  };
  // Without a licence there is no way to show the picture properly.
  const license = text('LicenseShortName');
  if (!license) return null;
  // An author may ask for a wording of their own ("Attribution"); otherwise it is the name on the file's page.
  const author = text('Attribution') || text('Artist') || 'unknown author';
  const licenseUrl = text('LicenseUrl')
    .replace(/^http:/, 'https:')
    .replace(/^\/\//, 'https://');
  return {
    subject,
    thumbnail: info.thumburl,
    width: typeof info.thumbwidth === 'number' ? info.thumbwidth : null,
    height: typeof info.thumbheight === 'number' ? info.thumbheight : null,
    link: info.descriptionurl,
    author: author.length > 120 ? `${author.slice(0, 119)}…` : author,
    license,
    licenseUrl: licenseUrl.startsWith('https://') ? licenseUrl : null,
  };
}

export interface TypePhotoServiceOptions {
  userAgent: string;
  fetchImpl?: FetchLike;
  now?: () => number;
  /** How long a picture, and the fact that there is none, are remembered. */
  ttlMs?: number;
  noneTtlMs?: number;
  /** How long Wikimedia is left alone after it refused or failed to answer. */
  backoffMs?: number;
}

/** Looks type pictures up on demand, one request at a time, and remembers the answers in memory. */
export class TypePhotoService {
  /** By article, not by type: a whole family shares one. */
  private readonly cache = new Map<string, { photo: TypePhoto | null; until: number }>();
  private readonly inFlight = new Map<string, Promise<TypePhoto | null>>();
  private queue: Promise<unknown> = Promise.resolve();
  private quietUntil = 0;
  private readonly now: () => number;

  constructor(private readonly options: TypePhotoServiceOptions) {
    this.now = options.now ?? Date.now;
  }

  /** The picture for an ICAO type designator, or null. Never fails. */
  get(typeCode: string): Promise<TypePhoto | null> {
    const article = typeArticle(typeCode);
    if (!article) return Promise.resolve(null);
    const cached = this.cache.get(article);
    if (cached && this.now() < cached.until) return Promise.resolve(cached.photo);
    const running = this.inFlight.get(article);
    if (running) return running;

    const request = this.enqueue(() => this.lookUp(article))
      .catch(() => cached?.photo ?? null)
      .finally(() => {
        this.inFlight.delete(article);
      });
    this.inFlight.set(article, request);
    return request;
  }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async lookUp(article: string): Promise<TypePhoto | null> {
    if (this.now() < this.quietUntil) throw new Error('Wikimedia is being left alone for a while');
    try {
      const page = parsePageImage(
        await this.ask(WIKIPEDIA_API, {
          prop: 'pageimages',
          piprop: 'name',
          pilicense: 'free',
          redirects: '1',
          titles: article,
        }),
      );
      const photo = page
        ? parseImageInfo(
            await this.ask(COMMONS_API, {
              prop: 'imageinfo',
              iiprop: 'url|size|extmetadata',
              iiurlwidth: String(THUMBNAIL_WIDTH),
              iiextmetadatafilter: 'Artist|Attribution|LicenseShortName|LicenseUrl',
              iiextmetadatalanguage: 'en',
              titles: `File:${page.file}`,
            }),
            page.title,
          )
        : null;
      const life = photo ? (this.options.ttlMs ?? 7 * 86_400_000) : (this.options.noneTtlMs ?? 86_400_000);
      this.cache.set(article, { photo, until: this.now() + life });
      return photo;
    } catch (err) {
      // "Too many requests" and the like: no more questions for a while, and nothing is remembered as "none".
      const wait = err instanceof ProviderError ? (err.retryAfterMs ?? 0) : 0;
      this.quietUntil = this.now() + Math.max(wait, this.options.backoffMs ?? 10 * 60_000);
      throw err;
    }
  }

  private async ask(api: string, params: Record<string, string>): Promise<unknown> {
    const query = new URLSearchParams({ action: 'query', format: 'json', formatversion: '2', ...params });
    const res = await fetchJson({
      url: `${api}?${query}`,
      userAgent: this.options.userAgent,
      fetchImpl: this.options.fetchImpl,
      now: this.now,
      timeoutMs: 8000,
    });
    return res.json;
  }
}
