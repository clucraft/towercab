/**
 * Soak test: watches every configured airport on a running TowerCab server for a while and checks that the
 * upstream services never answered 429 (rate limited).
 *
 *   pnpm soak                                   # 30 minutes against http://localhost:8790
 *   pnpm soak --minutes 5 --url http://host:8790
 *   pnpm soak --check-pause                     # afterwards, wait and confirm polling stops with no viewers
 *
 * It acts as a browser would: one WebSocket subscription per airport. Numbers come from /metrics.
 * Exit code 0 means no 429s (and, with --check-pause, that polling stopped).
 */
import { parseArgs } from 'node:util';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    minutes: { type: 'string', default: '30' },
    airports: { type: 'string' },
    'check-pause': { type: 'boolean', default: false },
  },
});

const base = (values.url as string).replace(/\/+$/, '');
const minutes = Number(values.minutes);
if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('--minutes must be a positive number');

interface Sample {
  provider: string;
  status: string;
  count: number;
}

async function metrics(): Promise<{ responses: Sample[]; states: Map<string, string>; text: string }> {
  const text = await (await fetch(`${base}/metrics`)).text();
  const responses: Sample[] = [];
  const states = new Map<string, string>();
  for (const line of text.split('\n')) {
    let m = /^towercab_provider_responses_total\{provider="([^"]+)",status="([^"]+)"\} (\d+)/.exec(line);
    if (m) responses.push({ provider: m[1] as string, status: m[2] as string, count: Number(m[3]) });
    m = /^towercab_poll_state\{airport="([^"]+)",state="([^"]+)"\} 1$/.exec(line);
    if (m) states.set(m[1] as string, m[2] as string);
  }
  return { responses, states, text };
}

function summarise(responses: Sample[]): string {
  const byProvider = new Map<string, string[]>();
  for (const r of responses) {
    const list = byProvider.get(r.provider) ?? [];
    list.push(`${r.status}×${r.count}`);
    byProvider.set(r.provider, list);
  }
  return [...byProvider].map(([p, list]) => `${p}: ${list.join(' ')}`).join(' | ') || 'no requests yet';
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const stamp = () => new Date().toISOString().slice(11, 19);

async function main(): Promise<number> {
  const configured = (await (await fetch(`${base}/api/airports`)).json()) as {
    icao: string;
    available: boolean;
  }[];
  const wanted = values.airports
    ? (values.airports as string).split(',').map((s) => s.trim().toUpperCase())
    : configured.filter((a) => a.available).map((a) => a.icao);
  if (wanted.length === 0) throw new Error('no airports to watch');

  const before = await metrics();
  const baseline = new Map(before.responses.map((r) => [`${r.provider}|${r.status}`, r.count]));
  console.log(`${stamp()} soak: ${minutes} min, airports ${wanted.join(', ')}, server ${base}`);

  const stats = new Map(
    wanted.map((icao) => [icao, { deltas: 0, aircraft: 0, maxAircraft: 0, lastDeltaAt: 0, gaps: 0 }]),
  );
  const sockets = wanted.map((icao) => {
    const ws = new WebSocket(`${base.replace(/^http/, 'ws')}/ws`);
    const s = stats.get(icao);
    if (!s) throw new Error('unreachable');
    const seen = new Set<string>();
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'subscribe', icao })));
    ws.addEventListener('message', (event) => {
      const m = JSON.parse(String(event.data));
      if (m.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: m.serverTime }));
      if (m.type === 'snapshot') {
        seen.clear();
        for (const a of m.aircraft) seen.add(a.hex);
      }
      if (m.type === 'delta') {
        const now = Date.now();
        // More than 15 s without any change while aircraft are present suggests the feed stalled.
        if (s.lastDeltaAt && now - s.lastDeltaAt > 15_000 && seen.size > 0) s.gaps += 1;
        s.lastDeltaAt = now;
        s.deltas += 1;
        for (const a of m.upserts) seen.add(a.hex);
        for (const hex of m.removed) seen.delete(hex);
      }
      s.aircraft = seen.size;
      s.maxAircraft = Math.max(s.maxAircraft, seen.size);
    });
    ws.addEventListener('close', () => console.log(`${stamp()} ${icao}: socket closed`));
    return ws;
  });

  const endAt = Date.now() + minutes * 60_000;
  let total429 = 0;
  while (Date.now() < endAt) {
    await sleep(Math.min(60_000, Math.max(1000, endAt - Date.now())));
    const now = await metrics();
    const sinceStart = now.responses
      .map((r) => ({ ...r, count: r.count - (baseline.get(`${r.provider}|${r.status}`) ?? 0) }))
      .filter((r) => r.count > 0);
    total429 = sinceStart.filter((r) => r.status === '429').reduce((sum, r) => sum + r.count, 0);
    const traffic = [...stats].map(([icao, s]) => `${icao} ${s.aircraft} ac, ${s.deltas} deltas`).join('; ');
    console.log(`${stamp()} ${traffic} || ${summarise(sinceStart)}`);
  }

  for (const ws of sockets) ws.close();
  let failed = false;

  console.log(`\n${stamp()} result`);
  for (const [icao, s] of stats) {
    console.log(
      `  ${icao}: ${s.deltas} deltas, up to ${s.maxAircraft} aircraft at once, ${s.gaps} gaps longer than 15 s`,
    );
    if (s.deltas === 0) {
      console.log(`  FAIL ${icao}: no live data was received`);
      failed = true;
    }
  }
  if (total429 > 0) {
    console.log(`  FAIL: ${total429} responses with status 429`);
    failed = true;
  } else {
    console.log('  no 429 responses');
  }

  if (values['check-pause']) {
    // Give the server a moment to notice the sockets closing, then wait out idle + pause.
    await sleep(2000);
    const start = await metrics();
    console.log(
      `${stamp()} viewers gone; states now: ${[...start.states].map(([a, s]) => `${a}=${s}`).join(', ')}`,
    );
    const deadline = Date.now() + 15 * 60_000;
    let paused = false;
    while (Date.now() < deadline) {
      await sleep(15_000);
      const m = await metrics();
      if (wanted.every((icao) => m.states.get(icao) === 'paused')) {
        paused = true;
        break;
      }
    }
    if (!paused) {
      console.log('  FAIL: polling did not pause within 15 minutes of the last viewer leaving');
      failed = true;
    } else {
      const atPause = await metrics();
      const requests = (m: Sample[]) => m.reduce((sum, r) => sum + r.count, 0);
      await sleep(90_000);
      const later = await metrics();
      const extra = requests(later.responses) - requests(atPause.responses);
      if (extra > 0) {
        console.log(`  FAIL: ${extra} upstream requests were made while paused`);
        failed = true;
      } else {
        console.log('  polling paused, and no upstream requests in the following 90 s');
      }
    }
  }
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(2);
  },
);
