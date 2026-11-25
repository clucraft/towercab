/**
 * Measures what the 3D scene costs on a phone-like device: a small touch screen in Chromium with the CPU slowed
 * down. It is a stand-in, not a phone: the GPU here is the computer's own, so numbers are for comparing one build
 * with another, and for finding which code takes the time.
 *
 *   pnpm profile:phone                                # Photoreal and Schematic at KLAF, tower view
 *   pnpm profile:phone --airport KIND --view overhead --slowdown 6
 *   pnpm profile:phone --query "quality=high"         # extra query parameters
 *   pnpm profile:phone --url http://host:8790 --out profile.json
 */
import { writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { type CDPSession, chromium } from '@playwright/test';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    airport: { type: 'string', default: 'KLAF' },
    view: { type: 'string', default: 'tower' },
    sim: { type: 'string', default: '20' },
    modes: { type: 'string', default: 'photoreal,schematic' },
    slowdown: { type: 'string', default: '6' },
    /** Seconds for the first tiles to arrive, then seconds measured. */
    settle: { type: 'string', default: '25' },
    seconds: { type: 'string', default: '15' },
    query: { type: 'string', default: '' },
    desktop: { type: 'boolean', default: false },
    /** Turns the view during the measurement, as a finger would. */
    drag: { type: 'boolean', default: false },
    /** Draws in software, so that the cost of drawing shows. */
    software: { type: 'boolean', default: false },
    /** JavaScript run in the page before measuring, for trying things out. */
    eval: { type: 'string' },
    shot: { type: 'string' },
    out: { type: 'string' },
  },
});

interface ProfileNode {
  id: number;
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  children?: number[];
}

/** Where the main thread spent its time, by function, in milliseconds. */
async function profile(cdp: CDPSession, work: () => Promise<void>): Promise<{ name: string; ms: number }[]> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  await work();
  const { profile: result } = (await cdp.send('Profiler.stop')) as unknown as {
    profile: { nodes: ProfileNode[]; samples: number[]; timeDeltas: number[] };
  };
  const byId = new Map(result.nodes.map((n) => [n.id, n]));
  const self = new Map<string, number>();
  result.samples.forEach((id, i) => {
    const frame = byId.get(id)?.callFrame;
    if (!frame) return;
    const name = frame.functionName || `(anonymous ${frame.lineNumber}:${frame.columnNumber})`;
    self.set(name, (self.get(name) ?? 0) + (result.timeDeltas[i] ?? 0) / 1000);
  });
  return [...self].map(([name, ms]) => ({ name, ms })).sort((a, b) => b.ms - a.ms);
}

