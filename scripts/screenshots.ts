/**
 * Takes the pictures the README shows, from a running TowerCab server, and renders the icon.
 *
 *   pnpm screenshots                       # against http://localhost:8790
 *   pnpm screenshots --url http://host:8790 --camera ramp --admin-token-file path/to/token
 *
 * Everything is captured in Schematic mode with the recording that ships with the app, so the pictures
 * contain only open data (OpenStreetMap, OurAirports, adsb.lol) and can live in the repository. Photoreal
 * shows Google's 3D tiles, which may be displayed but not stored, so no picture of it is kept.
 *
 * `--camera` names a camera of the airport to show in the camera picture; without it that picture is
 * skipped. `--admin-token-file` names a file holding the admin token; without it the admin picture is
 * skipped.
 */
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { type Browser, chromium, type Page } from '@playwright/test';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    airport: { type: 'string', default: 'KLAF' },
    replay: { type: 'string', default: 'klaf-pattern' },
    camera: { type: 'string' },
    'admin-token-file': { type: 'string' },
    out: { type: 'string', default: 'docs/images' },
  },
});

const root = join(import.meta.dirname, '..');
const base = (values.url as string).replace(/\/+$/, '');
const out = join(root, values.out as string);
const airport = values.airport as string;
// By day, whenever they are taken.
const traffic = `replay=${values.replay}&mode=schematic&sky=day`;

interface SceneHandle {
  layer: { list(): Iterable<{ hex: string; onGround: boolean; visible: boolean }> };
  select(hex: string): void;
}

async function open(
  browser: Browser,
  path: string,
  options: { viewport?: { width: number; height: number }; scale?: number; cameras?: boolean } = {},
) {
  const page = await browser.newPage({
    viewport: options.viewport ?? { width: 1600, height: 900 },
    deviceScaleFactor: options.scale ?? 1,
  });
  // An aircraft's photo belongs to its photographer and is not ours to put in the repository.
  await page.route('**/api/photos/**', (route) => route.fulfill({ json: { photo: null } }));
  // Whatever cameras the server has are left out of every picture but the one about cameras.
  if (!options.cameras) {
    await page.route('**/api/cameras/**', (route) => route.fulfill({ json: { cameras: [], go2rtc: false } }));
  }
  await page.goto(`${base}${path}`);
  return page;
}

async function sceneReady(page: Page): Promise<void> {
  await page.waitForSelector('[data-testid="airport-page"][data-ready="true"]', { timeout: 90_000 });
}

/** Selects an aircraft that is in the air, so its details card is in the picture. */
async function selectFlying(page: Page): Promise<void> {
  await page.evaluate(() => {
    const scene = (window as unknown as { __towercab: SceneHandle }).__towercab;
    const flying = [...scene.layer.list()].find((a) => a.visible && !a.onGround);
    if (flying) scene.select(flying.hex);
  });
  await page.waitForTimeout(2500);
}

async function main(): Promise<void> {
  await mkdir(out, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const done: string[] = [];
  const shoot = async (page: Page, name: string, dir = out) => {
    const file = join(dir, name);
    await page.screenshot({ path: file });
    done.push(file);
    await page.close();
  };

  // The icon: the favicon, as a PNG for places that want one (the Unraid template).
  const icon = async () => {
    const page = await browser.newPage({ viewport: { width: 256, height: 256 } });
    const svg = await readFile(join(root, 'apps', 'web', 'public', 'favicon.svg'), 'utf8');
    await page.setContent(
      `<style>html,body{margin:0;background:transparent}svg{display:block;width:256px;height:256px}</style>${svg}`,
    );
    const file = join(root, 'unraid', 'towercab.png');
    await page.screenshot({ path: file, omitBackground: true });
    done.push(file);
    await page.close();
  };

  // The field from an angle, a little over two minutes into the recording: one aircraft on short final,
  // one in the pattern, others on the ground.
  const hero = async () => {
    const page = await open(browser, `/${airport}?${traffic}&view=orbit`);
    await sceneReady(page);
    await page.waitForTimeout(140_000);
    await selectFlying(page);
    await shoot(page, 'hero.png');
  };

  // Straight down, with trails.
  const overhead = async () => {
    const page = await open(browser, `/${airport}?${traffic}&view=overhead`);
    await sceneReady(page);
    await page.waitForTimeout(75_000);
    await shoot(page, 'overhead.png');
  };

  // A camera beside the 3D view.
  const cameras = async () => {
    if (!values.camera) return;
    const page = await open(
      browser,
      `/${airport}?${traffic}&view=overhead&cam=${values.camera}&camlayout=split`,
      { cameras: true },
    );
    await sceneReady(page);
    await page.waitForTimeout(40_000);
    await shoot(page, 'cameras.png');
  };

  // The admin page, placing a camera.
  const admin = async () => {
    const tokenFile = values['admin-token-file'];
    if (!tokenFile) return;
    const token = (await readFile(tokenFile as string, 'utf8')).trim();
    const page = await open(browser, '/admin?mode=schematic', { cameras: true });
    await page.getByTestId('admin-token').fill(token);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await page.getByTestId('admin-page').waitFor();
    const card = page.locator('.admin-card', { hasText: /Edit pose/ }).first();
    if ((await card.count()) > 0) await card.getByRole('button', { name: 'Edit pose' }).click();
    await page.waitForTimeout(15_000);
    await shoot(page, 'admin.png');
  };

  // A phone held sideways.
  const phone = async () => {
    const page = await open(browser, `/${airport}?${traffic}&view=overhead`, {
      viewport: { width: 812, height: 375 },
      scale: 2,
    });
    await sceneReady(page);
    await page.waitForTimeout(75_000);
    await shoot(page, 'phone.png');
  };

  await Promise.all([icon(), hero(), overhead(), cameras(), admin(), phone()]);
  await browser.close();
  for (const file of done.sort()) console.log(file);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
