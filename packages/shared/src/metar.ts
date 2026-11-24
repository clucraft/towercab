/** A decoded METAR, as returned by `/api/metar/:icao`. */
export interface Metar {
  icao: string;
  /** The observation exactly as issued. */
  raw: string;
  /** Observation time, epoch ms. */
  obsTime: number;
  /** When the server fetched it, epoch ms. */
  fetchedAt: number;
  tempC: number | null;
  dewpointC: number | null;
  /** Direction the wind blows from, degrees true. Null when calm or variable. */
  windDirDeg: number | null;
  windVariable: boolean;
  windSpeedKt: number | null;
  windGustKt: number | null;
  /** Visibility in statute miles as reported, e.g. `10+`. */
  visibility: string | null;
  /** Altimeter setting, hPa. */
  altimHpa: number | null;
  /** VFR, MVFR, IFR or LIFR. */
  flightCategory: string | null;
  clouds: { cover: string; baseFt: number | null }[];
}

export const hpaToInHg = (hpa: number): number => hpa * 0.0295299830714;

/** Short wind text for the panel, e.g. `050° at 11 kt, gusting 18`. */
export function describeWind(
  m: Pick<Metar, 'windDirDeg' | 'windVariable' | 'windSpeedKt' | 'windGustKt'>,
): string {
  if (m.windSpeedKt == null) return 'Wind not reported';
  if (m.windSpeedKt === 0) return 'Calm';
  const dir =
    m.windVariable || m.windDirDeg == null
      ? 'Variable'
      : `${String(Math.round(m.windDirDeg)).padStart(3, '0')}°`;
  const gust = m.windGustKt ? `, gusting ${Math.round(m.windGustKt)}` : '';
  return `${dir} at ${Math.round(m.windSpeedKt)} kt${gust}`;
}
