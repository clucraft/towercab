/**
 * Generates the placeholder aircraft models: one clean low-poly glTF binary per model class, written to
 * apps/web/public/models/{class}.glb.
 *
 *   pnpm gen:models
 *
 * Conventions every model follows, so the renderer can treat them alike:
 * - glTF axes: +Y up, +Z forward (the nose points along +Z);
 * - the wingspan (rotor diameter for helicopters, width for vehicles) is exactly 1 unit, so scaling the model
 *   by an aircraft's real wingspan in metres draws it at its real size;
 * - Y = 0 is the bottom of the wheels, so an aircraft placed at ground height stands on the surface;
 * - the origin is under the wing, roughly at the centre of gravity.
 *
 * To use a better model, drop a file with the same name into /data/models/. It must follow the same conventions.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { Document, NodeIO } from '@gltf-transform/core';

type Vec3 = [number, number, number];

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const centroid = (points: Vec3[]): Vec3 => {
  const c: Vec3 = [0, 0, 0];
  for (const p of points) {
    c[0] += p[0] / points.length;
    c[1] += p[1] / points.length;
    c[2] += p[2] / points.length;
  }
  return c;
};

type MaterialName = 'body' | 'dark' | 'glass' | 'prop';

/** Collects flat-shaded triangles per material. Every face is oriented away from a point inside the part. */
class Shape {
  readonly parts = new Map<MaterialName, { positions: number[]; normals: number[] }>();

  private tri(material: MaterialName, a: Vec3, b: Vec3, c: Vec3, inside: Vec3): void {
    let n = cross(sub(b, a), sub(c, a));
    const length = Math.hypot(n[0], n[1], n[2]);
    if (length < 1e-12) return;
    let [p, q, r] = [a, b, c];
    if (dot(n, sub(centroid([a, b, c]), inside)) < 0) {
      [q, r] = [c, b];
      n = [-n[0], -n[1], -n[2]];
    }
    n = [n[0] / length, n[1] / length, n[2] / length];
    let part = this.parts.get(material);
    if (!part) {
      part = { positions: [], normals: [] };
      this.parts.set(material, part);
    }
    part.positions.push(...p, ...q, ...r);
    part.normals.push(...n, ...n, ...n);
  }

  private quad(material: MaterialName, a: Vec3, b: Vec3, c: Vec3, d: Vec3, inside: Vec3): void {
    this.tri(material, a, b, c, inside);
    this.tri(material, a, c, d, inside);
  }

  /** A body of revolution-like shape: elliptical rings along Z joined by flat panels, with closed ends. */
  loft(
    material: MaterialName,
    sections: { z: number; y: number; rx: number; ry: number; x?: number }[],
    sides = 10,
  ): void {
    const rings = sections.map((s) => {
      const ring: Vec3[] = [];
      for (let k = 0; k < sides; k += 1) {
        const a = (2 * Math.PI * k) / sides;
        ring.push([(s.x ?? 0) + s.rx * Math.cos(a), s.y + s.ry * Math.sin(a), s.z]);
      }
      return ring;
    });
    for (let i = 0; i < rings.length - 1; i += 1) {
      const a = rings[i] as Vec3[];
      const b = rings[i + 1] as Vec3[];
      const inside = centroid([...a, ...b]);
      for (let k = 0; k < sides; k += 1) {
        const k2 = (k + 1) % sides;
        this.quad(material, a[k] as Vec3, a[k2] as Vec3, b[k2] as Vec3, b[k] as Vec3, inside);
      }
    }
    const all = centroid(rings.flat());
    for (const ring of [rings[0] as Vec3[], rings[rings.length - 1] as Vec3[]]) {
      const middle = centroid(ring);
      for (let k = 0; k < sides; k += 1) {
        this.tri(material, middle, ring[k] as Vec3, ring[(k + 1) % sides] as Vec3, all);
      }
    }
  }

  /** A six-sided solid through eight corners: four at one end, four at the other, in matching order. */
  hexahedron(material: MaterialName, a: [Vec3, Vec3, Vec3, Vec3], b: [Vec3, Vec3, Vec3, Vec3]): void {
    const inside = centroid([...a, ...b]);
    this.quad(material, a[0], a[1], a[2], a[3], inside);
    this.quad(material, b[0], b[1], b[2], b[3], inside);
    for (let k = 0; k < 4; k += 1) {
      const k2 = (k + 1) % 4;
      this.quad(material, a[k] as Vec3, a[k2] as Vec3, b[k2] as Vec3, b[k] as Vec3, inside);
    }
  }

