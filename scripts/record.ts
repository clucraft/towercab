/**
 * Records live traffic at an airport into a JSON Lines file that `?replay=<name>` can play back.
 *
 *   pnpm record --airport KIND --minutes 5 --out kind-busy
 *       Records what a browser would receive from a running TowerCab server (its WebSocket feed), whatever
 *       mix of sources that server uses. The file goes to .local/data/replays/, where the dev server finds it.
 *       On a deployed server, copy it to /data/replays/.
 *
 *   pnpm record --airport KLAF --minutes 4 --out klaf-pattern --direct adsblol --public
 *       Polls one source directly, through the same tracker the server uses. This is how the recordings that
 *       ship with the app are made: adsb.lol's data is ODbL, so it may be redistributed with attribution.
 *       Asks every 7 seconds by default (`--interval`). adsb.lol has an unpublished short-term limit: it
 *       refused after nine requests 2 s apart, and after about 80 requests in ten minutes at 7 s apart. The
 *       recording stops at the first refusal and keeps what it has, so keep these to a few minutes.
 *       `--public` writes to apps/web/public/replays/, which is committed.
 *
 * Both need a running server (`--url`) for the airport's reference data and the METAR.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { AGGREGATORS, createAggregatorSource } from '../apps/server/src/providers/aggregators';
import { AirportTracker } from '../apps/server/src/tracking/tracker';
import type { AirportDetail, AirportStatus, Metar, ServerMessage } from '../packages/shared/src/index';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    airport: { type: 'string' },
    minutes: { type: 'string', default: '5' },
    out: { type: 'string' },
    direct: { type: 'string' },
    public: { type: 'boolean', default: false },
    interval: { type: 'string', default: '7' },
  },
});

const base = (values.url as string).replace(/\/+$/, '');
const icao = (values.airport ?? '').toUpperCase();
const minutes = Number(values.minutes);
const name = values.out ?? `${icao.toLowerCase()}-${new Date().toISOString().slice(0, 10)}`;
if (!icao)
  throw new Error(
    'usage: pnpm record --airport KIND [--minutes 5] [--out name] [--direct adsblol] [--public]',
  );
if (!/^[a-z0-9-]{1,64}$/i.test(name)) throw new Error('--out may contain letters, digits and "-" only');
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--minutes must be a positive number');

const USER_AGENT = 'TowerCab-recorder/0.1 (+https://github.com/clucraft/towercab)';
const LICENSES: Record<string, { label: string; license: string }> = {
  adsblol: { label: 'adsb.lol', license: 'ODbL 1.0' },
  adsbfi: { label: 'adsb.fi', license: 'adsb.fi open data terms: personal, non-commercial use' },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function main(): Promise<void> {
  const airport = (await (await fetch(`${base}/api/airports/${icao}`)).json()) as AirportDetail & {
    error?: string;
  };
  if (airport.error) throw new Error(`${base} does not know ${icao}`);
  const root = join(import.meta.dirname, '..');
  const dir = values.public
    ? join(root, 'apps', 'web', 'public', 'replays')
    : join(root, '.local', 'data', 'replays');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `${name}.jsonl`);
  const out = createWriteStream(file);
  const write = (value: unknown) => out.write(`${JSON.stringify(value)}\n`);
  let messages = 0;
  let aircraftSeen = 0;
  const seen = new Set<string>();
  const record = (message: ServerMessage) => {
    write(message);
    messages += 1;
    const list =
      message.type === 'snapshot' ? message.aircraft : message.type === 'delta' ? message.upserts : [];
    for (const a of list) seen.add(a.hex);
    aircraftSeen = seen.size;
  };
  const endAt = Date.now() + minutes * 60_000;

  if (values.direct) {
    const id = values.direct as keyof typeof AGGREGATORS;
    const def = AGGREGATORS[id];
    const terms = LICENSES[id];
    if (!def || !terms) throw new Error(`--direct must be one of: ${Object.keys(LICENSES).join(', ')}`);
    const source = createAggregatorSource(def, { userAgent: USER_AGENT });
    const metar = ((await (await fetch(`${base}/api/metar/${icao}`)).json()) as { metar: Metar | null })
      .metar;
    const tracker = new AirportTracker(() => ({
      lat: airport.lat,
      lon: airport.lon,
      elevationFt: airport.elevationFt,
      geoidUndulationM: airport.geoidUndulationM,
      radiusNm: airport.radiusNm,
      ceilingFtAgl: airport.ceilingFtAgl,
      runways: airport.runways,
      qnhHpa: metar?.altimHpa ?? tracker.aircraftQnhHpa(),
      tempC: metar?.tempC ?? null,
    }));
    // adsb.lol answers 429 after about nine requests two seconds apart, well inside its daily allowance,
    // so the default pace here is gentle.
    const intervalMs = Math.max(2, Number(values.interval)) * 1000;
    let requests = 0;
    let failures = 0;
    const status = (now: number): AirportStatus => ({
      pollState: 'active',
      viewers: 1,
      lastPollAt: now,
      qnhHpa: metar?.altimHpa ?? undefined,
      providers: [
        {
          id,
          label: terms.label,
          enabled: true,
          state: 'ok',
          priority: 1,
          requests,
          failures,
          rateLimited: 0,
          lastSuccessAt: now,
        },
      ],
    });

    write({
      type: 'meta',
      version: 1,
      airport: icao,
      recordedAt: Date.now(),
      sources: [terms.label],
      license: terms.license,
      // How far apart the positions are. Playback draws this far behind, so it moves between positions
      // instead of guessing ahead of them.
      intervalMs,
      note: `Recorded with scripts/record.ts --direct ${id}. Positions (c) ${terms.label} contributors.`,
    });
    console.log(`${stamp()} recording ${icao} from ${terms.label} for ${minutes} min into ${file}`);
    let seq = 0;
    record({
      type: 'snapshot',
      serverTime: Date.now(),
      icao,
      seq,
      aircraft: [],
      trails: {},
      status: status(Date.now()),
    });
    while (Date.now() < endAt) {
      const started = Date.now();
      try {
        requests += 1;
        const result = await source.fetchArea(airport.lat, airport.lon, airport.radiusNm);
        tracker.ingest(result.observations, 1, result.receivedAt);
      } catch (err) {
        failures += 1;
        console.log(`${stamp()} fetch failed: ${(err as Error).message}`);
        // A refusal or a rate limit will not get better by hammering: stop here with what we have.
        if (/HTTP (401|403|429)/.test((err as Error).message)) break;
      }
      const now = Date.now();
      const delta = tracker.commit(now);
      if (delta.upserts.length > 0 || delta.removed.length > 0) {
        seq += 1;
        record({ type: 'delta', serverTime: now, icao, seq, upserts: delta.upserts, removed: delta.removed });
      }
      if (requests % 15 === 0) {
        record({ type: 'status', serverTime: now, icao, status: status(now) });
        console.log(
          `${stamp()} ${tracker.size} aircraft now, ${aircraftSeen} seen, ${messages} messages, ${requests} requests`,
        );
      }
      await sleep(Math.max(0, intervalMs - (Date.now() - started)));
    }
  } else {
    write({
      type: 'meta',
      version: 1,
      airport: icao,
      recordedAt: Date.now(),
      sources: ['as configured on the recording server'],
      license:
        'See the terms of the sources the server used. Not for redistribution unless they all allow it.',
    });
    console.log(`${stamp()} recording ${icao} from ${base} for ${minutes} min into ${file}`);
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', icao })));
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data)) as ServerMessage;
      if (message.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: message.serverTime }));
      else if (message.type === 'error') console.log(`${stamp()} server: ${message.message}`);
      else if (message.type === 'snapshot' || message.type === 'delta' || message.type === 'status')
        record(message);
    });
    const closed = new Promise<void>((resolve) => ws.addEventListener('close', () => resolve()));
    while (Date.now() < endAt && ws.readyState <= 1) {
      await sleep(Math.min(30_000, Math.max(0, endAt - Date.now())));
      console.log(`${stamp()} ${aircraftSeen} aircraft seen, ${messages} messages`);
    }
    ws.close();
    await Promise.race([closed, sleep(2000)]);
  }

  await new Promise<void>((resolve) => out.end(resolve));
  console.log(
    `${stamp()} done: ${messages} messages, ${aircraftSeen} aircraft. Play it at /${icao}?replay=${name}`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
