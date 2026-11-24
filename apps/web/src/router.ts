import { useSyncExternalStore } from 'react';

export type Route =
  | { name: 'home' }
  | { name: 'airport'; icao: string }
  | { name: 'debug'; icao: string }
  | { name: 'admin' }
  | { name: 'not-found'; path: string };

const ICAO = /^[A-Za-z0-9]{3,4}$/;

/** Maps a path to a page. `/KLAF` is an airport, `/debug/KLAF` its live data table. */
export function parseRoute(pathname: string): Route {
  const parts = pathname.split('/').filter(Boolean);
  if (parts.length === 0) return { name: 'home' };
  const [first, second] = parts as [string, string | undefined];
  if (first.toLowerCase() === 'admin' && parts.length === 1) return { name: 'admin' };
  if (first.toLowerCase() === 'debug' && second && ICAO.test(second) && parts.length === 2) {
    return { name: 'debug', icao: second.toUpperCase() };
  }
  if (parts.length === 1 && ICAO.test(first)) return { name: 'airport', icao: first.toUpperCase() };
  return { name: 'not-found', path: pathname };
}

const listeners = new Set<() => void>();
const notify = () => {
  for (const listener of listeners) listener();
};

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  window.addEventListener('popstate', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('popstate', listener);
  };
}

/** Changes the URL without reloading the page. */
export function navigate(to: string, options: { replace?: boolean } = {}): void {
  if (options.replace) window.history.replaceState(null, '', to);
  else window.history.pushState(null, '', to);
  notify();
}

/** The current URL as `pathname + search`; re-renders the component when it changes. */
export function useLocation(): { pathname: string; search: string } {
  const href = useSyncExternalStore(subscribe, () => window.location.pathname + window.location.search);
  const cut = href.indexOf('?');
  return cut === -1
    ? { pathname: href, search: '' }
    : { pathname: href.slice(0, cut), search: href.slice(cut) };
}

export function useRoute(): Route {
  return parseRoute(useLocation().pathname);
}

/** Replaces query parameters in place (no history entry), so a view or mode change gives a shareable URL. */
export function setQuery(changes: Record<string, string | null>): void {
  const params = new URLSearchParams(window.location.search);
  for (const [key, value] of Object.entries(changes)) {
    if (value === null) params.delete(key);
    else params.set(key, value);
  }
  const query = params.toString();
  navigate(window.location.pathname + (query ? `?${query}` : ''), { replace: true });
}
