import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import {
  type Aircraft,
  ClientMessageSchema,
  type DeltaMessage,
  type ErrorMessage,
  type ServerMessage,
  WS_PATH,
  WS_PING_INTERVAL_MS,
} from '@towercab/shared';
import { type WebSocket, WebSocketServer } from 'ws';
import type { LiveService } from '../live/liveService';
import type { AirportService } from '../reference/airportService';
import type { TrackerDelta } from '../tracking/tracker';

export interface HubDeps {
  live: LiveService;
  airports: AirportService;
  version: string;
  /** Offered every upgrade request that is not for the live feed. True: it took the request over. */
  otherUpgrade?: (request: IncomingMessage, socket: Duplex, head: Buffer) => boolean;
  now?: () => number;
  /** Deltas for one airport go out at most this often. */
  minDeltaIntervalMs?: number;
  statusIntervalMs?: number;
  pingIntervalMs?: number;
  maxClients?: number;
  log?: { debug(obj: object, msg: string): void; warn(obj: object, msg: string): void };
}

interface Client {
  socket: WebSocket;
  icao: string | null;
  /** Set when a ping goes out, cleared by any pong. Two unanswered pings and the connection is dropped. */
  missedPings: number;
}

interface Room {
  clients: Set<Client>;
  seq: number;
  lastSentAt: number;
  pending: { upserts: Map<string, Aircraft>; removed: Set<string> } | null;
  timer: NodeJS.Timeout | null;
}

/** A client this far behind is not keeping up; it is dropped and will reconnect to a fresh snapshot. */
const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
const MAX_CLIENT_MESSAGE_BYTES = 2048;

/**
 * WebSocket fan-out. A browser subscribes to one airport, gets a snapshot, then deltas at up to 1 Hz.
 * The number of subscribers per airport is what drives polling: no viewers, no upstream requests.
 */
export class WsHub {
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<Client>();
  private readonly rooms = new Map<string, Room>();
  private readonly now: () => number;
  private readonly minDeltaIntervalMs: number;
  private readonly pingIntervalMs: number;
  private readonly statusIntervalMs: number;
  private readonly maxClients: number;
  private pingTimer: NodeJS.Timeout | null = null;
  private statusTimer: NodeJS.Timeout | null = null;
  private server: Server | null = null;

  constructor(private readonly deps: HubDeps) {
    this.now = deps.now ?? Date.now;
    this.minDeltaIntervalMs = deps.minDeltaIntervalMs ?? 1000;
    this.pingIntervalMs = deps.pingIntervalMs ?? WS_PING_INTERVAL_MS;
    this.statusIntervalMs = deps.statusIntervalMs ?? 5000;
    this.maxClients = deps.maxClients ?? 500;
    this.wss = new WebSocketServer({
      noServer: true,
      maxPayload: MAX_CLIENT_MESSAGE_BYTES,
      perMessageDeflate: { threshold: 1024 },
    });
    this.wss.on('connection', (socket) => this.onConnection(socket));
    deps.live.on('delta', this.onDelta);
    deps.airports.on('change', this.onAirportsChange);
  }

  /** Handles `Upgrade` requests for `/ws` on the given HTTP server. Other paths are refused. */
  attach(server: Server): void {
    this.server = server;
    server.on('upgrade', this.onUpgrade);
  }

  get clientCount(): number {
    return this.clients.size;
  }

  close(): void {
    this.server?.off('upgrade', this.onUpgrade);
    this.deps.live.off('delta', this.onDelta);
    this.deps.airports.off('change', this.onAirportsChange);
    this.stopTimers();
    for (const room of this.rooms.values()) if (room.timer) clearTimeout(room.timer);
    for (const client of this.clients) client.socket.terminate();
    this.clients.clear();
    this.rooms.clear();
    this.wss.close();
  }