  box(material: MaterialName, centre: Vec3, size: Vec3): void {
    const [cx, cy, cz] = centre;
    const [sx, sy, sz] = [size[0] / 2, size[1] / 2, size[2] / 2];
    this.hexahedron(
      material,
      [
        [cx - sx, cy - sy, cz - sz],
        [cx + sx, cy - sy, cz - sz],
        [cx + sx, cy + sy, cz - sz],
        [cx - sx, cy + sy, cz - sz],
      ],
      [
        [cx - sx, cy - sy, cz + sz],
        [cx + sx, cy - sy, cz + sz],
        [cx + sx, cy + sy, cz + sz],
        [cx - sx, cy + sy, cz + sz],
      ],
    );
  }

  /**
   * A flat tapered panel (wing, tailplane or fin) between a root and a tip chord.
   * `le` is the leading-edge point at mid-thickness; the chord runs towards -Z. `up` is the thickness direction.
   */
  panel(
    material: MaterialName,
    root: { le: Vec3; chord: number; thickness: number },
    tip: { le: Vec3; chord: number; thickness: number },
    up: Vec3 = [0, 1, 0],
  ): void {
    const section = (s: { le: Vec3; chord: number; thickness: number }): [Vec3, Vec3, Vec3, Vec3] => {
      const h = s.thickness / 2;
      const top = (z: number): Vec3 => [s.le[0] + up[0] * h, s.le[1] + up[1] * h, z];
      const bottom = (z: number): Vec3 => [s.le[0] - up[0] * h, s.le[1] - up[1] * h, z];
      return [bottom(s.le[2]), top(s.le[2]), top(s.le[2] - s.chord), bottom(s.le[2] - s.chord)];
    };
    this.hexahedron(material, section(root), section(tip));
  }

  /** The same panel on both sides of the aircraft. */
  mirroredPanel(
    material: MaterialName,
    root: { le: Vec3; chord: number; thickness: number },
    tip: { le: Vec3; chord: number; thickness: number },
  ): void {
    this.panel(material, root, tip);
    const flip = (p: Vec3): Vec3 => [-p[0], p[1], p[2]];
    this.panel(material, { ...root, le: flip(root.le) }, { ...tip, le: flip(tip.le) });
  }

  /** A thin horizontal disc (axis along Y), for a spinning rotor. */
  diskY(material: MaterialName, centre: Vec3, radius: number, thickness: number, sides = 20): void {
    const ring = (y: number): Vec3[] => {
      const points: Vec3[] = [];
      for (let k = 0; k < sides; k += 1) {
        const a = (2 * Math.PI * k) / sides;
        points.push([centre[0] + radius * Math.cos(a), y, centre[2] + radius * Math.sin(a)]);
      }
      return points;
    };
    const top = ring(centre[1] + thickness / 2);
    const bottom = ring(centre[1] - thickness / 2);
    for (let k = 0; k < sides; k += 1) {
      const k2 = (k + 1) % sides;
      this.tri(
        material,
        [centre[0], centre[1] + thickness / 2, centre[2]],
        top[k] as Vec3,
        top[k2] as Vec3,
        centre,
      );
      this.tri(
        material,
        [centre[0], centre[1] - thickness / 2, centre[2]],
        bottom[k] as Vec3,
        bottom[k2] as Vec3,
        centre,
      );
      this.quad(material, top[k] as Vec3, top[k2] as Vec3, bottom[k2] as Vec3, bottom[k] as Vec3, centre);
    }
  }

  /** Moves everything so that the lowest point is at Y = 0 and `zOrigin` becomes Z = 0. */
  settle(zOrigin: number): void {
    let minY = Number.POSITIVE_INFINITY;
    for (const part of this.parts.values()) {
      for (let i = 1; i < part.positions.length; i += 3) minY = Math.min(minY, part.positions[i] as number);
    }
    for (const part of this.parts.values()) {
      for (let i = 0; i < part.positions.length; i += 3) {
        part.positions[i + 1] = (part.positions[i + 1] as number) - minY;
        part.positions[i + 2] = (part.positions[i + 2] as number) - zOrigin;
      }
    }
  }

