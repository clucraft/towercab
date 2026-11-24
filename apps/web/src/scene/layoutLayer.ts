import type { AirportDetail, LayoutFeature } from '@towercab/shared';
import { M_PER_FT } from '@towercab/shared';
import {
  Cartesian2,
  Cartesian3,
  ClassificationType,
  Color,
  CornerType,
  CustomDataSource,
  DistanceDisplayCondition,
  HeightReference,
  HorizontalOrigin,
  LabelStyle,
  NearFarScalar,
  PolygonHierarchy,
  PolylineDashMaterialProperty,
  VerticalOrigin,
  type Viewer,
} from 'cesium';
import { SCHEMATIC } from './palette';

type LonLat = [number, number];

const color = (css: string, alpha = 1): Color => Color.fromCssColorString(css).withAlpha(alpha);
const positions = (line: LonLat[]): Cartesian3[] => Cartesian3.fromDegreesArray(line.flat());

/** Widths used when OpenStreetMap does not give one, in metres. */
const DEFAULT_WIDTH = { runway: 45, taxiway: 23, taxilane: 12 } as const;
/** Heights for extruding buildings that carry neither a height nor a level count, in metres. */
const DEFAULT_HEIGHT: Record<string, number> = { building: 7, hangar: 10, terminal: 13, tower: 28 };
const LEVEL_HEIGHT_M = 3.4;

function midpoint(line: LonLat[]): LonLat {
  return line[Math.floor(line.length / 2)] as LonLat;
}

function lengthM(line: LonLat[]): number {
  let total = 0;
  for (let i = 1; i < line.length; i += 1) {
    const [aLon, aLat] = line[i - 1] as LonLat;
    const [bLon, bLat] = line[i] as LonLat;
    total += Math.hypot((bLat - aLat) * 111_320, (bLon - aLon) * 111_320 * Math.cos((aLat * Math.PI) / 180));
  }
  return total;
}

/**
 * The schematic airport: OpenStreetMap layout draped on the ground in a dark palette.
 *
 * Runways and taxiways are mapped in OSM as centrelines, so they are drawn as corridors of the mapped (or a
 * typical) width. Everything lies on the surface, whether that is terrain or the flat plane, except the
 * buildings, which are extruded. Shown in Schematic mode only: OSM-derived layers are not drawn over
 * Google's imagery.
 */
export class LayoutLayer {
  private readonly source = new CustomDataSource('layout');

  constructor(
    private readonly viewer: Viewer,
    private readonly flat: () => boolean,
  ) {
    // Added before the aircraft, so the layout is drawn underneath them.
    void viewer.dataSources.add(this.source);
  }

  set show(value: boolean) {
    this.source.show = value;
  }

  get show(): boolean {
    return this.source.show;
  }

