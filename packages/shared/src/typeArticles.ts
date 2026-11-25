import table from '../data/type-articles.json' with { type: 'json' };

const ARTICLES = table as Record<string, string>;

/** Number of ICAO type designators with a Wikipedia article. */
export const TYPE_ARTICLE_COUNT = Object.keys(ARTICLES).length;

/**
 * The English Wikipedia article about an aircraft type, by ICAO type designator. Written by hand and checked by
 * `pnpm check:types` against ICAO Doc 8643 and Wikipedia. Null for a type that is not in the table.
 */
export function typeArticle(typeCode: string | null | undefined): string | null {
  const key = typeCode?.trim().toUpperCase() ?? '';
  return Object.hasOwn(ARTICLES, key) ? (ARTICLES[key] as string) : null;
}
