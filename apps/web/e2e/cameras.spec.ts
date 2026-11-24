import { expect, type Page, test } from '@playwright/test';
import { AIRPORT, mockBackend } from './mocks';

/** A 16 x 9 grey PNG, standing in for a camera picture. */
const PICTURE = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAJCAIAAAC0SDtlAAAAE0lEQVR42mOISskjCTGMahgUGgBYWKjBKlVidwAAAABJRU5ErkJggg==',
  'base64',
);

const POSE = { lat: 40.4159, lon: -86.9312, heightM: 15, headingDeg: 215, pitchDeg: -3, hfovDeg: 60 };

const CAMERAS = [
  {
    id: 'apron',
    airport: 'KLAF',
    name: 'Apron',
    kind: 'snapshot',
    src: '/proxy/camera/apron',
    attribution: 'Example FBO',
    link: 'https://fbo.example.test/apron',
    pose: POSE,
    refreshSeconds: 2,
  },
  {
    id: 'spotters',
    airport: 'KLAF',
    name: 'Spotters',
    kind: 'youtube',
    src: 'AAAAAAAAAAA',
    provider: 'youtube',
    link: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
    refreshSeconds: 60,
  },
  {
    id: 'page',
    airport: 'KLAF',
    name: 'Terminal page',
    kind: 'iframe',
    src: 'https://blocked.example.test/cam',
    link: 'https://blocked.example.test/cam',
    frameBlocked: true,
    refreshSeconds: 60,
  },
  {
    id: 'hangar',
    airport: 'KLAF',
    name: 'Hangar',
    kind: 'webrtc',
    src: '',
    problem: 'This camera plays through go2rtc, and no go2rtc address is configured.',
    refreshSeconds: 60,
  },
];

async function mockCameras(page: Page): Promise<{ pictures: () => number }> {
  let pictures = 0;
  await mockBackend(page, { features: { cameras: true } });
  await page.route('**/api/cameras/KLAF', (route) =>
    route.fulfill({ json: { cameras: CAMERAS, go2rtc: false } }),
  );
  await page.route('**/proxy/camera/apron**', (route) => {
    pictures += 1;
    return route.fulfill({ contentType: 'image/png', body: PICTURE });
  });
  // The YouTube player API, replaced by a stand-in that records what it was asked to play.
  await page.route('https://www.youtube.com/iframe_api', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: `
        window.__yt = [];
        window.YT = { Player: class {
          constructor(element, options) {
            window.__yt.push({ videoId: options.videoId, playerVars: options.playerVars, muted: false, playing: false });
            const state = window.__yt[window.__yt.length - 1];
            this.mute = () => { state.muted = true; };
            this.playVideo = () => { state.playing = true; };
            this.destroy = () => { state.destroyed = true; };
            setTimeout(() => options.events.onReady({ target: this }), 0);
          }
        } };
        window.onYouTubeIframeAPIReady();
      `,
    }),
  );
  return { pictures: () => pictures };
}

const ready = (page: Page) =>
  expect(page.getByTestId('airport-page')).toHaveAttribute('data-ready', 'true', { timeout: 60_000 });

