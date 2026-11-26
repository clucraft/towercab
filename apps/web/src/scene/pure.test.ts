import type { AirportInfo, Runway } from '@towercab/shared';
import { distanceM } from '@towercab/shared';
import { describe, expect, it } from 'vitest';
import { hitTestLabels, type LabelRequest, placeLabels } from './labelLayout';
import { airportFootprint, buildViewPresets, resolveView, viewForShortcut } from './views';

const viewport = { width: 1280, height: 720 };
const request = (id: string, x: number, y: number, extra: Partial<LabelRequest> = {}): LabelRequest => ({
  id,
  x,
  y,
  width: 96,
  height: 34,
  compactWidth: 60,
  compactHeight: 16,
  priority: 0,
  ...extra,
});
const rect = (p: { left: number; top: number; width: number; height: number }) => ({
  left: p.left,
  top: p.top,
  right: p.left + p.width,
  bottom: p.top + p.height,
});
const intersect = (a: ReturnType<typeof rect>, b: ReturnType<typeof rect>) =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

describe('placeLabels', () => {
  it('puts a lone label beside its aircraft, up and to the right', () => {
    const placed = placeLabels([request('a', 400, 300)], viewport);
    const a = placed.get('a');
    expect(a).toMatchObject({ slot: 0, compact: false, anchorX: 400, anchorY: 300 });
    expect(a?.left).toBeGreaterThan(400);
    expect((a?.top ?? 0) + (a?.height ?? 0)).toBeLessThan(300);
  });

  it('never lets two labels overlap, even in a tight cluster', () => {
    const requests: LabelRequest[] = [];
    for (let i = 0; i < 40; i += 1) {
      requests.push(
        request(`ac${i}`, 500 + (i % 8) * 34, 300 + Math.floor(i / 8) * 26, { priority: 40 - i }),
      );
    }
    const placed = [...placeLabels(requests, viewport).values()];
    expect(placed.length).toBeGreaterThan(8);
    for (let i = 0; i < placed.length; i += 1) {
      for (let j = i + 1; j < placed.length; j += 1) {
        expect(
          intersect(rect(placed[i] as never), rect(placed[j] as never)),
          `${placed[i]?.id} / ${placed[j]?.id}`,
        ).toBe(false);
      }
    }
  });

  it('keeps labels off other aircraft', () => {
    // b sits exactly where a's label would go by default.
    const placed = placeLabels(
      [request('a', 400, 300, { priority: 2 }), request('b', 460, 270, { priority: 1 })],
      viewport,
    );
    const a = rect(placed.get('a') as never);
    expect(460 >= a.left - 1 && 460 <= a.right + 1 && 270 >= a.top - 1 && 270 <= a.bottom + 1).toBe(false);
  });

  it('gives the higher priority label the better position and shrinks or drops the rest', () => {
    const crowd = Array.from({ length: 12 }, (_, i) =>
      request(`ac${i}`, 640, 360, { priority: i === 7 ? 100 : i }),
    );
    const placed = placeLabels(crowd, viewport);
    expect(placed.get('ac7')).toMatchObject({ slot: 0, compact: false });
    // Eight slots around one point: not everything fits, and some labels fall back to one line.
    expect(placed.size).toBeLessThan(12);
    expect(placed.size).toBeGreaterThanOrEqual(4);
  });

  it('stays inside the viewport', () => {
    const corners = [
      request('tl', 4, 4),
      request('tr', 1276, 4),
      request('bl', 4, 716),
      request('br', 1276, 716),
    ];
    for (const p of placeLabels(corners, viewport).values()) {
      expect(p.left).toBeGreaterThanOrEqual(2);
      expect(p.top).toBeGreaterThanOrEqual(2);
      expect(p.left + p.width).toBeLessThanOrEqual(1278);
      expect(p.top + p.height).toBeLessThanOrEqual(718);
    }
    expect(placeLabels(corners, viewport).size).toBe(4);
  });

  it('keeps a label where it was last frame when that still works', () => {
    const first = placeLabels([request('a', 400, 300, { previousSlot: 3 })], viewport);
    expect(first.get('a')?.slot).toBe(3);
    // The old slot is now blocked by a more important label, so it moves.
    const blocked = placeLabels(
      [request('a', 400, 300, { previousSlot: 3 }), request('b', 330, 330, { priority: 5, previousSlot: 1 })],
      viewport,
    );
    expect(blocked.get('a')?.slot).not.toBe(3);
  });

  it('finds the label or marker under the pointer', () => {
    const placed = placeLabels([request('a', 400, 300), request('b', 800, 500)], viewport);
    const a = placed.get('a');
    expect(hitTestLabels(placed.values(), (a?.left ?? 0) + 5, (a?.top ?? 0) + 5)).toBe('a');
    expect(hitTestLabels(placed.values(), 803, 498)).toBe('b');
    expect(hitTestLabels(placed.values(), 100, 100)).toBeNull();
  });
});

