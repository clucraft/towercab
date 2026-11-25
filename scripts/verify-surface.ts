/**
 * Checks, in Photoreal, that the heights the scene places aircraft at are those of the surface that is drawn.
 *
 * `verify:scene` compares aircraft with the scene's own height lookup, so it cannot tell when that lookup is wrong.
 * This one compares the lookup with the depth buffer, which is what is on screen:
 *
 * - settled: along the runways, in several views, the lookup and the drawn surface agree;
 * - moving: while the view zooms, turns and changes, no reading strays from the ground.
 *
 *   pnpm verify:surface                          # KLAF
 *   pnpm verify:surface --airport KIND --url http://host:8790
 *
 * The same numbers are given for Cesium's `getHeight`, for comparison. Exit code 0 when every check passes.
 */
import { parseArgs } from 'node:util';
import { chromium, type Page } from '@playwright/test';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: 'http://localhost:8790' },
    airport: { type: 'string', default: 'KLAF' },
    query: { type: 'string', default: '' },
  },
});

/** The lookup may be this far off what is drawn. */
const MAX_SETTLED_GAP_M = 0.3;
/** No reading may stray further than this from the ground while the view moves. */
const MAX_STRAY_M = 8;
/** Runway points looked at, and those that must have been visible for a run to count. */
const POINTS_PER_RUNWAY = 40;
const MIN_SETTLED = 80;

/** What the page needs of the scene controller and of Cesium. */
interface Vec {
  x: number;
  y: number;
  z: number;
}
interface Carto {
  longitude: number;
  latitude: number;
  height: number;
}
interface Controller {
  mode: string;
  airport: {
    elevationEllipsoidM: number;
    runways: { closed?: boolean; ends: { lat: number; lon: number }[] }[];
  };
  layer: { source: { show: boolean } };
  trails: { setEnabled(on: boolean): void };
  tileset: {
    tilesLoaded: boolean;
    getHeight(at: Carto, scene: unknown): number | undefined;
  };
  ground: {
    beginFrame(ms?: number): void;
    heightAt(lon: number, lat: number): number | undefined;
    options: { probe(lon: number, lat: number): { height: number; errorM: number } | undefined };
  };
  viewer: {
    camera: {
      position: { constructor: new () => Vec };
      positionCartographic: { constructor: new (lon: number, lat: number, h: number) => Carto };
    };
    scene: {
      msaaSamples: number;
      canvas: { clientWidth: number; clientHeight: number };
      ellipsoid: {
        cartographicToCartesian(c: Carto, result: Vec): Vec;
        cartesianToCartographic(v: Vec): Carto | undefined;
      };
      cartesianToCanvasCoordinates(v: Vec): { x: number; y: number } | undefined;
      pickPosition(at: { x: number; y: number }): Vec | undefined;
      postRender: { addEventListener(fn: () => void): void };
    };
  };
}

interface Settled {
  points: number;
  worst: number;
  median: number;
  cesiumWorst: number;
  cesiumMedian: number;
  unanswered: number;
  /** Points left out because the surface is steep there. */
  steep: number;
}