  private onUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer): void => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== WS_PATH) {
      if (!this.deps.otherUpgrade?.(request, socket, head)) socket.destroy();
      return;
    }
    if (this.clients.size >= this.maxClients) {
      socket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => this.wss.emit('connection', ws, request));
  };

  private onConnection(socket: WebSocket): void {
    const client: Client = { socket, icao: null, missedPings: 0 };
    this.clients.add(client);
    this.startTimers();
    this.send(client, {
      type: 'hello',
      serverTime: this.now(),
      version: this.deps.version,
      pingIntervalMs: this.pingIntervalMs,
    });

    socket.on('pong', () => {
      client.missedPings = 0;
    });
    socket.on('message', (data, isBinary) => {
      if (isBinary) {
        this.sendError(client, 'bad_message', 'binary messages are not supported');
        return;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(data.toString());
      } catch {
        this.sendError(client, 'bad_message', 'message is not valid JSON');
        return;
      }
      const message = ClientMessageSchema.safeParse(parsed);
      if (!message.success) {
        this.sendError(client, 'bad_message', 'unknown message');
        return;
      }
      switch (message.data.type) {
        case 'subscribe':
          this.subscribe(client, message.data.icao);
          break;
        case 'unsubscribe':
          this.leave(client);
          break;
        case 'pong':
          client.missedPings = 0;
          break;
      }
    });
    socket.on('close', () => this.drop(client));
    socket.on('error', (err) => {
      this.deps.log?.debug({ err: err.message }, 'websocket error');
      this.drop(client);
    });
  }

  private subscribe(client: Client, icao: string): void {
    const { airports, live } = this.deps;
    if (!airports.isConfigured(icao)) {
      this.sendError(client, 'unknown_airport', `${icao} is not a configured airport`);
      return;
    }
    if (!airports.get(icao) || !live.has(icao)) {
      this.sendError(client, 'airport_unavailable', `reference data for ${icao} is not loaded yet`);
      return;
    }
    if (client.icao !== icao) {
      this.leave(client);
      const room = this.room(icao);
      room.clients.add(client);
      client.icao = icao;
      live.setViewers(icao, room.clients.size);
    }
    const room = this.room(icao);
    // Anything still waiting to go out is already part of the snapshot the tracker hands over.
    const { aircraft, trails } = live.snapshot(icao);
    this.send(client, {
      type: 'snapshot',
      serverTime: this.now(),
      icao,
      seq: room.seq,
      aircraft,
      trails,
      status: live.status(icao),
    });
  }

  private leave(client: Client): void {
    const icao = client.icao;
    if (!icao) return;
    client.icao = null;
    const room = this.rooms.get(icao);
    if (!room) return;
    room.clients.delete(client);
    this.deps.live.setViewers(icao, room.clients.size);
    if (room.clients.size === 0) {
      if (room.timer) clearTimeout(room.timer);
      room.timer = null;
      room.pending = null;
    }
  }

  private drop(client: Client): void {
    if (!this.clients.delete(client)) return;
    this.leave(client);
    if (this.clients.size === 0) this.stopTimers();
  }

  private room(icao: string): Room {
    let room = this.rooms.get(icao);
    if (!room) {
      room = { clients: new Set(), seq: 0, lastSentAt: 0, pending: null, timer: null };
      this.rooms.set(icao, room);
    }
    return room;
  }

  private onDelta = (icao: string, delta: TrackerDelta): void => {
    const room = this.rooms.get(icao);
    if (!room || room.clients.size === 0) return;
    room.pending ??= { upserts: new Map(), removed: new Set() };
    for (const aircraft of delta.upserts) {
      room.pending.upserts.set(aircraft.hex, aircraft);
      room.pending.removed.delete(aircraft.hex);
    }
    for (const hex of delta.removed) {
      room.pending.upserts.delete(hex);
      room.pending.removed.add(hex);
    }
    const wait = room.lastSentAt + this.minDeltaIntervalMs - this.now();
    if (wait <= 0) this.flush(icao, room);
    else if (!room.timer) room.timer = setTimeout(() => this.flush(icao, room), wait);
  };

  private flush(icao: string, room: Room): void {
    if (room.timer) clearTimeout(room.timer);
    room.timer = null;
    const pending = room.pending;
    room.pending = null;
    if (!pending || room.clients.size === 0) return;
    room.seq += 1;
    room.lastSentAt = this.now();
    const message: DeltaMessage = {
      type: 'delta',
      serverTime: room.lastSentAt,
      icao,
      seq: room.seq,
      upserts: [...pending.upserts.values()],
      removed: [...pending.removed],
    };
    this.broadcast(room, message);
  }

  /** An airport that is no longer configured loses its subscribers. */
  private onAirportsChange = (): void => {
    for (const [icao, room] of this.rooms) {
      if (this.deps.airports.isConfigured(icao)) continue;
      for (const client of [...room.clients]) {
        this.sendError(client, 'unknown_airport', `${icao} is no longer configured`);
        this.leave(client);
      }
      this.rooms.delete(icao);
    }
  };

  private startTimers(): void {
    // Timers exist only while somebody is connected, so an idle server does nothing at all.
    this.pingTimer ??= setInterval(() => this.pingAll(), this.pingIntervalMs);
    this.statusTimer ??= setInterval(() => this.sendStatus(), this.statusIntervalMs);
  }

  private stopTimers(): void {
    if (this.pingTimer) clearInterval(this.pingTimer);
    if (this.statusTimer) clearInterval(this.statusTimer);
    this.pingTimer = null;
    this.statusTimer = null;
  }

  private pingAll(): void {
    const serverTime = this.now();
    for (const client of [...this.clients]) {
      if (client.missedPings >= 2) {
        client.socket.terminate();
        this.drop(client);
        continue;
      }
      client.missedPings += 1;
      // Protocol ping for dead-peer detection, plus an application ping the page can see and time.
      client.socket.ping();
      this.send(client, { type: 'ping', serverTime });
    }
  }

  private sendStatus(): void {
    for (const [icao, room] of this.rooms) {
      if (room.clients.size === 0) continue;
      this.broadcast(room, {
        type: 'status',
        serverTime: this.now(),
        icao,
        status: this.deps.live.status(icao),
      });
    }
  }

  private broadcast(room: Room, message: ServerMessage): void {
    const data = JSON.stringify(message);
    for (const client of [...room.clients]) this.sendRaw(client, data);
  }

  private send(client: Client, message: ServerMessage): void {
    this.sendRaw(client, JSON.stringify(message));
  }

  private sendRaw(client: Client, data: string): void {
    const { socket } = client;
    if (socket.readyState !== socket.OPEN) return;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      this.deps.log?.warn(
        { buffered: socket.bufferedAmount },
        'dropping a websocket client that cannot keep up',
      );
      socket.terminate();
      this.drop(client);
      return;
    }
    socket.send(data);
  }

  private sendError(client: Client, code: ErrorMessage['code'], message: string): void {
    this.send(client, { type: 'error', serverTime: this.now(), code, message });
  }
}