test('cameras open in a window, a split, a grid, and close again', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  const mocks = await mockCameras(page);
  await page.goto('/KLAF');
  await ready(page);

  const toggle = page.getByTestId('cameras-toggle');
  await expect(toggle).toHaveText('Cameras 4');
  await expect(page.getByTestId('camera-dock')).toHaveCount(0);

  // "C" opens the first camera in a window over the 3D view.
  await page.keyboard.press('c');
  const dock = page.getByTestId('camera-dock');
  await expect(dock).toHaveAttribute('data-layout', 'pip');
  await expect(page).toHaveURL(/cam=apron/);
  const picture = dock.getByRole('img', { name: 'Apron' });
  await expect(picture).toBeVisible();
  await expect.poll(() => picture.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(16);
  // The credit names the source and links to it.
  await expect(dock.getByRole('link', { name: 'Example FBO' })).toHaveAttribute(
    'href',
    'https://fbo.example.test/apron',
  );
  // A snapshot camera is fetched again every few seconds.
  await expect.poll(mocks.pictures, { timeout: 10_000 }).toBeGreaterThan(1);

  // The window can be dragged by its bar.
  const before = await dock.boundingBox();
  const grip = await page.getByTestId('camera-grip').boundingBox();
  if (!before || !grip) throw new Error('the camera window has no box');
  const from = { x: grip.x + grip.width / 2, y: grip.y + grip.height / 2 };
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + 120, from.y + 80, { steps: 5 });
  await page.mouse.up();
  const after = await dock.boundingBox();
  expect(after?.x).toBeCloseTo(before.x + 120, 0);
  expect(after?.y).toBeCloseTo(before.y + 80, 0);

  // Side by side with the 3D view.
  await page.getByTestId('camera-layout-split').click();
  await expect(dock).toHaveAttribute('data-layout', 'split');
  await expect(page).toHaveURL(/camlayout=split/);
  const scene = await page.getByTestId('scene').boundingBox();
  const split = await dock.boundingBox();
  expect(scene && split && Math.abs(scene.x + scene.width - split.x)).toBeLessThan(2);

  // Every camera at once; "Open" brings one back beside the 3D view.
  await page.getByTestId('camera-layout-grid').click();
  await expect(dock).toHaveAttribute('data-layout', 'grid');
  await expect(dock.locator('.camera-tile')).toHaveCount(4);
  await dock.locator('.camera-tile', { hasText: 'Spotters' }).getByRole('button', { name: 'Open' }).click();
  await expect(dock).toHaveAttribute('data-layout', 'split');
  await expect(page).toHaveURL(/cam=spotters/);

  // "C" closes, and the address forgets the camera.
  await page.keyboard.press('c');
  await expect(dock).toHaveCount(0);
  await expect(page).not.toHaveURL(/cam=/);
  expect(errors).toEqual([]);
});

test('each kind of camera gets its player, or an honest message', async ({ page }) => {
  await mockCameras(page);
  await page.goto('/KLAF?cam=spotters');
  await ready(page);
  const dock = page.getByTestId('camera-dock');

  // YouTube: the documented player, asked for the video, muted so that it may start by itself.
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __yt?: { videoId: string }[] }).__yt?.[0]))
    .toMatchObject({
      videoId: 'AAAAAAAAAAA',
      muted: true,
      playing: true,
      playerVars: { autoplay: 1, playsinline: 1 },
    });
  const origin = await page.evaluate(
    () => (window as unknown as { __yt: { playerVars: { origin: string } }[] }).__yt[0]?.playerVars.origin,
  );
  expect(origin).toBe(new URL(page.url()).origin);

  // A page that refuses to be framed: no empty box, the way out instead.
  await page.getByTestId('camera-select').selectOption('page');
  await expect(dock.getByRole('status')).toContainText(
    'does not allow itself to be shown inside other pages',
  );
  await expect(dock.getByRole('link', { name: 'Open in new tab' })).toHaveAttribute(
    'href',
    'https://blocked.example.test/cam',
  );
  await expect(dock.locator('iframe')).toHaveCount(0);
  // Leaving the YouTube camera took its player down.
  expect(
    await page.evaluate(() => (window as unknown as { __yt: { destroyed?: boolean }[] }).__yt[0]?.destroyed),
  ).toBe(true);

  // A camera that cannot play says why.
  await page.getByTestId('camera-select').selectOption('hangar');
  await expect(dock.getByRole('status')).toContainText('no go2rtc address is configured');
});