/** Runs in the page: the lookup against the depth buffer along the runways. */
function settled(page: Page): Promise<Settled> {
  return page.evaluate((perRunway) => {
    const s = (window as unknown as { __towercab: Controller }).__towercab;
    const { scene, camera } = s.viewer;
    const Cartographic = camera.positionCartographic.constructor;
    const Cartesian = camera.position.constructor;
    const RAD = Math.PI / 180;
    const { clientWidth, clientHeight } = scene.canvas;
    const gaps: number[] = [];
    const cesium: number[] = [];
    let unanswered = 0;
    let steep = 0;
    for (const runway of s.airport.runways) {
      const [a, b] = runway.ends as [{ lat: number; lon: number }, { lat: number; lon: number }];
      for (let i = 0; i < perRunway; i += 1) {
        const u = (i + 0.5) / perRunway;
        const lat = a.lat + (b.lat - a.lat) * u;
        const lon = a.lon + (b.lon - a.lon) * u;
        const guess = s.ground.options.probe(lon, lat)?.height ?? s.airport.elevationEllipsoidM;
        const world = scene.ellipsoid.cartographicToCartesian(
          new Cartographic(lon * RAD, lat * RAD, guess),
          new Cartesian(),
        );
        const at = scene.cartesianToCanvasCoordinates(world);
        if (!at || at.x < 4 || at.y < 4 || at.x > clientWidth - 4 || at.y > clientHeight - 4) continue;
        // The depth is that of the middle of a pixel. Anywhere else in the pixel it belongs to another height.
        // (Changed in place: Cesium remembers answers by the text of the position, and only its own has one.)
        at.x = Math.floor(at.x) + 0.5;
        at.y = Math.floor(at.y) + 0.5;
        const seen = scene.pickPosition(at);
        const where = seen && scene.ellipsoid.cartesianToCartographic(seen);
        if (!where) continue;
        // Something may stand in front of the runway. Only what is seen on the runway itself counts.
        const perLat = 111_320;
        const perLon = 111_320 * Math.cos(lat * RAD);
        const east = (b.lon - a.lon) * perLon;
        const north = (b.lat - a.lat) * perLat;
        const length = Math.hypot(east, north);
        const dx = (where.longitude / RAD - a.lon) * perLon;
        const dy = (where.latitude / RAD - a.lat) * perLat;
        const along = (dx * east + dy * north) / length;
        const across = Math.abs(dx * north - dy * east) / length;
        if (across > 12 || along < 0 || along > length) continue;
        const lookup = s.ground.options.probe(where.longitude / RAD, where.latitude / RAD);
        if (!lookup) {
          unanswered += 1;
          continue;
        }
        // On the steep side of a bump, seen from far off at a shallow angle, a centimetre sideways is a metre up.
        const around = [-1.5, 1.5].flatMap((d) => [
          s.ground.options.probe(where.longitude / RAD + d / perLon, where.latitude / RAD)?.height,
          s.ground.options.probe(where.longitude / RAD, where.latitude / RAD + d / perLat)?.height,
        ]);
        if (around.some((h) => h === undefined || Math.abs(h - lookup.height) > 0.3)) {
          steep += 1;
          continue;
        }
        gaps.push(Math.abs(lookup.height - where.height));
        const theirs = s.tileset.getHeight(new Cartographic(where.longitude, where.latitude, 0), scene);
        if (theirs !== undefined) cesium.push(Math.abs(theirs - where.height));
      }
    }
    const median = (list: number[]) => [...list].sort((x, y) => x - y)[Math.floor(list.length / 2)] ?? 0;
    return {
      points: gaps.length,
      worst: Math.max(0, ...gaps),
      median: median(gaps),
      cesiumWorst: Math.max(0, ...cesium),
      cesiumMedian: median(cesium),
      unanswered,
      steep,
    };
  }, POINTS_PER_RUNWAY);
}

/** Starts watching, every frame, what the lookup says at points along the runways. */
function startWatching(page: Page): Promise<void> {
  return page.evaluate(() => {
    const s = (window as unknown as { __towercab: Controller }).__towercab;
    const { scene, camera } = s.viewer;
    const Cartographic = camera.positionCartographic.constructor;
    const RAD = Math.PI / 180;
    const points = s.airport.runways.flatMap(({ ends: [a, b] }) =>
      [0.1, 0.3, 0.5, 0.7, 0.9].map((u) => ({
        lat: (a?.lat ?? 0) + ((b?.lat ?? 0) - (a?.lat ?? 0)) * u,
        lon: (a?.lon ?? 0) + ((b?.lon ?? 0) - (a?.lon ?? 0)) * u,
      })),
    );
    // The best reading seen at each point so far counts as the truth.
    const truth = points.map(() => ({ height: Number.NaN, errorM: Number.POSITIVE_INFINITY }));
    const raw: { i: number; h: number; e: number }[] = [];
    const result = { frames: 0, answers: 0, none: 0, cesium: [] as { i: number; h: number }[], raw, truth };
    const kept = points.map(() => ({ min: Number.POSITIVE_INFINITY, max: Number.NEGATIVE_INFINITY }));
    Object.assign(window, { __watched: { result, kept } });
    scene.postRender.addEventListener(() => {
      if (s.mode !== 'photoreal') return;
      result.frames += 1;
      points.forEach(({ lat, lon }, i) => {
        const found = s.ground.options.probe(lon, lat);
        if (found) {
          result.answers += 1;
          raw.push({ i, h: found.height, e: found.errorM });
          const best = truth[i];
          if (best && found.errorM <= best.errorM) Object.assign(best, found);
        } else result.none += 1;
        const theirs = s.tileset.getHeight(new Cartographic(lon * RAD, lat * RAD, 0), scene);
        // The sanity limit that has always been there.
        if (theirs !== undefined && Math.abs(theirs - s.airport.elevationEllipsoidM) <= 120)
          result.cesium.push({ i, h: theirs });
        // What an aircraft standing there would be given.
        s.ground.beginFrame(100);
        const height = s.ground.heightAt(lon, lat);
        const range = kept[i];
        if (height !== undefined && range) {
          range.min = Math.min(range.min, height);
          range.max = Math.max(range.max, height);
        }
      });
    });
  });
}

