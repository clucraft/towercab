import { describe, expect, it } from 'vitest';
import { parseRoute } from './router';

describe('parseRoute', () => {
  it('maps the shareable URLs to pages', () => {
    expect(parseRoute('/')).toEqual({ name: 'home' });
    expect(parseRoute('/KLAF')).toEqual({ name: 'airport', icao: 'KLAF' });
    expect(parseRoute('/kind/')).toEqual({ name: 'airport', icao: 'KIND' });
    expect(parseRoute('/debug/klaf')).toEqual({ name: 'debug', icao: 'KLAF' });
    expect(parseRoute('/admin')).toEqual({ name: 'admin' });
  });

  it('does not mistake other paths for airports', () => {
    expect(parseRoute('/debug')).toEqual({ name: 'not-found', path: '/debug' });
    expect(parseRoute('/debug/KLAF/extra')).toEqual({ name: 'not-found', path: '/debug/KLAF/extra' });
    expect(parseRoute('/KLAF/tower')).toEqual({ name: 'not-found', path: '/KLAF/tower' });
    expect(parseRoute('/favicon.svg')).toEqual({ name: 'not-found', path: '/favicon.svg' });
  });
});
