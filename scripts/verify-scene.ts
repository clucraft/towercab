/**
 * Measures the things Phase 2 promises about the 3D scene, in a real browser with the GPU on:
 *
 * - motion: frame by frame, no aircraft jumps, moves backwards or snaps its heading;
 * - surface: aircraft on the ground are drawn on the surface under them, and one that lands comes down onto it.
 *
 *   pnpm verify:scene                       # simulated traffic at KIND, both base maps
 *   pnpm verify:scene --live --airport KLAF # the motion check against live traffic
 *   pnpm verify:scene --url http://host:8790
 *
 * Exit code 0 when every check passes.
 */
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    airport: { type: 'string', default: 'KIND' },
    seconds: { type: 'string', default: '45' },
    live: { type: 'boolean', default: false },
    modes: { type: 'string', default: 'schematic,photoreal' },
  },
});

interface FrameLog {
  frames: number;
  aircraft: number;
  /** Largest movement in one frame, as a multiple of what the aircraft's speed allows. */
  worstStepRatio: number;
  jumps: { hex: string; metres: number; allowed: number }[];
  backwards: { hex: string; metres: number }[];
  headingSnaps: { hex: string; degrees: number }[];
  /** Largest gap between a ground aircraft and the surface it stands on, metres. */
  worstGroundGapM: number;
  /** Which aircraft that was, for the report. */
  worstGround: string;
  groundSamples: number;
  /** Aircraft seen going from airborne to on the ground during the run. */
  landings: number;
  /** Of those, how far above the surface each was once its wheels were down, metres (largest). */
  worstLandingGapM: number;
  mode: string;
}

/** Runs in the page: watches every aircraft for `seconds` and summarises what it saw. */
async function watch(page: Page, seconds: number, simulated: boolean): Promise<FrameLog> {
  return page.evaluate(
    async ({ durationS, simulated }) => {
      interface Drawn {
        hex: string;
        lat: number;
        lon: number;
        height: number;
        heading: number;
        onGround: boolean;
        visible: boolean;
        alpha: number;
        data: { gsKt?: number; onGround: boolean; phase: string; typeCode?: string };
      }
      interface Scene {
        mode: string;
        layer: { list(): Iterable<Drawn> };
        ground: { peek(lon: number, lat: number): number | undefined };
      }
      const scene = (window as unknown as { __towercab: Scene }).__towercab;
      const previous = new Map<
        string,
        {
          lat: number;
          lon: number;
          heading: number;
          t: number;
          onGround: boolean;
          height: number;
          east: number;
          north: number;
        }
      >();
      const result = {
        frames: 0,
        aircraft: 0,
        worstStepRatio: 0,
        jumps: [] as { hex: string; metres: number; allowed: number }[],
        backwards: [] as { hex: string; metres: number }[],
        headingSnaps: [] as { hex: string; degrees: number }[],
        worstGroundGapM: 0,
        worstGround: '',
        groundSamples: 0,
        landings: 0,
        worstLandingGapM: 0,
        mode: scene.mode,
      };
      const landed = new Map<string, number>();
      const seen = new Set<string>();
      const RAD = Math.PI / 180;
      const end = performance.now() + durationS * 1000;

      /** How far a ground aircraft is from the surface under it, once that surface is known. */
      const settledSince = new Map<string, number>();
      /** When each aircraft's current gap from the surface began. */
      const gapStarted = new Map<string, number>();
      const checkSurface = (a: Drawn, now: number) => {
        const surface = scene.ground.peek(a.lon, a.lat);
        if (surface === undefined) {
          settledSince.delete(a.hex);
          return;
        }
        // The drawn height follows the surface with a short lag; judge it once it has had a second to settle.
        const offSince = gapStarted;
        const since = settledSince.get(a.hex) ?? now;
        settledSince.set(a.hex, since);
        if (now - since < 1000) return;
        const gap = Math.abs(a.height - surface);
        const touchdown = landed.get(a.hex);
        if (touchdown !== undefined) {
          if (now - touchdown < 1500) return;
          result.worstLandingGapM = Math.max(result.worstLandingGapM, gap);
          landed.delete(a.hex);
          result.landings += 1;
        } else {
          result.groundSamples += 1;
          // Photogrammetry has bumps (an aircraft that stood on the runway when it was captured). A fast
          // aircraft is over one for a fraction of a second and is deliberately not bounced over it, so
          // only a gap that lasts counts.
          if (gap <= 0.5) {
            offSince.delete(a.hex);
            result.worstGroundGapM = Math.max(result.worstGroundGapM, gap);
            return;
          }
          const started = offSince.get(a.hex) ?? now;
          offSince.set(a.hex, started);
          if (now - started > 1200 && gap > result.worstGroundGapM) {
            result.worstGroundGapM = gap;
            result.worstGround = `${a.hex} ${a.data.typeCode ?? ''} ${a.data.phase}, drawn at ${a.height.toFixed(1)} m, surface ${surface.toFixed(1)} m`;
          }
        }
      };

      await new Promise<void>((resolve) => {
        const frame = (now: number) => {
          result.frames += 1;
          for (const a of scene.layer.list()) {
            if (!a.visible || a.alpha < 0.99) {
              previous.delete(a.hex);
              continue;
            }
            seen.add(a.hex);
            const before = previous.get(a.hex);
            let step = { east: 0, north: 0 };
            if (before) {
              const dt = (now - before.t) / 1000;
              const north = (a.lat - before.lat) * RAD * 6371008.8;
              const east = (a.lon - before.lon) * RAD * 6371008.8 * Math.cos(a.lat * RAD);
              const moved = Math.hypot(east, north);
              // What its speed allows in this frame, with room for acceleration and catching up.
              const speed = Math.max((a.data.gsKt ?? 0) * 0.514444, 3);
              const allowed = speed * dt * 2 + 0.5;
              result.worstStepRatio = Math.max(result.worstStepRatio, moved / allowed);
              if (moved > allowed && result.jumps.length < 10) {
                result.jumps.push({
                  hex: a.hex,
                  metres: Number(moved.toFixed(2)),
                  allowed: Number(allowed.toFixed(2)),
                });
              }
              // A reversal: this frame's movement points against the previous frame's.
              const beforeStep = Math.hypot(before.east, before.north);
              if (moved > 0.15 && beforeStep > 0.15) {
                const along = (east * before.east + north * before.north) / beforeStep;
                if (along < -0.15 && result.backwards.length < 10) {
                  result.backwards.push({ hex: a.hex, metres: Number(along.toFixed(2)) });
                }
              }
              const turn = Math.abs(((((a.heading - before.heading) % 360) + 540) % 360) - 180);
              if (turn > 8 && result.headingSnaps.length < 10) {
                result.headingSnaps.push({ hex: a.hex, degrees: Number(turn.toFixed(1)) });
              }
              if (!before.onGround && a.onGround) landed.set(a.hex, now);
              step = { east, north };
            }
            // On the ground according to the newest report as well: an aircraft lifting off is still "on the
            // ground" for half an update while it is already climbing.
            // Simulated taxi routes are straight lines that know nothing of buildings, and in Photoreal
            // they run through terminals, where the surface is a roof. They are left out of this check;
            // parked aircraft, take-off and landing rolls and everything live is judged.
            const judged = !simulated || a.data.phase !== 'taxiing';
            if (a.onGround && a.data.onGround && judged) checkSurface(a, now);
            else settledSince.delete(a.hex);
            previous.set(a.hex, {
              lat: a.lat,
              lon: a.lon,
              heading: a.heading,
              t: now,
              onGround: a.onGround,
              height: a.height,
              east: step.east,
              north: step.north,
            });
          }
          if (now < end) requestAnimationFrame(frame);
          else resolve();
        };
        requestAnimationFrame(frame);
      });
      result.aircraft = seen.size;
      return result;
    },
    { durationS: seconds, simulated },
  );
}