  bounds(): { min: Vec3; max: Vec3 } {
    const min: Vec3 = [Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY];
    const max: Vec3 = [Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY];
    for (const part of this.parts.values()) {
      for (let i = 0; i < part.positions.length; i += 3) {
        for (let k = 0; k < 3; k += 1) {
          min[k] = Math.min(min[k] as number, part.positions[i + k] as number);
          max[k] = Math.max(max[k] as number, part.positions[i + k] as number);
        }
      }
    }
    return { min, max };
  }
}

interface EngineSpec {
  kind: 'prop' | 'jet';
  /** Lateral position as a fraction of the half-span. 0 is on the centreline. */
  x: number;
  /** Where it hangs: on the nose, under the wing, on the rear fuselage, or in the tail fin. */
  mount: 'nose' | 'wing' | 'rear' | 'tail';
  radius: number;
  length: number;
}

interface FixedWingSpec {
  /** Overall length in wingspans. */
  length: number;
  /** Half-width and half-height of the fuselage at its widest. */
  radius: number;
  heightRatio?: number;
  /** Fractions of the length taken up by the nose and tail tapers. */
  nose: number;
  tail: number;
  wing: {
    /** Leading edge at the root, as a fraction of the length back from the nose. */
    station: number;
    rootChord: number;
    tipChord: number;
    /** How far the tip leading edge sits behind the root leading edge. */
    sweep: number;
    dihedral: number;
    mount: 'low' | 'high';
    winglets?: boolean;
  };
  tailplane: { span: number; rootChord: number; tipChord: number; sweep: number; tTail?: boolean };
  fin: { height: number; rootChord: number; tipChord: number; sweep: number };
  engines: EngineSpec[];
  gear: { height: number; track: number; wheel: number };
}

