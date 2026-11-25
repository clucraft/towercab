/**
 * Checks packages/shared/data/type-articles.json, the table that says which Wikipedia article goes with an ICAO
 * type designator. For every row: the designator exists in ICAO Doc 8643, the article exists and has a freely
 * licensed lead image, and the two are about the same aircraft as far as their names tell.
 *
 *   pnpm check:types            # problems only
 *   pnpm check:types --all      # every row, for reading through
 *
 * Asks ICAO's public list once and Wikipedia once per fifty articles, with a long pause between requests:
 * Wikimedia gives callers that do not identify themselves few requests a minute. `--user-agent` may say who asks.
 */
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    all: { type: 'boolean', default: false },
    'user-agent': { type: 'string', default: 'aircraft-type-check/1.0' },
  },
});

/** Used by ADS-B sources for things that have no designator of their own. */
const SPECIAL = new Set(['BALL', 'GLID', 'GYRO']);
/** Rows whose names differ from ICAO's and that were read through: a family's article, or another spelling. */
const READ = new Set(
  'A19N C120 C25A C25B C25C C25M C335 CRJ9 CRJX E170 E190 E195 E75L E75S GLF3 GLF4 GLF5 L8 M7 RJ1H RJ85 SW4'.split(
    ' ',
  ),
);
const PAUSE_MS = 12_000;

interface IcaoType {
  ModelFullName: string;
  ManufacturerCode: string;
  Designator: string;
}
interface Page {
  title: string;
  missing?: boolean;
  pageimage?: string;
  description?: string;
  pageprops?: { disambiguation?: string };
}
interface Answer {
  query: {
    normalized?: { from: string; to: string }[];
    redirects?: { from: string; to: string }[];
    pages: Page[];
  };
}

const headers = { 'User-Agent': values['user-agent'] as string, Accept: 'application/json' };

async function getJson<T>(url: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(url, { ...init, headers });
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return (await res.json()) as T;
}

const GENERAL = ['family', 'series', 'aircraft', 'model', 'de', 'havilland', 'canada', 'boeing', 'bell'];

/**
 * The words and numbers of a name without its manufacturer, for a rough comparison:
 * "PA-28R-201 Arrow" → pa, 28r, 201, arrow, 28, pa28r201.
 */
function tokens(name: string, manufacturer: string): Set<string> {
  const drop = new Set([...GENERAL, ...manufacturer.toLowerCase().split(/[^a-z0-9]+/)]);
  const words = [
    ...name.toLowerCase().split(/[^a-z0-9]+/),
    ...name
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, '')
      .split(' '),
  ];
  return new Set([...words.filter((w) => w.length > 1 && !drop.has(w)), ...(name.match(/\d{2,}/g) ?? [])]);
}

async function main(): Promise<number> {
  const table = JSON.parse(
    readFileSync(new URL('../packages/shared/data/type-articles.json', import.meta.url), 'utf8'),
  ) as Record<string, string>;

  const icao = await getJson<IcaoType[]>('https://doc8643.icao.int/external/aircrafttypes', {
    method: 'POST',
  });
  const models = new Map<string, IcaoType[]>();
  for (const t of icao) models.set(t.Designator, [...(models.get(t.Designator) ?? []), t]);

  const titles = [...new Set(Object.values(table))];
  const pages = new Map<string, Page>();
  for (let i = 0; i < titles.length; i += 50) {
    const batch = titles.slice(i, i + 50);
    if (i > 0) await new Promise((resolve) => setTimeout(resolve, PAUSE_MS));
    const query = new URLSearchParams({
      action: 'query',
      prop: 'pageimages|description|pageprops',
      piprop: 'name',
      pilimit: '50',
      pilicense: 'free',
      ppprop: 'disambiguation',
      redirects: '1',
      format: 'json',
      formatversion: '2',
      titles: batch.join('|'),
    });
    const answer = await getJson<Answer>(`https://en.wikipedia.org/w/api.php?${query}`);
    const next = new Map<string, string>();
    for (const step of [...(answer.query.normalized ?? []), ...(answer.query.redirects ?? [])])
      next.set(step.from, step.to);
    const byTitle = new Map(answer.query.pages.map((p) => [p.title, p]));
    for (const title of batch) {
      let at = title;
      for (let hops = 0; hops < 4 && next.has(at); hops += 1) at = next.get(at) as string;
      const page = byTitle.get(at);
      if (page) pages.set(title, page);
    }
  }

  let problems = 0;
  for (const [code, title] of Object.entries(table)) {
    const list = models.get(code);
    const page = pages.get(title);
    const notes: string[] = [];
    if (!list && !SPECIAL.has(code)) notes.push('NOT AN ICAO DESIGNATOR');
    if (!page || page.missing) notes.push('NO SUCH ARTICLE');
    else {
      if (page.pageprops?.disambiguation !== undefined) notes.push('DISAMBIGUATION PAGE');
      if (!page.pageimage) notes.push('NO FREE IMAGE');
      else if (!/\.(jpe?g|png|webp|tiff?)$/i.test(page.pageimage)) notes.push(`IMAGE IS ${page.pageimage}`);
      if (list && !READ.has(code)) {
        const same = list.some((m) => {
          const wanted = tokens(`${title} ${page.title}`, m.ManufacturerCode);
          return [...tokens(m.ModelFullName, m.ManufacturerCode)].some((t) => wanted.has(t));
        });
        if (!same) notes.push('NAMES DO NOT MATCH');
      }
    }
    if (notes.length > 0) problems += 1;
    if (notes.length > 0 || values.all) {
      const some = (list ?? [])
        .slice(0, 4)
        .map((m) => `${m.ManufacturerCode} ${m.ModelFullName}`)
        .join(', ');
      const article = page && page.title !== title ? `${title} → ${page.title}` : title;
      console.log(
        `${code.padEnd(5)} ${article} [${page?.description ?? ''}] ${page?.pageimage ?? ''} | ICAO: ${some}` +
          (notes.length > 0 ? `  <<< ${notes.join(', ')}` : ''),
      );
    }
  }
  console.log(`${Object.keys(table).length} designators, ${titles.length} articles, ${problems} to look at`);
  return problems === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