async function main(): Promise<number> {
  const base = (values.url as string).replace(/\/+$/, '');
  const seconds = Number(values.seconds);
  const browser = await chromium.launch({
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  let failed = false;

  for (const mode of (values.modes as string).split(',')) {
    const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
    // tsx wraps named functions in a `__name` helper; the function sent to the page needs it to exist there.
    await page.addInitScript('window.__name = (fn) => fn;');
    const query = values.live ? `mode=${mode}&view=orbit` : `sim=150&mode=${mode}&view=orbit`;
    await page.goto(`${base}/${values.airport}?${query}`);
    await page.waitForFunction(
      () => (window as unknown as { __towercab?: unknown }).__towercab !== undefined,
      null,
      {
        timeout: 60_000,
      },
    );
    // Let the base map and the first surface heights load before judging anything.
    await page.waitForTimeout(12_000);
    const log = await watch(page, seconds, !values.live);
    await page.close();

    const problems: string[] = [];
    if (log.mode !== mode) problems.push(`the scene is in ${log.mode} mode (fell back?)`);
    if (log.aircraft === 0) problems.push('no aircraft were drawn');
    if (log.jumps.length > 0)
      problems.push(`${log.jumps.length} jumps, e.g. ${JSON.stringify(log.jumps[0])}`);
    if (log.backwards.length > 0)
      problems.push(`${log.backwards.length} backward steps, e.g. ${JSON.stringify(log.backwards[0])}`);
    if (log.headingSnaps.length > 0)
      problems.push(`${log.headingSnaps.length} heading snaps, e.g. ${JSON.stringify(log.headingSnaps[0])}`);
    if (log.worstGroundGapM > 0.5)
      problems.push(
        `a ground aircraft was ${log.worstGroundGapM.toFixed(2)} m off the surface (${log.worstGround})`,
      );
    if (log.worstLandingGapM > 0.5)
      problems.push(`a landed aircraft was ${log.worstLandingGapM.toFixed(2)} m off the surface`);

    console.log(
      `${values.airport} ${mode}${values.live ? ' (live)' : ' (150 simulated)'}: ${log.frames} frames in ${seconds} s, ${log.aircraft} aircraft, ` +
        `largest step ${log.worstStepRatio.toFixed(2)} of the allowance, ` +
        `${log.groundSamples} ground checks (worst gap ${log.worstGroundGapM.toFixed(2)} m), ` +
        `${log.landings} landings (worst gap after touchdown ${log.worstLandingGapM.toFixed(2)} m)`,
    );
    if (problems.length > 0) {
      failed = true;
      for (const problem of problems) console.log(`  FAIL: ${problem}`);
    } else {
      console.log('  ok: no jumps, no backward steps, no heading snaps, wheels on the surface');
    }
  }
  await browser.close();
  return failed ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