function fixedWing(spec: FixedWingSpec): Shape {
  const shape = new Shape();
  const L = spec.length;
  const r = spec.radius;
  const ry = r * (spec.heightRatio ?? 1);
  const cy = spec.gear.height + ry;
  const noseZ = L / 2;
  const tailZ = -L / 2;
  const station = (fraction: number) => noseZ - fraction * L;

  // Fuselage: pointed nose, constant section, tail that tapers upwards.
  shape.loft('body', [
    { z: noseZ, y: cy - ry * 0.15, rx: r * 0.08, ry: ry * 0.08 },
    { z: noseZ - spec.nose * L * 0.35, y: cy - ry * 0.08, rx: r * 0.6, ry: ry * 0.62 },
    { z: noseZ - spec.nose * L, y: cy, rx: r, ry },
    { z: tailZ + spec.tail * L, y: cy, rx: r, ry },
    { z: tailZ + spec.tail * L * 0.4, y: cy + ry * 0.3, rx: r * 0.5, ry: ry * 0.55 },
    { z: tailZ, y: cy + ry * 0.5, rx: r * 0.1, ry: ry * 0.18 },
  ]);
  // Windscreen: a dark wedge on top of the nose.
  shape.loft(
    'glass',
    [
      { z: noseZ - spec.nose * L * 0.45, y: cy + ry * 0.38, rx: r * 0.5, ry: ry * 0.22 },
      { z: noseZ - spec.nose * L * 0.95, y: cy + ry * 0.62, rx: r * 0.72, ry: ry * 0.34 },
      { z: noseZ - spec.nose * L * 1.25, y: cy + ry * 0.7, rx: r * 0.66, ry: ry * 0.3 },
    ],
    8,
  );

  // Wing.
  const w = spec.wing;
  const wingY = w.mount === 'high' ? cy + ry * 0.92 : cy - ry * 0.55;
  const rootLe: Vec3 = [r * 0.6, wingY, station(w.station)];
  const tipLe: Vec3 = [0.5, wingY + w.dihedral, station(w.station) - w.sweep];
  shape.mirroredPanel(
    'body',
    { le: rootLe, chord: w.rootChord, thickness: w.rootChord * 0.13 },
    { le: tipLe, chord: w.tipChord, thickness: w.tipChord * 0.1 },
  );
  // Centre section, so the two wings meet through the fuselage.
  shape.panel(
    'body',
    { le: [-rootLe[0], wingY, rootLe[2]], chord: w.rootChord, thickness: w.rootChord * 0.13 },
    { le: rootLe, chord: w.rootChord, thickness: w.rootChord * 0.13 },
  );
  if (w.winglets) {
    for (const side of [1, -1]) {
      shape.panel(
        'body',
        { le: [side * 0.497, tipLe[1], tipLe[2]], chord: w.tipChord, thickness: 0.006 },
        {
          le: [side * 0.497, tipLe[1] + 0.045, tipLe[2] - w.tipChord * 0.55],
          chord: w.tipChord * 0.45,
          thickness: 0.005,
        },
        [1, 0, 0],
      );
    }
  }

  // Fin.
  const f = spec.fin;
  const finRootZ = tailZ + f.rootChord * 1.02;
  const finBaseY = cy + ry * 0.55;
  shape.panel(
    'body',
    { le: [0, finBaseY, finRootZ], chord: f.rootChord, thickness: f.rootChord * 0.1 },
    { le: [0, finBaseY + f.height, finRootZ - f.sweep], chord: f.tipChord, thickness: f.tipChord * 0.09 },
    [1, 0, 0],
  );

  // Tailplane: on the fuselage, or on top of the fin.
  const t = spec.tailplane;
  const tailY = t.tTail ? finBaseY + f.height : cy + ry * 0.35;
  const tailRootZ = t.tTail ? finRootZ - f.sweep + f.tipChord * 0.15 : tailZ + t.rootChord * 1.15;
  shape.mirroredPanel(
    'body',
    { le: [0, tailY, tailRootZ], chord: t.rootChord, thickness: t.rootChord * 0.1 },
    { le: [t.span / 2, tailY, tailRootZ - t.sweep], chord: t.tipChord, thickness: t.tipChord * 0.09 },
  );

  // Engines.
  const wingLeAt = (x: number): Vec3 => {
    const u = (Math.abs(x) - rootLe[0]) / (0.5 - rootLe[0]);
    return [x, rootLe[1] + (tipLe[1] - rootLe[1]) * u, rootLe[2] + (tipLe[2] - rootLe[2]) * u];
  };
  for (const e of spec.engines) {
    const sides = e.mount === 'nose' ? [0] : e.mount === 'tail' ? [0] : [1, -1];
    for (const side of sides) {
      let centre: Vec3;
      if (e.mount === 'nose') {
        centre = [0, cy - ry * 0.1, noseZ + 0.004];
      } else if (e.mount === 'wing') {
        const le = wingLeAt(side * e.x * 0.5);
        const drop = e.kind === 'jet' ? e.radius * 1.25 : 0;
        centre = [le[0], le[1] - drop, le[2] + e.length * (e.kind === 'jet' ? 0.25 : 0.45)];
      } else if (e.mount === 'rear') {
        centre = [side * (r + e.radius * 1.05), cy + ry * 0.35, tailZ + spec.tail * L * 0.95];
      } else {
        centre = [0, finBaseY + f.height * 0.32, finRootZ - f.rootChord * 0.3];
      }
      if (e.mount !== 'nose') {
        shape.loft(
          'dark',
          [
            {
              z: centre[2] + e.length / 2,
              x: centre[0],
              y: centre[1],
              rx: e.radius * 0.86,
              ry: e.radius * 0.86,
            },
            { z: centre[2] + e.length * 0.3, x: centre[0], y: centre[1], rx: e.radius, ry: e.radius },
            {
              z: centre[2] - e.length * 0.25,
              x: centre[0],
              y: centre[1],
              rx: e.radius * 0.95,
              ry: e.radius * 0.95,
            },
            {
              z: centre[2] - e.length / 2,
              x: centre[0],
              y: centre[1],
              rx: e.radius * 0.6,
              ry: e.radius * 0.6,
            },
          ],
          8,
        );
        if (e.kind === 'jet' && e.mount === 'wing') {
          // Pylon between the nacelle and the wing.
          shape.box(
            'body',
            [centre[0], centre[1] + e.radius * 0.95, centre[2] - e.length * 0.15],
            [e.radius * 0.25, e.radius * 0.9, e.length * 0.6],
          );
        }
      }
      if (e.kind === 'prop') {
        const discZ = e.mount === 'nose' ? noseZ + 0.006 : centre[2] + e.length / 2 + 0.006;
        const propRadius = e.mount === 'nose' ? e.radius : e.radius * 2.6;
        shape.loft(
          'prop',
          [
            { z: discZ + 0.002, x: centre[0], y: centre[1], rx: propRadius, ry: propRadius },
            { z: discZ - 0.002, x: centre[0], y: centre[1], rx: propRadius, ry: propRadius },
          ],
          16,
        );
      }
    }
  }

  // Landing gear: nose wheel and two main wheels, each a strut and a wheel block.
  const g = spec.gear;
  const mainZ = station(w.station) - w.rootChord * 0.55;
  const wheels: Vec3[] = [
    [0, 0, noseZ - spec.nose * L * 0.9],
    [g.track / 2, 0, mainZ],
    [-g.track / 2, 0, mainZ],
  ];
  for (const [x, , z] of wheels) {
    shape.box('dark', [x, g.wheel / 2, z], [g.wheel * 0.45, g.wheel, g.wheel]);
    shape.box(
      'dark',
      [x, (g.height + g.wheel) / 2, z],
      [g.wheel * 0.18, g.height - g.wheel + ry * 0.4, g.wheel * 0.18],
    );
  }

  // Origin under the wing, a third of the root chord back from its leading edge.
  shape.settle(station(w.station) - w.rootChord * 0.35);
  return shape;
}

