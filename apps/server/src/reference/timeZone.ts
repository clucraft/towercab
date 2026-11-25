import tzLookup from '@photostructure/tz-lookup';
import { isTimeZone } from '@towercab/shared';

/**
 * The time zone at a position. The table is small and not exact along borders between zones: of 32 airports checked
 * against the US National Weather Service, many of them close to such a border, one was an hour out. `timezone` in
 * the config overrides it. Nothing but the clock times shown depends on it; the sun goes by the coordinates.
 */
export function timeZoneAt(lat: number, lon: number): string {
  try {
    const name = tzLookup(lat, lon);
    if (isTimeZone(name)) return name;
  } catch {
    // Not a position on Earth.
  }
  return 'UTC';
}