describe('view presets', () => {
  const end = (ident: string, lat: number, lon: number, headingTrue: number) => ({
    ident,
    lat,
    lon,
    headingTrue,
    elevationFt: 600,
    displacedThresholdFt: 0,
  });
  const runways: Runway[] = [
    {
      id: '05/23',
      lengthFt: 4225,
      widthFt: 100,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [end('05', 40.40819931, -86.93900299, 47.3), end('23', 40.41569901, -86.92749786, 227.3)],
    },
    {
      id: '10/28',
      lengthFt: 6600,
      widthFt: 150,
      surface: 'ASP',
      lighted: true,
      closed: false,
      ends: [end('10', 40.41400146, -86.95089722, 100), end('28', 40.41109848, -86.92749786, 280)],
    },
  ];
  const klaf = (tower: AirportInfo['tower'] = null): AirportInfo => ({
    icao: 'KLAF',
    name: 'Purdue University Airport',
    city: 'West Lafayette',
    lat: 40.412875,
    lon: -86.939363,
    elevationFt: 606,
    defaultView: 'tower',
    available: true,
    geoidUndulationM: -34.32,
    elevationEllipsoidM: 150.39,
    timezone: 'America/Indiana/Indianapolis',
    radiusNm: 6,
    ceilingFtAgl: 5000,
    tower,
    runways,
    links: { liveatc: 'https://x.test/', diagram: 'https://x.test/', flightaware: 'https://x.test/' },
    audio: [],
    sources: { airport: 'ourairports', layout: null, layoutFetchedAt: null },
  });

  it('measures the runway system', () => {
    const footprint = airportFootprint(klaf());
    expect(footprint.radiusM).toBeGreaterThan(900);
    expect(footprint.radiusM).toBeLessThan(1400);
    // Without runways, fall back to the reference point.
    expect(airportFootprint({ lat: 1, lon: 2, runways: [] })).toEqual({ lat: 1, lon: 2, radiusM: 1500 });
  });

  it('offers tower, overhead, every runway end, orbit and follow', () => {
    const presets = buildViewPresets(
      klaf({ lat: 40.4135, lon: -86.9361, heightM: 21, approximate: true, source: 'osm' }),
    );
    expect(presets.map((p) => p.id)).toEqual([
      'tower',
      'overhead',
      'rwy-05',
      'rwy-23',
      'rwy-10',
      'rwy-28',
      'orbit',
      'follow',
    ]);
    const tower = presets[0];
    expect(tower).toMatchObject({ available: true, note: 'Tower position is approximate' });
    expect(tower?.pose).toMatchObject({ lat: 40.4135, lon: -86.9361, heightAglM: 21 });
  });

  it('says so when the tower position is unknown, instead of inventing one', () => {
    const tower = buildViewPresets(klaf())[0];
    expect(tower).toMatchObject({ id: 'tower', available: false });
    expect(tower?.pose).toBeUndefined();
    expect(tower?.note).toContain('config.yaml');
  });

  it('stands short of each threshold on the extended centreline, looking down the runway', () => {
    const presets = buildViewPresets(klaf());
    const rwy10 = presets.find((p) => p.id === 'rwy-10');
    const threshold = runways[1]?.ends[0];
    expect(rwy10?.pose?.headingDeg).toBe(100);
    // West of the threshold, a few hundred metres back.
    expect(rwy10?.pose?.lon).toBeLessThan(threshold?.lon ?? 0);
    const back = distanceM(
      rwy10?.pose?.lat ?? 0,
      rwy10?.pose?.lon ?? 0,
      threshold?.lat ?? 0,
      threshold?.lon ?? 0,
    );
    expect(back).toBeGreaterThan(400);
    expect(back).toBeLessThan(550);
  });

  it('resolves the view from the URL, falling back to overhead', () => {
    const presets = buildViewPresets(klaf());
    expect(resolveView(presets, 'RWY-28').id).toBe('rwy-28');
    expect(resolveView(presets, 'orbit').id).toBe('orbit');
    expect(resolveView(presets, 'tower').id).toBe('overhead'); // no tower known
    expect(resolveView(presets, 'nonsense').id).toBe('overhead');
    expect(resolveView(presets, null).id).toBe('overhead');
    expect(resolveView(presets, 'follow').id).toBe('overhead'); // nothing to follow on load
  });

  it('maps keys 1 to 5, with 3 stepping through the runway ends', () => {
    const presets = buildViewPresets(klaf());
    expect(viewForShortcut(presets, '1', 'overhead')).toBe('tower');
    expect(viewForShortcut(presets, '2', 'tower')).toBe('overhead');
    expect(viewForShortcut(presets, '3', 'overhead')).toBe('rwy-05');
    expect(viewForShortcut(presets, '3', 'rwy-05')).toBe('rwy-23');
    expect(viewForShortcut(presets, '3', 'rwy-28')).toBe('rwy-05');
    expect(viewForShortcut(presets, '4', 'overhead')).toBe('orbit');
    expect(viewForShortcut(presets, '5', 'overhead')).toBe('follow');
    expect(viewForShortcut(presets, '9', 'overhead')).toBeNull();
  });
});
