/**
 * Opens a TowerCab page in a real Chromium with the GPU enabled, waits, and reports what the scene says about
 * itself: frame rate, aircraft drawn, mode. Optionally saves a screenshot.
 *
 *   pnpm probe "http://localhost:8790/KIND?sim=150&mode=schematic" --wait 20 --shot kind.png
 *   pnpm probe <url> --do "window.__towercab.follow('a1b2c3')" --shot follow.png
 *
 * Used for the frame-rate check with simulated traffic and for looking at the scene from a script.
 */
import { parseArgs } from 'node:util';
import { chromium } from '@playwright/test';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    wait: { type: 'string', default: '15' },
    shot: { type: 'string' },
    width: { type: 'string', default: '1600' },
    height: { type: 'string', default: '900' },
    eval: { type: 'string' },
    do: { type: 'string' },
    cpu: { type: 'string' },
    headed: { type: 'boolean', default: false },
    software: { type: 'boolean', default: false },
  },
});

const url = positionals[0] ?? '';
if (!url) throw new Error('usage: pnpm probe <url> [--wait seconds] [--shot file.png] [--eval "js"]');

interface SceneHandle {
  stats(): { fps: number; frameMs: number; scriptMs: number; aircraft: number; mode: string };
}

async function main(): Promise<void> {
  const browser = await chromium.launch({
    headless: !values.headed,
    // Use the machine's GPU; headless Chromium otherwise renders WebGL in software.
    args: values.software ? [] : ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({
    viewport: { width: Number(values.width), height: Number(values.height) },
  });
  const errors: string[] = [];
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text().slice(0, 1200));
  });
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message.slice(0, 300)}`));

  if (values.cpu) {
    // Slow the page's CPU down by a factor, to see how a weaker machine would cope. The GPU is not slowed.
    const session = await page.context().newCDPSession(page);
    await session.send('Emulation.setCPUThrottlingRate', { rate: Number(values.cpu) });
  }
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const renderer = await page.evaluate(() => {
    const gl = document.createElement('canvas').getContext('webgl2');
    const info = gl?.getExtension('WEBGL_debug_renderer_info');
    return info && gl ? String(gl.getParameter(info.UNMASKED_RENDERER_WEBGL)) : 'unknown';
  });

  const seconds = Number(values.wait);
  const samples: {
    t: number;
    fps: number;
    frameMs: number;
    scriptMs: number;
    aircraft: number;
    mode: string;
  }[] = [];
  const notices = new Set<string>();
  const started = Date.now();
  while (Date.now() - started < seconds * 1000) {
    await page.waitForTimeout(1000);
    const sample = await page.evaluate(() => {
      const scene = (window as unknown as { __towercab?: SceneHandle }).__towercab;
      return {
        stats: scene ? scene.stats() : null,
        notices: [...document.querySelectorAll('.notice')].map((n) => n.textContent ?? ''),
      };
    });
    for (const n of sample.notices) notices.add(n);
    if (sample.stats) {
      // `--do` runs once, as soon as the scene exists: select something, move the camera, and so on.
      if (values.do && samples.length === 0) await page.evaluate(values.do as string);
      samples.push({ t: Math.round((Date.now() - started) / 1000), ...sample.stats });
    }
  }

  // The frame rate once things have settled: the second half of the run.
  const settled = samples.slice(Math.floor(samples.length / 2));
  const average = (list: number[]) => (list.length ? list.reduce((a, b) => a + b, 0) / list.length : 0);
  const result: Record<string, unknown> = {
    renderer,
    startup: samples.slice(0, 6).map((s) => `${s.t}s ${s.fps.toFixed(0)}fps ${s.mode}`),
    settled: {
      fps: Number(average(settled.map((s) => s.fps)).toFixed(1)),
      worstFps: Number(Math.min(...settled.map((s) => s.fps)).toFixed(1)),
      frameMs: Number(average(settled.map((s) => s.frameMs)).toFixed(2)),
      scriptMs: Number(average(settled.map((s) => s.scriptMs)).toFixed(2)),
      aircraft: settled[settled.length - 1]?.aircraft ?? 0,
      mode: settled[settled.length - 1]?.mode ?? 'unknown',
    },
    notices: [...notices],
    errors: errors.slice(0, 8),
  };
  if (values.eval) result.eval = await page.evaluate(values.eval as string);
  if (values.shot) {
    await page.screenshot({ path: values.shot as string });
    result.screenshot = values.shot;
  }
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