async function main(): Promise<void> {
  const base = (values.url as string).replace(/\/+$/, '');
  const browser = await chromium.launch({
    args: values.software
      ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader']
      : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const results: unknown[] = [];
  for (const mode of (values.modes as string).split(',')) {
    const context = await browser.newContext(
      values.desktop
        ? { viewport: { width: 1600, height: 900 } }
        : {
            viewport: { width: 412, height: 839 },
            deviceScaleFactor: 2.625,
            isMobile: true,
            hasTouch: true,
            userAgent:
              'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Mobile Safari/537.36',
          },
    );
    const page = await context.newPage();
    await page.addInitScript('window.__name = (fn) => fn;');
    // Counts the calls that make the CPU wait for the GPU.
    await page.addInitScript(() => {
      const counts = { reads: 0, readBytes: 0, readMs: 0, draws: 0, triangles: 0 };
      (window as unknown as { __gl: typeof counts }).__gl = counts;
      const proto = WebGL2RenderingContext.prototype;
      const read = proto.getBufferSubData;
      proto.getBufferSubData = function (this: WebGL2RenderingContext, ...args: never[]) {
        const t = performance.now();
        (read as (...a: never[]) => void).apply(this, args);
        counts.reads += 1;
        counts.readBytes += (args[2] as unknown as ArrayBufferView)?.byteLength ?? 0;
        counts.readMs += performance.now() - t;
      } as typeof read;
      const elements = proto.drawElements;
      proto.drawElements = function (this: WebGL2RenderingContext, ...args) {
        counts.draws += 1;
        counts.triangles += args[1] / 3;
        elements.apply(this, args);
      };
    });
    const cdp = await context.newCDPSession(page);
    const errors: string[] = [];
    page.on('pageerror', (err) => errors.push(err.message));
    const query = [`mode=${mode}`, `view=${values.view}`, `sim=${values.sim}`, values.query]
      .filter(Boolean)
      .join('&');
    await cdp.send('Emulation.setCPUThrottlingRate', { rate: values.desktop ? 1 : Number(values.slowdown) });
    const started = Date.now();
    await page.goto(`${base}/${values.airport}?${query}`);
    await page.waitForFunction(() => (window as { __towercab?: unknown }).__towercab !== undefined, null, {
      timeout: 120_000,
    });
    const readyMs = Date.now() - started;
    await page.waitForTimeout(Number(values.settle) * 1000);
    if (values.eval) {
      await page.evaluate(values.eval);
      await page.waitForTimeout(3000);
    }

    const top = await profile(cdp, async () => {
      await page.evaluate(() => {
        const w = window as unknown as { __gl: Record<string, number>; __frames: number[]; __stop: boolean };
        for (const key of Object.keys(w.__gl)) w.__gl[key] = 0;
        w.__frames = [];
        w.__stop = false;
        const scene = (
          window as unknown as {
            __towercab: { viewer: { scene: { postRender: { addEventListener(fn: () => void): void } } } };
          }
        ).__towercab.viewer.scene;
        let last = performance.now();
        scene.postRender.addEventListener(() => {
          const now = performance.now();
          w.__frames.push(now - last);
          last = now;
        });
      });
      if (values.drag) {
        const end = Date.now() + Number(values.seconds) * 1000;
        let direction = 1;
        while (Date.now() < end) {
          await page.mouse.move(206, 420);
          await page.mouse.down();
          for (let i = 0; i < 20; i += 1) {
            await page.mouse.move(206 + direction * i * 6, 420);
            await page.waitForTimeout(30);
          }
          await page.mouse.up();
          direction = -direction;
        }
      } else {
        await page.waitForTimeout(Number(values.seconds) * 1000);
      }
    });

    const measured = await page.evaluate(() => {
      interface Tileset {
        maximumScreenSpaceError: number;
        memoryAdjustedScreenSpaceError: number;
        totalMemoryUsageInBytes: number;
        cacheBytes: number;
        statistics: Record<string, number>;
      }
      const w = window as unknown as {
        __gl: Record<string, number>;
        __frames: number[];
        __towercab: {
          mode: string;
          tileset: Tileset | null;
          viewer: { scene: { drawingBufferWidth: number; drawingBufferHeight: number; msaaSamples: number } };
        };
      };
      const frames = [...w.__frames].sort((a, b) => a - b);
      const total = frames.reduce((a, b) => a + b, 0);
      const tileset = w.__towercab.tileset;
      const perFrame = (n: number | undefined) =>
        Math.round(((n ?? 0) / Math.max(1, frames.length)) * 10) / 10;
      return {
        mode: w.__towercab.mode,
        frames: frames.length,
        fps: Math.round((frames.length / (total / 1000)) * 10) / 10,
        p50: Math.round(frames[Math.floor(frames.length * 0.5)] ?? 0),
        p95: Math.round(frames[Math.floor(frames.length * 0.95)] ?? 0),
        worst: Math.round(frames[frames.length - 1] ?? 0),
        buffer: `${w.__towercab.viewer.scene.drawingBufferWidth}x${w.__towercab.viewer.scene.drawingBufferHeight}`,
        msaa: w.__towercab.viewer.scene.msaaSamples,
        drawsPerFrame: perFrame(w.__gl.draws),
        trianglesPerFrame: Math.round(perFrame(w.__gl.triangles)),
        gpuReadsPerFrame: perFrame(w.__gl.reads),
        gpuReadMsPerFrame: perFrame(w.__gl.readMs),
        gpuReadKbPerFrame: perFrame((w.__gl.readBytes ?? 0) / 1024),
        tiles: tileset
          ? {
              sse: tileset.maximumScreenSpaceError,
              adjustedSse: Math.round(tileset.memoryAdjustedScreenSpaceError),
              memoryMb: Math.round(tileset.totalMemoryUsageInBytes / 1048576),
              cacheMb: Math.round(tileset.cacheBytes / 1048576),
              selected: tileset.statistics.selected,
              loaded: tileset.statistics.numberOfTilesWithContentReady,
              triangles: tileset.statistics.numberOfTrianglesSelected,
              pending: tileset.statistics.numberOfPendingRequests,
            }
          : null,
      };
    });
    if (values.shot) await page.screenshot({ path: values.shot.replace('%', mode) });
    console.log(`\n${values.airport} ${mode} ${values.view} (${query}): ready after ${readyMs} ms`);
    console.log(JSON.stringify(measured, null, 1));
    console.log('main thread, self time (ms over the measurement):');
    for (const { name, ms } of top.slice(0, 18)) console.log(`  ${ms.toFixed(0).padStart(6)}  ${name}`);
    if (errors.length > 0) console.log('page errors:', errors);
    results.push({ ...measured, top: top.slice(0, 40) });
    await context.close();
  }
  await browser.close();
  if (values.out) writeFileSync(values.out, JSON.stringify(results, null, 2));
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
