import { describe, expect, it } from 'vitest';
import { until } from './Daylight';

describe('until', () => {
  const now = Date.UTC(2026, 10, 25, 15, 45);
  const after = (minutes: number) => until(now, now + minutes * 60_000);

  it('says how long it is, and nothing when it is over', () => {
    expect(after(399)).toBe('in 6 h 39 min');
    expect(after(60)).toBe('in 1 h 0 min');
    expect(after(59)).toBe('in 59 min');
    expect(after(1)).toBe('in 1 min');
    expect(after(0)).toBe('');
    expect(after(-30)).toBe('');
  });
});