function helicopter(): Shape {
  const shape = new Shape();
  const skid = 0.035;
  const cy = skid + 0.085;
  // Cabin pod and tail boom.
  shape.loft('body', [
    { z: 0.3, y: cy - 0.02, rx: 0.02, ry: 0.025 },
    { z: 0.24, y: cy, rx: 0.07, ry: 0.07 },
    { z: 0.1, y: cy + 0.005, rx: 0.085, ry: 0.085 },
    { z: -0.08, y: cy + 0.01, rx: 0.075, ry: 0.075 },
    { z: -0.2, y: cy + 0.035, rx: 0.028, ry: 0.03 },
    { z: -0.62, y: cy + 0.06, rx: 0.014, ry: 0.016 },
  ]);
  shape.loft(
    'glass',
    [
      { z: 0.27, y: cy + 0.012, rx: 0.045, ry: 0.04 },
      { z: 0.17, y: cy + 0.04, rx: 0.074, ry: 0.052 },
      { z: 0.08, y: cy + 0.046, rx: 0.078, ry: 0.05 },
    ],
    8,
  );
  // Mast and main rotor disc (diameter 1).
  shape.box('dark', [0, cy + 0.115, 0.02], [0.02, 0.06, 0.02]);
  shape.diskY('prop', [0, cy + 0.15, 0.02], 0.5, 0.006);
  // Tail fin and tail rotor.
  shape.panel(
    'body',
    { le: [0, cy + 0.03, -0.56], chord: 0.07, thickness: 0.008 },
    { le: [0, cy + 0.16, -0.6], chord: 0.04, thickness: 0.006 },
    [1, 0, 0],
  );
  shape.box('dark', [0.018, cy + 0.07, -0.61], [0.006, 0.16, 0.012]);
  // Skids.
  for (const side of [1, -1]) {
    shape.box('dark', [side * 0.075, skid / 4, 0.05], [0.012, skid / 2, 0.36]);
    shape.box('dark', [side * 0.075, skid * 0.75, 0.14], [0.008, skid, 0.008]);
    shape.box('dark', [side * 0.075, skid * 0.75, -0.04], [0.008, skid, 0.008]);
  }
  shape.settle(0.02);
  return shape;
}

function groundVehicle(): Shape {
  const shape = new Shape();
  // Width 1 (2.5 m at scale), length 2.4, height 0.9.
  shape.box('body', [0, 0.42, -0.25], [1, 0.6, 1.7]);
  shape.box('body', [0, 0.37, 0.9], [1, 0.5, 0.6]);
  shape.box('glass', [0, 0.72, 0.72], [0.9, 0.3, 0.5]);
  for (const x of [0.44, -0.44]) {
    for (const z of [0.75, -0.7]) shape.box('dark', [x, 0.16, z], [0.12, 0.32, 0.36]);
  }
  shape.settle(0);
  return shape;
}

