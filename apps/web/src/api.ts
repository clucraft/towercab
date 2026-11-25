import type {
  AdminCameraPatch,
  AdminState,
  AirportDetail,
  AirportSummary,
  CamerasResponse,
  ClientConfig,
  Metar,
} from '@towercab/shared';

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

/** A picture of an aircraft type, from Wikimedia Commons. */
export interface TypePhoto {
  subject: string;
  thumbnail: string;
  width: number | null;
  height: number | null;
  link: string;
  author: string;
  license: string;
  licenseUrl: string | null;
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
    getJson<CamerasResponse>(`/api/cameras/${encodeURIComponent(icao)}`, signal),
  metar: (icao: string, signal?: AbortSignal) =>
    getJson<{ metar: Metar | null }>(`/api/metar/${encodeURIComponent(icao)}`, signal).then((r) => r.metar),
  typePhoto: (typeCode: string, signal?: AbortSignal) =>
    getJson<{ photo: TypePhoto | null }>(`/api/type-photos/${encodeURIComponent(typeCode)}`, signal).then(
      (r) => r.photo,
    ),
  photo: (hex: string, signal?: AbortSignal) =>
    getJson<{ photo: AircraftPhoto | null }>(`/api/photos/${encodeURIComponent(hex)}`, signal).then(
      (r) => r.photo,
    ),
};

/** What one provider did when a camera search was asked for. */
export interface DiscoveryOutcome {
  provider: 'youtube' | 'windy';
  ran: boolean;
  ok: boolean;
  found: number;
  added: number;
  message?: string;
  nextAt?: number;
}

async function adminRequest<T>(token: string, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/admin/api${path}`, {
    method,
    // The token goes in a header on every request and is kept nowhere but this tab.
    headers: {
      Accept: 'application/json',
      Authorization: `Bearer ${token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let message = `HTTP ${res.status}`;
    try {
      const parsed = (await res.json()) as { message?: string };
      if (parsed.message) message = parsed.message;
    } catch {
      // keep the status text
    }
    throw new ApiError(res.status, message);
  }
  return (await res.json()) as T;
}

/** The admin API. Every call carries the admin token. */
export const adminApi = {
  state: (token: string) => adminRequest<AdminState>(token, 'GET', '/state'),
  discover: (token: string, icao: string) =>
    adminRequest<{ outcomes: DiscoveryOutcome[]; state: AdminState }>(
      token,
      'POST',
      `/discovery/${encodeURIComponent(icao)}`,
    ),
  patchCamera: (token: string, id: string, patch: AdminCameraPatch) =>
    adminRequest<AdminState>(token, 'PATCH', `/cameras/${encodeURIComponent(id)}`, patch),
  preview: (token: string, id: string) =>
    adminRequest<{ url: string | null }>(token, 'GET', `/cameras/${encodeURIComponent(id)}/preview`),
};
