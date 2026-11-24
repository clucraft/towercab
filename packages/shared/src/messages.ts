import { z } from 'zod';
import { AircraftSchema, TrailPointSchema } from './aircraft';
import { IcaoSchema } from './airport';

/** Health of one ADS-B source as shown in the side panel. */
export const ProviderStateSchema = z.enum([
  'ok', // answering normally
  'degraded', // answering, with recent failures
  'backoff', // failing; waiting before the next attempt
  'blocked', // the service refuses us (403/401) or the quota is used up
  'idle', // enabled, nothing asked of it yet
  'disabled',
]);
export type ProviderState = z.infer<typeof ProviderStateSchema>;

export const ProviderHealthSchema = z.object({
  id: z.string(),
  label: z.string(),
  enabled: z.boolean(),
  state: ProviderStateSchema,
  priority: z.number(),
  lastSuccessAt: z.number().optional(),
  lastErrorAt: z.number().optional(),
  lastError: z.string().optional(),
  lastStatus: z.number().optional(),
  latencyMs: z.number().optional(),
  requests: z.number(),
  failures: z.number(),
  rateLimited: z.number(),
  /** Aircraft in this provider's most recent answer (any airport). */
  lastCount: z.number().optional(),
  quota: z
    .object({
      limit: z.number().optional(),
      remaining: z.number(),
      /** Epoch ms when the quota window resets, when the service says. */
      resetAt: z.number().optional(),
    })
    .optional(),
  /** Epoch ms until which no request will be made. */
  backoffUntil: z.number().optional(),
});
export type ProviderHealth = z.infer<typeof ProviderHealthSchema>;

export const PollStateSchema = z.enum(['active', 'idle', 'paused']);
export type PollState = z.infer<typeof PollStateSchema>;

export const AirportStatusSchema = z.object({
  pollState: PollStateSchema,
  viewers: z.number(),
  lastPollAt: z.number().optional(),
  /** Altimeter setting in use for altitude correction, hPa. */
  qnhHpa: z.number().optional(),
  providers: z.array(ProviderHealthSchema),
});
export type AirportStatus = z.infer<typeof AirportStatusSchema>;

// ---- browser → server ---------------------------------------------------------------------------

export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('subscribe'), icao: IcaoSchema }),
  z.object({ type: z.literal('unsubscribe') }),
  z.object({ type: z.literal('pong'), t: z.number().optional() }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ---- server → browser ---------------------------------------------------------------------------

const stamped = { serverTime: z.number() };

export const HelloMessageSchema = z.object({
  type: z.literal('hello'),
  ...stamped,
  version: z.string(),
  pingIntervalMs: z.number(),
});

/** Full state for one airport, sent right after `subscribe`. */
export const SnapshotMessageSchema = z.object({
  type: z.literal('snapshot'),
  ...stamped,
  icao: z.string(),
  seq: z.number(),
  aircraft: z.array(AircraftSchema),
  /** Recent path per aircraft hex, oldest first. */
  trails: z.record(z.string(), z.array(TrailPointSchema)),
  status: AirportStatusSchema,
});

/** Changes since the previous message for this airport. Sent at most once per second. */
export const DeltaMessageSchema = z.object({
  type: z.literal('delta'),
  ...stamped,
  icao: z.string(),
  seq: z.number(),
  upserts: z.array(AircraftSchema),
  removed: z.array(z.string()),
});

export const StatusMessageSchema = z.object({
  type: z.literal('status'),
  ...stamped,
  icao: z.string(),
  status: AirportStatusSchema,
});

export const PingMessageSchema = z.object({ type: z.literal('ping'), ...stamped });

export const ErrorMessageSchema = z.object({
  type: z.literal('error'),
  ...stamped,
  code: z.enum(['bad_message', 'unknown_airport', 'airport_unavailable', 'server_busy']),
  message: z.string(),
});

export const ServerMessageSchema = z.discriminatedUnion('type', [
  HelloMessageSchema,
  SnapshotMessageSchema,
  DeltaMessageSchema,
  StatusMessageSchema,
  PingMessageSchema,
  ErrorMessageSchema,
]);
export type HelloMessage = z.infer<typeof HelloMessageSchema>;
export type SnapshotMessage = z.infer<typeof SnapshotMessageSchema>;
export type DeltaMessage = z.infer<typeof DeltaMessageSchema>;
export type StatusMessage = z.infer<typeof StatusMessageSchema>;
export type PingMessage = z.infer<typeof PingMessageSchema>;
export type ErrorMessage = z.infer<typeof ErrorMessageSchema>;
export type ServerMessage = z.infer<typeof ServerMessageSchema>;

export const WS_PATH = '/ws';
export const WS_PING_INTERVAL_MS = 20_000;
/** The client reconnects when nothing at all has arrived for this long. */
export const WS_SILENCE_TIMEOUT_MS = 45_000;
