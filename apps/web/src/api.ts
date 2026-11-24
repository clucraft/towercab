import type { AirportDetail, AirportSummary, CameraConfig, ClientConfig, Metar } from '@towercab/shared';

export class ApiError extends Error {
  override name = 'ApiError';
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function getJson<T>(path: string, signal?: AbortSignal): Promise<T> {
  const res = await fetch(path, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { message?: string };
      if (body.message) message = body.message;
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

export interface AircraftPhoto {
  thumbnail: string;
  width: number | null;
  height: number | null;
  link: string;
  photographer: string;
}

export const api = {
  airports: (signal?: AbortSignal) => getJson<AirportSummary[]>('/api/airports', signal),
  airport: (icao: string, signal?: AbortSignal) =>
    getJson<AirportDetail>(`/api/airports/${encodeURIComponent(icao)}`, signal),
  clientConfig: (signal?: AbortSignal) => getJson<ClientConfig>('/api/client-config', signal),
  cameras: (icao: string, signal?: AbortSignal) =>
    getJson<CameraConfig[]>(`/api/cameras/${encodeURIComponent(icao)}`, signal),
  metar: (icao: string, signal?: AbortSignal) =>
    getJson<{ metar: Metar | null }>(`/api/metar/${encodeURIComponent(icao)}`, signal).then((r) => r.metar),
  photo: (hex: string, signal?: AbortSignal) =>
    getJson<{ photo: AircraftPhoto | null }>(`/api/photos/${encodeURIComponent(hex)}`, signal).then(
      (r) => r.photo,
    ),
};
