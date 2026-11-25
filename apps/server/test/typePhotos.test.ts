import { describe, expect, it } from 'vitest';
import {
  COMMONS_API,
  parseImageInfo,
  parsePageImage,
  plainText,
  TypePhotoService,
  WIKIPEDIA_API,
} from '../src/reference/typePhotos';
import { type FakeRoute, fakeFetch, fixtureJson, fixtureText, sentHeaders } from './helpers';

const UA = 'TowerCab-tests/0 (+https://example.test)';

const ROUTES: FakeRoute[] = [
  { match: WIKIPEDIA_API, body: fixtureText('wikipedia-pageimages-p28.json') },
  { match: COMMONS_API, body: fixtureText('commons-imageinfo-p28.json') },
];

/** A Commons answer for a file with the given metadata, otherwise like the real one. */
function imageInfo(extmetadata: Record<string, string>, changes: Record<string, unknown> = {}): unknown {
  const real = fixtureJson('commons-imageinfo-p28.json') as {
    query: { pages: { imageinfo: Record<string, unknown>[] }[] };
  };
  const info = real.query.pages[0]?.imageinfo[0];
  const meta = Object.fromEntries(Object.entries(extmetadata).map(([k, value]) => [k, { value }]));
  return { query: { pages: [{ imageinfo: [{ ...info, extmetadata: meta, ...changes }] }] } };
}

describe('type pictures: reading the answers', () => {
  it('reads the lead image of an article, and that there is none', () => {
    expect(parsePageImage(fixtureJson('wikipedia-pageimages-p28.json'))).toEqual({
      title: 'Piper PA-28 Cherokee',
      file: 'G-AVRZ_Piper_PA-28-180_Cherokee_C_at_Northrepps.jpg',
    });
    expect(parsePageImage(fixtureJson('wikipedia-pageimages-missing.json'))).toBeNull();
    expect(parsePageImage({ error: { code: 'x' } })).toBeNull();
    expect(parsePageImage(null)).toBeNull();
  });

  it('reads the thumbnail and everything the licence asks to be shown', () => {
    expect(parseImageInfo(fixtureJson('commons-imageinfo-p28.json'), 'Piper PA-28 Cherokee')).toEqual({
      subject: 'Piper PA-28 Cherokee',
      thumbnail:
        'https://thumb.wikimedia.org/wikipedia/commons/thumb/1/17/G-AVRZ_Piper_PA-28-180_Cherokee_C_at_Northrepps.jpg/500px-G-AVRZ_Piper_PA-28-180_Cherokee_C_at_Northrepps.jpg?utm_source=commons.wikimedia.org&utm_campaign=imageinfo&utm_content=thumbnail',
      width: 500,
      height: 337,
      link: 'https://commons.wikimedia.org/wiki/File:G-AVRZ_Piper_PA-28-180_Cherokee_C_at_Northrepps.jpg',
      author: 'Mike Burdett',
      license: 'CC BY-SA 2.0',
      licenseUrl: 'https://creativecommons.org/licenses/by-sa/2.0',
    });
  });

  it('turns the author’s HTML into plain text', () => {
    const photo = parseImageInfo(
      imageInfo({
        Artist:
          '<a href="//commons.wikimedia.org/wiki/User:X" title="User:X">Jane &amp; Jo<script>alert(1)</script></a>',
        LicenseShortName: 'CC BY 4.0',
        LicenseUrl: 'http://creativecommons.org/licenses/by/4.0/',
      }),
      'x',
    );
    expect(photo?.author).toBe('Jane & Jo');
    expect(photo?.licenseUrl).toBe('https://creativecommons.org/licenses/by/4.0/');
    expect(plainText('a&#8217;b &lt;i&gt; &#x41;\n  c')).toBe('a’b <i> A c');
    expect(plainText('&#99999999;x')).toBe('x');
    expect(
      plainText(
        '<div style="display:inline"><div style="display: none;">Unknown author</div>Unknown author</div>',
      ),
    ).toBe('Unknown author');
  });

  it('prefers the wording an author asks for, and copes with one who is not named', () => {
    expect(
      parseImageInfo(
        imageInfo({ Attribution: 'Photo: J. Doe', Artist: 'J', LicenseShortName: 'CC BY 3.0' }),
        'x',
      )?.author,
    ).toBe('Photo: J. Doe');
    const unnamed = parseImageInfo(imageInfo({ LicenseShortName: 'Public domain' }), 'x');
    expect(unnamed).toMatchObject({ author: 'unknown author', license: 'Public domain', licenseUrl: null });
  });

  it('shows nothing whose licence is unknown or that is not on Wikimedia’s servers', () => {
    expect(parseImageInfo(imageInfo({ Artist: 'x' }), 'x')).toBeNull();
    const licence = { LicenseShortName: 'CC0' };
    expect(parseImageInfo(imageInfo(licence, { thumburl: 'https://evil.test/a.jpg' }), 'x')).toBeNull();
    expect(
      parseImageInfo(imageInfo(licence, { thumburl: 'http://thumb.wikimedia.org/a.jpg' }), 'x'),
    ).toBeNull();
    expect(
      parseImageInfo(imageInfo(licence, { descriptionurl: 'https://wikimedia.org.evil.test/' }), 'x'),
    ).toBeNull();
    expect(parseImageInfo({ query: { pages: [{ missing: true }] } }, 'x')).toBeNull();
    const odd = parseImageInfo(
      imageInfo({ LicenseShortName: 'CC0', LicenseUrl: 'javascript:alert(1)' }),
      'x',
    );
    expect(odd?.licenseUrl).toBeNull();
  });
});

