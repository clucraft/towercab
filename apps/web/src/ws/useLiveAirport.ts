import type { Aircraft, AirportStatus, ErrorMessage, TrailPoint } from '@towercab/shared';
import { useEffect, useRef, useState } from 'react';
import { type ConnectionState, LiveClient } from './client';

export interface LiveAirport {
  connection: ConnectionState;
  aircraft: Aircraft[];
  /** Trails delivered with the last snapshot, keyed by hex. */
  trails: Record<string, TrailPoint[]>;
  status: AirportStatus | null;
  error: ErrorMessage | null;
  /** The server's clock, estimated from message timestamps. */
  serverNow(): number;
}

/**
 * Live aircraft for one airport as React state. For tables and panels; the 3D scene reads the WebSocket
 * directly so it can move aircraft every frame without re-rendering React.
 */
export function useLiveAirport(icao: string): LiveAirport {
  const [connection, setConnection] = useState<ConnectionState>('connecting');
  const [aircraft, setAircraft] = useState<Aircraft[]>([]);
  const [trails, setTrails] = useState<Record<string, TrailPoint[]>>({});
  const [status, setStatus] = useState<AirportStatus | null>(null);
  const [error, setError] = useState<ErrorMessage | null>(null);
  const clientRef = useRef<LiveClient | null>(null);

  useEffect(() => {
    const byHex = new Map<string, Aircraft>();
    const publish = () => setAircraft([...byHex.values()]);
    const client = new LiveClient({
      handlers: {
        onState: setConnection,
        onSnapshot(message) {
          byHex.clear();
          for (const a of message.aircraft) byHex.set(a.hex, a);
          setTrails(message.trails);
          setError(null);
          publish();
        },
        onDelta(message) {
          for (const a of message.upserts) byHex.set(a.hex, a);
          for (const hex of message.removed) byHex.delete(hex);
          publish();
        },
        onStatus: (_icao, next) => setStatus(next),
        onError: setError,
      },
    });
    clientRef.current = client;
    setAircraft([]);
    setStatus(null);
    setError(null);
    client.subscribe(icao);
    return () => {
      client.close();
      clientRef.current = null;
    };
  }, [icao]);

  return {
    connection,
    aircraft,
    trails,
    status,
    error,
    serverNow: () => clientRef.current?.serverNow() ?? Date.now(),
  };
}