test('Match view and the overlay look through a camera that has a pose', async ({ page }) => {
  await mockCameras(page);
  await page.goto('/KLAF?view=overhead&cam=apron');
  await ready(page);
  const dock = page.getByTestId('camera-dock');
  const view = () => page.evaluate(() => window.__towercab?.view);

  // Match view: the 3D camera goes to the camera's place; pressing again gives it back.
  const match = page.getByTestId('camera-match');
  await match.click();
  await expect.poll(view).toBe('cam:apron');
  await expect(match).toHaveAttribute('aria-pressed', 'true');
  // Looking through a camera is not a view to bookmark: the address keeps the camera, not a view.
  await expect(page).not.toHaveURL(/view=cam/);
  await match.click();
  await expect.poll(view).toBe('free');

  // A view preset also ends it.
  await match.click();
  await expect.poll(view).toBe('cam:apron');
  await page.getByTestId('view-overhead').click();
  await expect.poll(view).toBe('overhead');
  expect(await page.evaluate(() => window.__towercab?.matchedCamera)).toBeNull();

  // Overlay: the picture sits inside the 3D view, under the labels, and the view is locked to the camera.
  await page.getByTestId('camera-layout-overlay').click();
  await expect(dock).toHaveAttribute('data-layout', 'overlay');
  await expect.poll(() => page.evaluate(() => window.__towercab?.matchedCamera)).toBe('apron');
  const overlay = page.getByTestId('scene').getByTestId('camera-overlay');
  await expect(overlay.getByRole('img', { name: 'Apron' })).toBeVisible();
  const stacking = await page.evaluate(() => {
    const z = (selector: string) =>
      Number(getComputedStyle(document.querySelector(selector) as Element).zIndex);
    return {
      picture: z('.camera-overlay'),
      labels: z('.label-overlay'),
      credits: z('.cesium-viewer-bottom'),
    };
  });
  expect(stacking.picture).toBeLessThan(stacking.labels);
  expect(stacking.labels).toBeLessThan(stacking.credits);

  // The slider fades the picture.
  await page.getByTestId('camera-opacity').fill('0.3');
  await expect(overlay).toHaveCSS('opacity', '0.3');

  // A camera without a pose cannot be overlaid: it falls back to a window, and the 3D view is freed.
  await page.getByTestId('camera-select').selectOption('spotters');
  await expect(dock).toHaveAttribute('data-layout', 'pip');
  await expect.poll(() => page.evaluate(() => window.__towercab?.matchedCamera)).toBeNull();
  await expect(page.getByTestId('camera-layout-overlay')).toHaveCount(0);
});

test('clicking a camera in the 3D view opens it', async ({ page }) => {
  await mockCameras(page);
  await page.goto('/KLAF?view=overhead');
  await ready(page);
  await expect(page.getByTestId('camera-dock')).toHaveCount(0);

  // The camera with a pose is drawn in the scene; its marker is clickable.
  await expect
    .poll(() => page.evaluate(() => window.__towercab?.cameraLensAt('apron')), { timeout: 20_000 })
    .not.toBeNull();
  // Let the camera settle on the overhead view before measuring where the marker is.
  await page.waitForTimeout(2000);
  const scene = await page.getByTestId('scene').boundingBox();
  const lens = await page.evaluate(() => window.__towercab?.cameraLensAt('apron'));
  if (!scene || !lens) throw new Error('no camera marker on screen');
  await page.mouse.click(scene.x + lens.x, scene.y + lens.y);

  await expect(page.getByTestId('camera-dock')).toHaveAttribute('data-layout', 'pip');
  await expect(page).toHaveURL(/cam=apron/);
  // A camera without a pose has no marker.
  expect(await page.evaluate(() => window.__towercab?.cameraLensAt('spotters'))).toBeNull();
});

test('without cameras the button says so and stays out of the way', async ({ page }) => {
  await mockBackend(page);
  await page.goto('/KLAF?cam=apron&camlayout=split');
  await ready(page);
  await expect(page.getByTestId('cameras-toggle')).toBeDisabled();
  await expect(page.getByTestId('cameras-toggle')).toHaveAttribute('title', 'No cameras are set up for KLAF');
  await expect(page.getByTestId('camera-dock')).toHaveCount(0);
  await expect(page).not.toHaveURL(/cam=/);
});