const prop = (x: number, mount: EngineSpec['mount'], radius: number, length = 0.1): EngineSpec => ({
  kind: 'prop',
  x,
  mount,
  radius,
  length,
});
const jet = (x: number, mount: EngineSpec['mount'], radius: number, length: number): EngineSpec => ({
  kind: 'jet',
  x,
  mount,
  radius,
  length,
});

/** Proportions are in wingspans and follow a typical member of each class. */
const CLASSES: Record<string, () => Shape> = {
  // Cessna 172: high, straight wing; fixed tricycle gear.
  'ga-single-high': () =>
    fixedWing({
      length: 0.75,
      radius: 0.052,
      heightRatio: 1.1,
      nose: 0.2,
      tail: 0.5,
      wing: { station: 0.24, rootChord: 0.15, tipChord: 0.105, sweep: 0.0, dihedral: 0.012, mount: 'high' },
      tailplane: { span: 0.31, rootChord: 0.1, tipChord: 0.065, sweep: 0.02 },
      fin: { height: 0.13, rootChord: 0.13, tipChord: 0.06, sweep: 0.07 },
      engines: [prop(0, 'nose', 0.085)],
      gear: { height: 0.06, track: 0.23, wheel: 0.04 },
    }),
  // Piper PA-28 / Cirrus SR22: low wing.
  'ga-single-low': () =>
    fixedWing({
      length: 0.7,
      radius: 0.05,
      heightRatio: 1.05,
      nose: 0.22,
      tail: 0.48,
      wing: { station: 0.27, rootChord: 0.155, tipChord: 0.1, sweep: 0.012, dihedral: 0.035, mount: 'low' },
      tailplane: { span: 0.33, rootChord: 0.095, tipChord: 0.07, sweep: 0.015 },
      fin: { height: 0.13, rootChord: 0.13, tipChord: 0.055, sweep: 0.08 },
      engines: [prop(0, 'nose', 0.085)],
      gear: { height: 0.05, track: 0.28, wheel: 0.038 },
    }),
  // Piper Seminole / Beech Baron.
  'ga-twin': () =>
    fixedWing({
      length: 0.76,
      radius: 0.052,
      heightRatio: 1.08,
      nose: 0.26,
      tail: 0.46,
      wing: { station: 0.3, rootChord: 0.16, tipChord: 0.095, sweep: 0.015, dihedral: 0.04, mount: 'low' },
      tailplane: { span: 0.36, rootChord: 0.1, tipChord: 0.07, sweep: 0.02 },
      fin: { height: 0.15, rootChord: 0.14, tipChord: 0.06, sweep: 0.09 },
      engines: [prop(0.36, 'wing', 0.032, 0.16)],
      gear: { height: 0.055, track: 0.3, wheel: 0.038 },
    }),
  // Pilatus PC-12 / TBM.
  'turboprop-single': () =>
    fixedWing({
      length: 0.88,
      radius: 0.05,
      heightRatio: 1.08,
      nose: 0.24,
      tail: 0.42,
      wing: {
        station: 0.36,
        rootChord: 0.135,
        tipChord: 0.07,
        sweep: 0.02,
        dihedral: 0.04,
        mount: 'low',
        winglets: true,
      },
      tailplane: { span: 0.3, rootChord: 0.085, tipChord: 0.055, sweep: 0.025, tTail: true },
      fin: { height: 0.15, rootChord: 0.16, tipChord: 0.085, sweep: 0.1 },
      engines: [prop(0, 'nose', 0.082)],
      gear: { height: 0.055, track: 0.26, wheel: 0.034 },
    }),
  // King Air / ATR 72.
  'turboprop-twin': () =>
    fixedWing({
      length: 0.84,
      radius: 0.046,
      heightRatio: 1.08,
      nose: 0.22,
      tail: 0.4,
      wing: { station: 0.36, rootChord: 0.125, tipChord: 0.06, sweep: 0.018, dihedral: 0.035, mount: 'low' },
      tailplane: { span: 0.32, rootChord: 0.085, tipChord: 0.05, sweep: 0.03, tTail: true },
      fin: { height: 0.16, rootChord: 0.17, tipChord: 0.085, sweep: 0.1 },
      engines: [prop(0.3, 'wing', 0.028, 0.18)],
      gear: { height: 0.055, track: 0.3, wheel: 0.032 },
    }),
  // Citation / Challenger: swept wing, engines on the rear fuselage, T-tail.
  bizjet: () =>
    fixedWing({
      length: 1.0,
      radius: 0.048,
      nose: 0.2,
      tail: 0.36,
      wing: {
        station: 0.42,
        rootChord: 0.17,
        tipChord: 0.055,
        sweep: 0.13,
        dihedral: 0.03,
        mount: 'low',
        winglets: true,
      },
      tailplane: { span: 0.36, rootChord: 0.1, tipChord: 0.045, sweep: 0.07, tTail: true },
      fin: { height: 0.17, rootChord: 0.2, tipChord: 0.11, sweep: 0.14 },
      engines: [jet(0, 'rear', 0.034, 0.17)],
      gear: { height: 0.045, track: 0.2, wheel: 0.028 },
    }),
  // CRJ: long fuselage, rear engines, T-tail.
  'regional-jet': () =>
    fixedWing({
      length: 1.36,
      radius: 0.055,
      nose: 0.13,
      tail: 0.26,
      wing: {
        station: 0.44,
        rootChord: 0.2,
        tipChord: 0.055,
        sweep: 0.19,
        dihedral: 0.03,
        mount: 'low',
        winglets: true,
      },
      tailplane: { span: 0.36, rootChord: 0.11, tipChord: 0.05, sweep: 0.09, tTail: true },
      fin: { height: 0.2, rootChord: 0.22, tipChord: 0.12, sweep: 0.17 },
      engines: [jet(0, 'rear', 0.04, 0.2)],
      gear: { height: 0.05, track: 0.17, wheel: 0.028 },
    }),
  // A320 / 737: two engines under a swept wing.
  narrowbody: () =>
    fixedWing({
      length: 1.08,
      radius: 0.056,
      nose: 0.11,
      tail: 0.28,
      wing: {
        station: 0.36,
        rootChord: 0.2,
        tipChord: 0.045,
        sweep: 0.2,
        dihedral: 0.05,
        mount: 'low',
        winglets: true,
      },
      tailplane: { span: 0.36, rootChord: 0.12, tipChord: 0.04, sweep: 0.11 },
      fin: { height: 0.2, rootChord: 0.2, tipChord: 0.07, sweep: 0.16 },
      engines: [jet(0.34, 'wing', 0.034, 0.13)],
      gear: { height: 0.07, track: 0.21, wheel: 0.03 },
    }),
  // 767 / 777 / A300.
  'widebody-twin': () =>
    fixedWing({
      length: 1.08,
      radius: 0.052,
      nose: 0.1,
      tail: 0.27,
      wing: { station: 0.34, rootChord: 0.22, tipChord: 0.04, sweep: 0.24, dihedral: 0.055, mount: 'low' },
      tailplane: { span: 0.36, rootChord: 0.13, tipChord: 0.04, sweep: 0.13 },
      fin: { height: 0.19, rootChord: 0.2, tipChord: 0.065, sweep: 0.17 },
      engines: [jet(0.33, 'wing', 0.04, 0.14)],
      gear: { height: 0.07, track: 0.19, wheel: 0.03 },
    }),
  // MD-11 / DC-10: two under the wing, one in the fin.
  'widebody-tri': () =>
    fixedWing({
      length: 1.18,
      radius: 0.058,
      nose: 0.1,
      tail: 0.24,
      wing: {
        station: 0.36,
        rootChord: 0.22,
        tipChord: 0.045,
        sweep: 0.25,
        dihedral: 0.05,
        mount: 'low',
        winglets: true,
      },
      tailplane: { span: 0.39, rootChord: 0.13, tipChord: 0.045, sweep: 0.13 },
      fin: { height: 0.2, rootChord: 0.2, tipChord: 0.09, sweep: 0.14 },
      engines: [jet(0.32, 'wing', 0.04, 0.14), jet(0, 'tail', 0.042, 0.22)],
      gear: { height: 0.075, track: 0.21, wheel: 0.03 },
    }),
  // 747 / A380 / C-17.
  'widebody-quad': () =>
    fixedWing({
      length: 1.1,
      radius: 0.052,
      heightRatio: 1.15,
      nose: 0.1,
      tail: 0.27,
      wing: { station: 0.33, rootChord: 0.23, tipChord: 0.045, sweep: 0.27, dihedral: 0.055, mount: 'low' },
      tailplane: { span: 0.36, rootChord: 0.13, tipChord: 0.04, sweep: 0.14 },
      fin: { height: 0.19, rootChord: 0.2, tipChord: 0.065, sweep: 0.17 },
      engines: [jet(0.38, 'wing', 0.03, 0.11), jet(0.66, 'wing', 0.03, 0.11)],
      gear: { height: 0.07, track: 0.19, wheel: 0.03 },
    }),
  helicopter,
  'ground-vehicle': groundVehicle,
  // Unknown type: a plain low-wing single.
  generic: () =>
    fixedWing({
      length: 0.74,
      radius: 0.05,
      nose: 0.22,
      tail: 0.46,
      wing: { station: 0.3, rootChord: 0.15, tipChord: 0.09, sweep: 0.03, dihedral: 0.03, mount: 'low' },
      tailplane: { span: 0.33, rootChord: 0.095, tipChord: 0.065, sweep: 0.03 },
      fin: { height: 0.14, rootChord: 0.14, tipChord: 0.06, sweep: 0.09 },
      engines: [],
      gear: { height: 0.05, track: 0.26, wheel: 0.036 },
    }),
};