  /** Rebuilds everything from the airport data. */
  load(airport: AirportDetail): void {
    const entities = this.source.entities;
    entities.suspendEvents();
    entities.removeAll();
    const features = airport.layout?.features ?? [];
    const kinds = (kind: string) => features.filter((f) => f.properties.kind === kind);

    for (const f of kinds('aerodrome')) this.area(f, SCHEMATIC.aerodrome, 0);
    for (const f of kinds('apron')) this.area(f, SCHEMATIC.apron, 1);

    for (const kind of ['taxilane', 'taxiway'] as const) {
      for (const f of kinds(kind)) {
        if (f.geometry.type === 'LineString') {
          const width = typeof f.properties.widthM === 'number' ? f.properties.widthM : DEFAULT_WIDTH[kind];
          this.corridor(f.geometry.coordinates, width, SCHEMATIC.taxiway, 2);
          this.line(f.geometry.coordinates, SCHEMATIC.taxiwayLine, 1.2, 4, 0.55);
        } else {
          this.area(f, SCHEMATIC.taxiway, 2);
        }
      }
    }

    // Runways: from OSM when it has them, otherwise from the runway table (always available).
    const osmRunways = kinds('runway');
    if (osmRunways.length > 0) {
      for (const f of osmRunways) {
        if (f.geometry.type === 'LineString') {
          const table = airport.runways.find(
            (r) => r.id === f.properties.ref || r.id.split('/').reverse().join('/') === f.properties.ref,
          );
          const width =
            typeof f.properties.widthM === 'number'
              ? f.properties.widthM
              : table && table.widthFt > 0
                ? table.widthFt * M_PER_FT
                : DEFAULT_WIDTH.runway;
          this.corridor(f.geometry.coordinates, width, SCHEMATIC.runway, 3);
          this.dashed(f.geometry.coordinates);
        } else {
          this.area(f, SCHEMATIC.runway, 3);
        }
      }
    } else {
      for (const runway of airport.runways) {
        if (runway.closed) continue;
        const line: LonLat[] = runway.ends.map((e) => [e.lon, e.lat]);
        this.corridor(
          line,
          runway.widthFt > 0 ? runway.widthFt * M_PER_FT : DEFAULT_WIDTH.runway,
          SCHEMATIC.runway,
          3,
        );
        this.dashed(line);
      }
    }

    // Runway designators at each end, from the runway table.
    for (const runway of airport.runways) {
      if (runway.closed) continue;
      for (const end of runway.ends)
        this.label([end.lon, end.lat], end.ident, 15, SCHEMATIC.runwayLine, 40_000);
    }

    // Taxiway letters: one per mapped way that is long enough to be worth naming.
    const named = new Map<string, { at: LonLat; length: number }[]>();
    for (const f of [...kinds('taxiway'), ...kinds('taxilane')]) {
      const ref = f.properties.ref;
      if (typeof ref !== 'string' || f.geometry.type !== 'LineString') continue;
      const length = lengthM(f.geometry.coordinates);
      if (length < 60) continue;
      const list = named.get(ref) ?? [];
      list.push({ at: midpoint(f.geometry.coordinates), length });
      named.set(ref, list);
    }
    for (const [ref, list] of named) {
      // The longest stretches carry the name; short connectors would only add clutter.
      for (const item of list.sort((a, b) => b.length - a.length).slice(0, 4)) {
        this.label(item.at, ref, 11, SCHEMATIC.taxiwayLine, 6000);
      }
    }

    for (const f of kinds('holding_position')) {
      if (f.geometry.type === 'Point') this.point(f.geometry.coordinates, SCHEMATIC.holdLine, 5, 9000);
      else if (f.geometry.type === 'LineString')
        this.line(f.geometry.coordinates, SCHEMATIC.holdLine, 2.5, 5, 0.95);
    }
    for (const kind of ['parking_position', 'gate']) {
      for (const f of kinds(kind)) {
        if (f.geometry.type === 'Point') {
          this.point(f.geometry.coordinates, SCHEMATIC.label, 3, 5000);
          if (typeof f.properties.ref === 'string')
            this.label(f.geometry.coordinates, f.properties.ref, 10, SCHEMATIC.label, 2500);
        } else if (f.geometry.type === 'LineString') {
          this.line(f.geometry.coordinates, SCHEMATIC.label, 1, 4, 0.5);
        }
      }
    }

    for (const kind of ['building', 'hangar', 'terminal', 'tower']) {
      for (const f of kinds(kind)) this.building(f, kind);
    }
    for (const f of [...kinds('helipad')]) this.area(f, SCHEMATIC.apron, 2);

    entities.resumeEvents();
  }

  destroy(): void {
    this.viewer.dataSources.remove(this.source, true);
  }

  private rings(f: LayoutFeature): LonLat[][][] {
    if (f.geometry.type === 'Polygon') return [f.geometry.coordinates];
    if (f.geometry.type === 'MultiPolygon') return f.geometry.coordinates;
    return [];
  }

  private area(f: LayoutFeature, css: string, zIndex: number): void {
    for (const polygon of this.rings(f)) {
      const [outer, ...holes] = polygon;
      if (!outer || outer.length < 4) continue;
      this.source.entities.add({
        polygon: {
          hierarchy: new PolygonHierarchy(
            positions(outer),
            holes.map((h) => new PolygonHierarchy(positions(h))),
          ),
          material: color(css),
          classificationType: ClassificationType.TERRAIN,
          zIndex,
        },
      });
    }
  }

  private corridor(line: LonLat[], widthM: number, css: string, zIndex: number): void {
    if (line.length < 2) return;
    this.source.entities.add({
      corridor: {
        positions: positions(line),
        width: widthM,
        material: color(css),
        cornerType: CornerType.MITERED,
        classificationType: ClassificationType.TERRAIN,
        zIndex,
      },
    });
  }