interface Moving {
  frames: number;
  answers: number;
  none: number;
  worst: number;
  off2: number;
  cesiumWorst: number;
  cesiumOff2: number;
  /** Largest difference between two heights given out for the same point. */
  swing: number;
  /** How far readings were off, by how rough the tile was. */
  byRoughness: { errorM: number; count: number; worst: number; median: number }[];
}

function stopWatching(page: Page): Promise<Moving> {
  return page.evaluate(() => {
    interface Reading {
      i: number;
      h: number;
      e?: number;
    }
    const { result, kept } = (
      window as unknown as {
        __watched: {
          result: {
            frames: number;
            answers: number;
            none: number;
            raw: Reading[];
            cesium: Reading[];
            truth: { height: number }[];
          };
          kept: { min: number; max: number }[];
        };
      }
    ).__watched;
    const off = (list: Reading[]) => list.map(({ i, h }) => Math.abs(h - (result.truth[i]?.height ?? h)));
    const ours = off(result.raw);
    const theirs = off(result.cesium);
    const worst = (list: number[]) => list.reduce((m, v) => Math.max(m, v), 0);
    const share = (list: number[]) => list.filter((v) => v > 2).length / Math.max(1, list.length);
    const levels = new Map<number, number[]>();
    result.raw.forEach(({ e = 0 }, k) => {
      const level = Math.round(e);
      const list = levels.get(level) ?? [];
      list.push(ours[k] as number);
      levels.set(level, list);
    });
    return {
      byRoughness: [...levels]
        .sort(([a], [b]) => a - b)
        .map(([errorM, list]) => ({
          errorM,
          count: list.length,
          worst: worst(list),
          median: list.sort((a, b) => a - b)[Math.floor(list.length / 2)] ?? 0,
        })),
      frames: result.frames,
      answers: result.answers,
      none: result.none,
      worst: worst(ours),
      off2: share(ours),
      cesiumWorst: worst(theirs),
      cesiumOff2: share(theirs),
      swing: worst(kept.map((k) => (k.max >= k.min ? k.max - k.min : 0))),
    };
  });
}