test.describe('admin page', () => {
  const TOKEN = 'e2e-admin-token';

  const camera = (extra: object) => ({
    airport: 'KLAF',
    enabled: true,
    origin: 'discovery',
    status: 'pending',
    ...extra,
  });

  async function mockAdmin(page: Page, admin = true) {
    const patches: { id: string; body: Record<string, unknown> }[] = [];
    const cameras: Record<string, unknown>[] = [
      camera({
        id: 'ramp',
        name: 'Ramp',
        kind: 'hls',
        source: 'https://open.example.test/ramp.m3u8',
        origin: 'config',
        status: 'approved',
      }),
      camera({
        id: 'yt-AAAAAAAAAAA',
        name: 'Example Field Tower Cam',
        kind: 'youtube',
        source: 'AAAAAAAAAAA',
        provider: 'youtube',
        link: 'https://www.youtube.com/watch?v=AAAAAAAAAAA',
        detail: { channel: 'Example Spotters', foundBy: 'live near the airport' },
        foundAt: Date.now() - 3_600_000,
      }),
    ];
    const state = () => ({
      version: 'e2e',
      airports: [{ icao: 'KLAF', name: AIRPORT.name }],
      discovery: { enabled: true, intervalHours: 6, youtube: true, windy: false },
      cameras,
      runs: [],
      proxyAllowlist: [],
      go2rtc: false,
    });
    await mockBackend(page, { features: { admin } });
    await page.route('**/admin/api/**', async (route) => {
      const request = route.request();
      if (request.headers().authorization !== `Bearer ${TOKEN}`) {
        return route.fulfill({
          status: 401,
          json: { error: 'unauthorized', message: 'The admin token is missing or wrong.' },
        });
      }
      const path = new URL(request.url()).pathname.replace('/admin/api', '');
      if (path === '/state') return route.fulfill({ json: state() });
      if (path === '/discovery/KLAF') {
        cameras.push(
          camera({
            id: 'yt-BBBBBBBBBBB',
            name: 'Runway 23 approach',
            kind: 'youtube',
            source: 'BBBBBBBBBBB',
            provider: 'youtube',
          }),
        );
        return route.fulfill({
          json: {
            outcomes: [
              {
                provider: 'youtube',
                ran: true,
                ok: true,
                found: 2,
                added: 1,
                nextAt: Date.now() + 6 * 3_600_000,
              },
              {
                provider: 'windy',
                ran: false,
                ok: true,
                found: 0,
                added: 0,
                message: 'WINDY_API_KEY is not set.',
              },
            ],
            state: state(),
          },
        });
      }
      const match = /^\/cameras\/([^/]+)$/.exec(path);
      if (match && request.method() === 'PATCH') {
        const body = request.postDataJSON() as Record<string, unknown>;
        patches.push({ id: match[1] as string, body });
        const target = cameras.find((c) => c.id === match[1]);
        if (target) {
          Object.assign(target, body);
          if (body.pose === null) delete target.pose;
          if (body.pose) target.poseFrom = 'admin';
        }
        return route.fulfill({ json: state() });
      }
      return route.fulfill({ status: 404, json: { error: 'not_found' } });
    });
    return { patches };
  }

  test('explains itself when admin is switched off', async ({ page }) => {
    await mockAdmin(page, false);
    await page.goto('/admin');
    await expect(page.getByText('Admin is switched off on this server')).toBeVisible();
    await expect(page.getByTestId('admin-token')).toHaveCount(0);
  });

  test('signs in, searches, approves, and sets a pose by clicking and dragging in the scene', async ({
    page,
  }) => {
    const { patches } = await mockAdmin(page);
    await page.goto('/admin');

    // A wrong token is refused and nothing is shown.
    await page.getByTestId('admin-token').fill('guess');
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('alert')).toHaveText('That token was not accepted.');
    await expect(page.getByTestId('admin-page')).toHaveCount(0);

    await page.getByTestId('admin-token').fill(TOKEN);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByTestId('admin-page')).toBeVisible();
    // The token is kept for this tab only.
    expect(
      await page.evaluate(() => [sessionStorage.length, localStorage.getItem('towercab.admin')]),
    ).toEqual([1, null]);

    // A search adds to the queue.
    await page.getByTestId('admin-search').click();
    await expect(page.getByText('YouTube: 2 found, 1 new.')).toBeVisible();
    await expect(page.getByText('Windy: not asked. WINDY_API_KEY is not set.')).toBeVisible();
    await expect(page.getByTestId('admin-camera-yt-BBBBBBBBBBB')).toBeVisible();

    // Approving moves a camera out of the queue.
    const found = page.getByTestId('admin-camera-yt-AAAAAAAAAAA');
    await expect(found).toContainText('Example Spotters');
    await found.getByRole('button', { name: 'Approve' }).click();
    await expect.poll(() => patches.at(-1)).toEqual({ id: 'yt-AAAAAAAAAAA', body: { status: 'approved' } });
    await expect(found.getByRole('button', { name: 'Switch off' })).toBeVisible();

    // Set a pose: the camera starts in the middle of the field.
    await found.getByRole('button', { name: 'Set pose' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__towercab?.poseHandleAt('aim')), { timeout: 60_000 })
      .not.toBeNull();
    const position = page.locator('.pose-form .mono');
    await expect(position).toHaveText(`${AIRPORT.lat.toFixed(6)}, ${AIRPORT.lon.toFixed(6)}`);

    // A click on the ground moves it there.
    const scene = await page.getByTestId('pose-scene').boundingBox();
    if (!scene) throw new Error('the pose scene has no box');
    await page.mouse.click(scene.x + scene.width * 0.3, scene.y + scene.height * 0.6);
    await expect(position).not.toHaveText(`${AIRPORT.lat.toFixed(6)}, ${AIRPORT.lon.toFixed(6)}`);

    // Dragging the direction handle turns the camera towards the pointer.
    const heading = page.locator('.pose-field output').first();
    await expect(heading).toHaveText('0°');
    const handle = async (which: 'aim' | 'fov') => {
      const at = await page.evaluate((w) => window.__towercab?.poseHandleAt(w), which);
      if (!at) throw new Error(`no ${which} handle`);
      return { x: scene.x + at.x, y: scene.y + at.y };
    };
    const aim = await handle('aim');
    await page.mouse.move(aim.x, aim.y);
    await page.mouse.down();
    // To the right of the camera on a north-up map: east.
    await page.mouse.move(aim.x + 120, aim.y + 60, { steps: 6 });
    const camera = { x: scene.x + scene.width * 0.3, y: scene.y + scene.height * 0.6 };
    await page.mouse.move(camera.x + 200, camera.y, { steps: 6 });
    await page.mouse.up();
    await expect
      .poll(async () => Number.parseFloat((await heading.textContent()) ?? '0'))
      .toBeGreaterThan(80);
    expect(Number.parseFloat((await heading.textContent()) ?? '0')).toBeLessThan(100);

    // Dragging the other handle changes how much the camera takes in.
    const fov = page.locator('.pose-field output').nth(1);
    await expect(fov).toHaveText('60°');
    const edge = await handle('fov');
    await page.mouse.move(edge.x, edge.y);
    await page.mouse.down();
    await page.mouse.move(camera.x + 200, camera.y - 40, { steps: 6 });
    await page.mouse.up();
    await expect(fov).not.toHaveText('60°');

    await page.getByTestId('pose-save').click();
    await expect.poll(() => patches.at(-1)?.body.pose).toBeTruthy();
    const saved = patches.at(-1)?.body.pose as {
      lat: number;
      lon: number;
      headingDeg: number;
      hfovDeg: number;
    };
    expect(patches.at(-1)?.id).toBe('yt-AAAAAAAAAAA');
    expect(saved.lon).toBeLessThan(AIRPORT.lon);
    expect(saved.headingDeg).toBeGreaterThan(80);
    expect(saved.hfovDeg).not.toBe(60);
    await expect(found.getByRole('button', { name: 'Edit pose' })).toBeVisible();

    // Signing out forgets the token.
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByTestId('admin-token')).toBeVisible();
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
  });
});