  private line(line: LonLat[], css: string, width: number, zIndex: number, alpha: number): void {
    if (line.length < 2) return;
    this.source.entities.add({
      polyline: {
        positions: positions(line),
        width,
        material: color(css, alpha),
        clampToGround: true,
        classificationType: ClassificationType.TERRAIN,
        zIndex,
      },
    });
  }

  private dashed(line: LonLat[]): void {
    if (line.length < 2) return;
    this.source.entities.add({
      polyline: {
        positions: positions(line),
        width: 2,
        material: new PolylineDashMaterialProperty({
          color: color(SCHEMATIC.runwayLine, 0.9),
          dashLength: 28,
        }),
        clampToGround: true,
        classificationType: ClassificationType.TERRAIN,
        zIndex: 5,
      },
    });
  }

  private point(at: LonLat, css: string, pixelSize: number, visibleWithinM: number): void {
    this.source.entities.add({
      position: Cartesian3.fromDegrees(at[0], at[1], 0),
      point: {
        pixelSize,
        color: color(css),
        heightReference: this.flat() ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new DistanceDisplayCondition(0, visibleWithinM),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private label(at: LonLat, text: string, sizePx: number, css: string, visibleWithinM: number): void {
    this.source.entities.add({
      position: Cartesian3.fromDegrees(at[0], at[1], 0),
      label: {
        text,
        font: `600 ${sizePx}px "JetBrains Mono", "Cascadia Mono", Consolas, monospace`,
        fillColor: color(css),
        outlineColor: color(SCHEMATIC.ground),
        outlineWidth: 3,
        style: LabelStyle.FILL_AND_OUTLINE,
        horizontalOrigin: HorizontalOrigin.CENTER,
        verticalOrigin: VerticalOrigin.CENTER,
        pixelOffset: new Cartesian2(0, 0),
        heightReference: this.flat() ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND,
        distanceDisplayCondition: new DistanceDisplayCondition(0, visibleWithinM),
        scaleByDistance: new NearFarScalar(500, 1.1, visibleWithinM, 0.7),
        disableDepthTestDistance: Number.POSITIVE_INFINITY,
      },
    });
  }

  private building(f: LayoutFeature, kind: string): void {
    const mapped = typeof f.properties.heightM === 'number' ? f.properties.heightM : null;
    const levels = typeof f.properties.levels === 'number' ? f.properties.levels * LEVEL_HEIGHT_M : null;
    const height = mapped ?? levels ?? DEFAULT_HEIGHT[kind] ?? DEFAULT_HEIGHT.building ?? 7;
    const css =
      kind === 'tower'
        ? SCHEMATIC.tower
        : kind === 'terminal'
          ? SCHEMATIC.terminal
          : kind === 'hangar'
            ? SCHEMATIC.hangar
            : SCHEMATIC.building;

    if (f.geometry.type === 'Point') {
      // A tower mapped as a single point: stand a slim column there.
      if (kind !== 'tower') return;
      const [lon, lat] = f.geometry.coordinates;
      this.source.entities.add({
        position: Cartesian3.fromDegrees(lon, lat, 0),
        cylinder: {
          length: height,
          topRadius: 4,
          bottomRadius: 3,
          material: color(css, 0.85),
          heightReference: this.flat() ? HeightReference.NONE : HeightReference.RELATIVE_TO_GROUND,
        },
      });
      return;
    }
    const flat = this.flat();
    for (const polygon of this.rings(f)) {
      const [outer, ...holes] = polygon;
      if (!outer || outer.length < 4) continue;
      this.source.entities.add({
        polygon: {
          hierarchy: new PolygonHierarchy(
            positions(outer),
            holes.map((h) => new PolygonHierarchy(positions(h))),
          ),
          material: color(css, kind === 'tower' ? 0.9 : 1),
          height: 0,
          extrudedHeight: height,
          // On terrain the footprint sits on the ground and the walls rise from there.
          heightReference: flat ? HeightReference.NONE : HeightReference.CLAMP_TO_GROUND,
          extrudedHeightReference: flat ? HeightReference.NONE : HeightReference.RELATIVE_TO_GROUND,
          outline: true,
          outlineColor: color(kind === 'tower' ? SCHEMATIC.tower : SCHEMATIC.buildingEdge),
        },
      });
    }
  }
}