async function main(): Promise<number> {
  const base = (values.url as string).replace(/\/+$/, '');
  const browser = await chromium.launch({
    args: ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'],
  });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  // tsx wraps named functions in a `__name` helper; the functions sent to the page need it to exist there.
  await page.addInitScript('window.__name = (fn) => fn;');
  // A few aircraft keep the scene drawing every frame.
  await page.goto(`${base}/${values.airport}?sim=6&mode=photoreal${values.query}`);
  await page.waitForFunction(
    () => Boolean((window as unknown as { __towercab?: { tileset?: unknown } }).__towercab?.tileset),
    null,
    { timeout: 60_000 },
  );
  const loaded = async () => {
    await page.waitForTimeout(1500);
    await page
      .waitForFunction(
        () => (window as unknown as { __towercab: Controller }).__towercab.tileset.tilesLoaded,
        null,
        { timeout: 20_000 },
      )
      .catch(() => console.log('  (still loading after 20 s)'));
    await page.waitForTimeout(1500);
  };
  // Trails and aircraft are in the depth buffer, too; here only the ground counts. With antialiasing the depth of
  // a pixel can be that of something at its edge, which from a distance and at a shallow angle is metres higher.
  await page.evaluate(() => {
    const s = (window as unknown as { __towercab: Controller }).__towercab;
    s.trails.setEnabled(false);
    s.layer.source.show = false;
    s.viewer.scene.msaaSamples = 1;
  });
  const problems: string[] = [];
  const m = (metres: number) => `${metres.toFixed(2)} m`;

  let seen = 0;
  for (const name of ['Tower cab', 'Overhead', 'Free orbit']) {
    await page.getByRole('button', { name }).click();
    await page.waitForTimeout(3000);
    await loaded();
    const r = await settled(page);
    seen += r.points;
    console.log(
      `${values.airport} ${name}: ${r.points} runway points in view, lookup against what is drawn: ` +
        `median ${m(r.median)}, worst ${m(r.worst)}, no answer at ${r.unanswered} (${r.steep} steep ones left out). ` +
        `Cesium's getHeight: median ${m(r.cesiumMedian)}, worst ${m(r.cesiumWorst)}`,
    );
    if (r.worst > MAX_SETTLED_GAP_M)
      problems.push(`${name}: the lookup was ${m(r.worst)} from the drawn surface`);
    if (r.unanswered > 0) problems.push(`${name}: no answer at ${r.unanswered} points that are drawn`);
  }
  if (seen < MIN_SETTLED) problems.push(`only ${seen} runway points were in view`);

  await startWatching(page);
  const box = { x: 660, y: 480 };
  const wheel = async (dy: number, times: number) => {
    await page.mouse.move(box.x, box.y);
    for (let i = 0; i < times; i += 1) {
      await page.mouse.wheel(0, dy);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(2000);
  };
  const drag = async (button: 'left' | 'middle', dx: number, dy: number) => {
    await page.mouse.move(box.x, box.y);
    await page.mouse.down({ button });
    for (let i = 1; i <= 15; i += 1) {
      await page.mouse.move(box.x + (dx * i) / 15, box.y + (dy * i) / 15);
      await page.waitForTimeout(30);
    }
    await page.mouse.up({ button });
    await page.waitForTimeout(2000);
  };
  for (let round = 0; round < 2; round += 1) {
    await wheel(120, 12);
    await drag('middle', 0, 200);
    await drag('middle', 400, 0);
    await drag('left', -350, 150);
    await wheel(-120, 10);
    await wheel(120, 25);
    await wheel(-120, 18);
    for (const name of ['Overhead', 'Free orbit', 'Tower cab']) {
      await page.getByRole('button', { name }).click();
      await page.waitForTimeout(4000);
    }
  }
  const moving = await stopWatching(page);
  await browser.close();
  console.log(
    `${values.airport} moving: ${moving.frames} frames, ${moving.answers} answers and ${moving.none} times none, ` +
      `worst ${m(moving.worst)}, ${(moving.off2 * 100).toFixed(1)}% more than 2 m off; heights given out at one point ` +
      `differed by up to ${m(moving.swing)}. Cesium's getHeight: worst ${m(moving.cesiumWorst)}, ` +
      `${(moving.cesiumOff2 * 100).toFixed(1)}% more than 2 m off`,
  );
  for (const level of moving.byRoughness)
    console.log(
      `  tiles of ${level.errorM} m: ${level.count} readings, median ${m(level.median)} off, worst ${m(level.worst)}`,
    );
  if (moving.frames < 500) problems.push(`only ${moving.frames} frames were drawn`);
  if (moving.worst > MAX_STRAY_M) problems.push(`a reading was ${m(moving.worst)} from the ground`);
  if (moving.swing > MAX_STRAY_M)
    problems.push(`the height given out at one point changed by ${m(moving.swing)}`);

  for (const problem of problems) console.log(`  FAIL: ${problem}`);
  if (problems.length === 0) console.log('  ok: aircraft are placed on the surface that is drawn');
  return problems.length > 0 ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err);
    process.exit(2);
  },
);