const MATERIALS: Record<
  MaterialName,
  { color: [number, number, number, number]; metallic: number; roughness: number }
> = {
  body: { color: [0.86, 0.88, 0.9, 1], metallic: 0.15, roughness: 0.55 },
  dark: { color: [0.2, 0.22, 0.25, 1], metallic: 0.3, roughness: 0.6 },
  glass: { color: [0.08, 0.12, 0.18, 1], metallic: 0.6, roughness: 0.2 },
  prop: { color: [0.75, 0.78, 0.82, 0.28], metallic: 0, roughness: 0.9 },
};

async function writeModel(
  name: string,
  shape: Shape,
  file: string,
): Promise<{ triangles: number; bytes: number }> {
  const doc = new Document();
  doc.getRoot().getAsset().generator = 'TowerCab scripts/gen-models.ts';
  const buffer = doc.createBuffer();
  const mesh = doc.createMesh(name);
  let triangles = 0;
  for (const [materialName, part] of shape.parts) {
    if (part.positions.length === 0) continue;
    const def = MATERIALS[materialName];
    const material = doc
      .createMaterial(materialName)
      .setBaseColorFactor(def.color)
      .setMetallicFactor(def.metallic)
      .setRoughnessFactor(def.roughness);
    if (def.color[3] < 1) material.setAlphaMode('BLEND').setDoubleSided(true);
    const position = doc
      .createAccessor(`${materialName}-position`)
      .setType('VEC3')
      .setArray(new Float32Array(part.positions))
      .setBuffer(buffer);
    const normal = doc
      .createAccessor(`${materialName}-normal`)
      .setType('VEC3')
      .setArray(new Float32Array(part.normals))
      .setBuffer(buffer);
    mesh.addPrimitive(
      doc
        .createPrimitive()
        .setAttribute('POSITION', position)
        .setAttribute('NORMAL', normal)
        .setMaterial(material),
    );
    triangles += part.positions.length / 9;
  }
  doc.createScene(name).addChild(doc.createNode(name).setMesh(mesh));
  const bytes = await new NodeIO().writeBinary(doc);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, bytes);
  return { triangles, bytes: bytes.byteLength };
}

async function main(): Promise<void> {
  const outDir = join(import.meta.dirname, '..', 'apps', 'web', 'public', 'models');
  for (const [name, build] of Object.entries(CLASSES)) {
    const shape = build();
    const { min, max } = shape.bounds();
    const span = max[0] - min[0];
    // Every model must be exactly one unit wide and stand on Y = 0, or real-size scaling would be wrong.
    if (Math.abs(span - 1) > 1e-6) throw new Error(`${name}: span is ${span}, expected 1`);
    if (Math.abs(min[1]) > 1e-9) throw new Error(`${name}: lowest point is ${min[1]}, expected 0`);
    const result = await writeModel(name, shape, join(outDir, `${name}.glb`));
    console.log(
      `${name.padEnd(18)} ${String(result.triangles).padStart(5)} triangles  ${(result.bytes / 1024).toFixed(1).padStart(6)} kB  ` +
        `length ${(max[2] - min[2]).toFixed(2)}  height ${max[1].toFixed(2)}`,
    );
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