describe('type pictures: the service', () => {
  it('asks Wikipedia, then Commons, says who it is, and remembers the answer for the whole family', async () => {
    const fetchImpl = fakeFetch(ROUTES);
    const service = new TypePhotoService({ userAgent: UA, fetchImpl });
    expect((await service.get('P28R'))?.author).toBe('Mike Burdett');
    expect(fetchImpl.calls.map((c) => new URL(c.url).host)).toEqual([
      'en.wikipedia.org',
      'commons.wikimedia.org',
    ]);
    expect(new URL(fetchImpl.calls[0]?.url ?? '').searchParams.get('titles')).toBe('Piper PA-28 Cherokee');
    expect(new URL(fetchImpl.calls[0]?.url ?? '').searchParams.get('pilicense')).toBe('free');
    expect(new URL(fetchImpl.calls[1]?.url ?? '').searchParams.get('iiurlwidth')).toBe('500');
    expect(sentHeaders(fetchImpl.calls[0])['User-Agent']).toBe(UA);

    // The Archer and the Arrow are in the same article.
    expect((await service.get('p28a'))?.subject).toBe('Piper PA-28 Cherokee');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  it('asks nothing about a type it has no article for', async () => {
    const fetchImpl = fakeFetch([]);
    const service = new TypePhotoService({ userAgent: UA, fetchImpl });
    expect(await service.get('ZZZZ')).toBeNull();
    expect(await service.get('')).toBeNull();
    expect(await service.get('constructor')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(0);
  });

  it('never has two requests under way at once', async () => {
    let active = 0;
    let most = 0;
    const inner = fakeFetch(ROUTES);
    const service = new TypePhotoService({
      userAgent: UA,
      fetchImpl: async (url, init) => {
        active += 1;
        most = Math.max(most, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active -= 1;
        return inner(url, init);
      },
    });
    await Promise.all(['P28A', 'C172', 'SR22', 'BE58', 'P28A', 'B06'].map((code) => service.get(code)));
    expect(most).toBe(1);
    // Five articles, two requests each; the second P28A joined the first.
    expect(inner.calls).toHaveLength(10);
  });

  it('leaves Wikimedia alone after a refusal, and does not take it for "no picture"', async () => {
    let now = 0;
    let refuse = true;
    const inner = fakeFetch(ROUTES);
    let calls = 0;
    const service = new TypePhotoService({
      userAgent: UA,
      now: () => now,
      backoffMs: 60_000,
      fetchImpl: async (url, init) => {
        calls += 1;
        return refuse ? new Response('slow down', { status: 429 }) : inner(url, init);
      },
    });
    expect(await service.get('P28A')).toBeNull();
    expect(await service.get('C172')).toBeNull();
    expect(calls).toBe(1);
    refuse = false;
    now = 59_000;
    expect(await service.get('P28A')).toBeNull();
    expect(calls).toBe(1);
    now = 61_000;
    expect((await service.get('P28A'))?.author).toBe('Mike Burdett');
  });

  it('keeps showing what it has when a renewal fails', async () => {
    let now = 0;
    let fail = false;
    const inner = fakeFetch(ROUTES);
    const service = new TypePhotoService({
      userAgent: UA,
      now: () => now,
      ttlMs: 1000,
      fetchImpl: async (url, init) => {
        if (fail) throw new TypeError('network down');
        return inner(url, init);
      },
    });
    expect(await service.get('P28A')).not.toBeNull();
    fail = true;
    now = 5000;
    expect((await service.get('P28A'))?.author).toBe('Mike Burdett');
  });

  it('remembers for a day that an article has no free picture', async () => {
    let now = 0;
    const fetchImpl = fakeFetch([
      { match: WIKIPEDIA_API, body: fixtureText('wikipedia-pageimages-missing.json') },
    ]);
    const service = new TypePhotoService({ userAgent: UA, fetchImpl, now: () => now });
    expect(await service.get('P28A')).toBeNull();
    expect(await service.get('P28A')).toBeNull();
    expect(fetchImpl.calls).toHaveLength(1);
    now = 25 * 3_600_000;
    await service.get('P28A');
    expect(fetchImpl.calls).toHaveLength(2);
  });
});
