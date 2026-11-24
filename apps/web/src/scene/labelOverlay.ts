import { aircraftLabel } from '@towercab/shared';
import { Cartesian2, Cartesian3, type Scene, SceneTransforms } from 'cesium';
import type { AircraftLayer, DrawnAircraft } from './aircraftLayer';
import { hitTestLabels, type LabelPlacement, type LabelRequest, placeLabels } from './labelLayout';
import { PHASE_COLORS, UI } from './palette';

/**
 * Aircraft labels, drawn on a 2D canvas laid over the 3D view.
 *
 * A canvas of our own (rather than Cesium's labels) is what makes it possible to keep labels from
 * overlapping, draw leader lines, and later lay the same labels over a webcam picture.
 */
export class LabelOverlay {
  readonly canvas: HTMLCanvasElement;
  private readonly context: CanvasRenderingContext2D;
  private placements = new Map<string, LabelPlacement>();
  private readonly slots = new Map<string, number>();
  private readonly textWidths = new Map<string, number>();
  private readonly scratchWindow = new Cartesian2();
  private readonly scratchTop = new Cartesian3();
  private selectedHex: string | null = null;
  private hoverHex: string | null = null;
  private enabled = true;
  private cssWidth = 0;
  private cssHeight = 0;

  constructor(
    private readonly scene: Scene,
    container: HTMLElement,
  ) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'label-overlay';
    this.canvas.setAttribute('aria-hidden', 'true');
    container.appendChild(this.canvas);
    const context = this.canvas.getContext('2d');
    if (!context) throw new Error('2D canvas is not available');
    this.context = context;
  }

  setSelected(hex: string | null): void {
    this.selectedHex = hex;
  }

  setHover(hex: string | null): void {
    this.hoverHex = hex;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) this.clear();
  }

  /** The aircraft whose label or marker is under a point of the view, in CSS pixels. */
  hitTest(x: number, y: number): string | null {
    return hitTestLabels(this.placements.values(), x, y);
  }

  /** Redraws every label for the current camera. Called after each rendered frame. */
  draw(layer: AircraftLayer): void {
    this.resize();
    const ctx = this.context;
    ctx.clearRect(0, 0, this.cssWidth, this.cssHeight);
    if (!this.enabled) return;

    const camera = this.scene.camera.positionWC;
    const requests: LabelRequest[] = [];
    const details = new Map<
      string,
      { aircraft: DrawnAircraft; lines: [string, string]; scale: number; distance: number }
    >();

    for (const aircraft of layer.list()) {
      if (!aircraft.visible) continue;
      // Anchor at the top of the aircraft rather than its wheels.
      Cartesian3.clone(aircraft.position, this.scratchTop);
      const window = SceneTransforms.worldToWindowCoordinates(
        this.scene,
        this.scratchTop,
        this.scratchWindow,
      );
      if (!window) continue;
      if (window.x < -40 || window.y < -40 || window.x > this.cssWidth + 40 || window.y > this.cssHeight + 40)
        continue;

      const distance = Cartesian3.distance(camera, aircraft.position);
      // Text shrinks with distance, within limits that keep it readable.
      const scale = Math.max(0.78, Math.min(1.08, 1.12 - distance / 26_000));
      const lines = labelLines(aircraft);
      const fontPx = 12 * scale;
      const width =
        Math.max(this.measure(lines[0], fontPx, true), this.measure(lines[1], fontPx * 0.92, false)) + 12;
      const selected = aircraft.hex === this.selectedHex;
      details.set(aircraft.hex, { aircraft, lines, scale, distance });
      requests.push({
        id: aircraft.hex,
        x: window.x,
        y: window.y,
        width,
        height: fontPx * 2.3 + 8,
        compactWidth: this.measure(lines[0], fontPx, true) + 12,
        compactHeight: fontPx * 1.2 + 6,
        priority: selected ? 1e9 : aircraft.hex === this.hoverHex ? 1e8 : 1e6 / (1 + distance),
        previousSlot: this.slots.get(aircraft.hex),
      });
    }

    this.placements = placeLabels(requests, { width: this.cssWidth, height: this.cssHeight });
    this.slots.clear();
    for (const [hex, placement] of this.placements) this.slots.set(hex, placement.slot);

    // Markers first, so labels are drawn over them.
    for (const request of requests) {
      const detail = details.get(request.id);
      if (!detail) continue;
      const color = PHASE_COLORS[detail.aircraft.data.phase];
      const selected = request.id === this.selectedHex;
      ctx.globalAlpha = detail.aircraft.alpha;
      ctx.beginPath();
      ctx.arc(request.x, request.y, selected ? 4.5 : 2.5, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      if (selected) {
        ctx.beginPath();
        ctx.arc(request.x, request.y, 9, 0, Math.PI * 2);
        ctx.strokeStyle = UI.accent;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }

    for (const placement of this.placements.values()) {
      const detail = details.get(placement.id);
      if (!detail) continue;
      const { aircraft, lines, scale } = detail;
      const selected = placement.id === this.selectedHex;
      const hovered = placement.id === this.hoverHex;
      const color = PHASE_COLORS[aircraft.data.phase];
      const fontPx = 12 * scale;
      ctx.globalAlpha = aircraft.alpha;

      // Leader line from the aircraft to the nearest corner of its label.
      const cornerX = placement.left > placement.anchorX ? placement.left : placement.left + placement.width;
      const cornerY = placement.top > placement.anchorY ? placement.top : placement.top + placement.height;
      ctx.beginPath();
      ctx.moveTo(placement.anchorX, placement.anchorY);
      ctx.lineTo(cornerX, cornerY);
      ctx.strokeStyle = selected ? UI.accent : color;
      ctx.lineWidth = selected ? 1.75 : 1;
      ctx.globalAlpha = aircraft.alpha * (selected ? 1 : 0.6);
      ctx.stroke();
      ctx.globalAlpha = aircraft.alpha;

      ctx.fillStyle = selected ? 'rgba(8, 28, 40, 0.94)' : UI.panel;
      ctx.strokeStyle = selected ? UI.accent : hovered ? UI.text : UI.panelLine;
      ctx.lineWidth = selected ? 1.5 : 1;
      roundRect(ctx, placement.left, placement.top, placement.width, placement.height, 3);
      ctx.fill();
      ctx.stroke();
      // Phase colour as a bar down the leading edge of the label.
      ctx.fillStyle = color;
      ctx.fillRect(placement.left, placement.top + 1, 2.5, placement.height - 2);

      ctx.textBaseline = 'top';
      ctx.font = font(fontPx, true);
      ctx.fillStyle = UI.text;
      ctx.fillText(lines[0], placement.left + 7, placement.top + 4);
      if (!placement.compact) {
        ctx.font = font(fontPx * 0.92, false);
        ctx.fillStyle = selected ? UI.text : UI.muted;
        ctx.fillText(lines[1], placement.left + 7, placement.top + 4 + fontPx * 1.2);
      }
    }
    ctx.globalAlpha = 1;
  }

  clear(): void {
    this.context.clearRect(0, 0, this.cssWidth, this.cssHeight);
    this.placements.clear();
  }

  destroy(): void {
    this.canvas.remove();
  }

  private measure(text: string, fontPx: number, bold: boolean): number {
    // Widths are cached per text at a reference size; canvas text measurement is not cheap.
    const key = `${bold ? 'b' : 'n'}${text}`;
    let width = this.textWidths.get(key);
    if (width === undefined) {
      this.context.font = font(12, bold);
      width = this.context.measureText(text).width;
      if (this.textWidths.size > 4000) this.textWidths.clear();
      this.textWidths.set(key, width);
    }
    return (width * fontPx) / 12;
  }

  private resize(): void {
    const width = this.canvas.clientWidth;
    const height = this.canvas.clientHeight;
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    if (
      width !== this.cssWidth ||
      height !== this.cssHeight ||
      this.canvas.width !== Math.round(width * ratio)
    ) {
      this.cssWidth = width;
      this.cssHeight = height;
      this.canvas.width = Math.round(width * ratio);
      this.canvas.height = Math.round(height * ratio);
      this.context.setTransform(ratio, 0, 0, ratio, 0, 0);
    }
  }
}

const font = (px: number, bold: boolean): string =>
  `${bold ? 600 : 400} ${px.toFixed(1)}px "JetBrains Mono", "Cascadia Mono", Consolas, "DejaVu Sans Mono", monospace`;

/** Line 1: callsign (or registration) and type. Line 2: altitude and ground speed. */
export function labelLines(aircraft: Pick<DrawnAircraft, 'data'>): [string, string] {
  const a = aircraft.data;
  const type = a.typeCode ? ` ${a.typeCode}` : '';
  const speed = a.gsKt === undefined ? '' : `${Math.round(a.gsKt)}kt`;
  let altitude: string;
  if (a.onGround) altitude = 'GND';
  else if (a.altMslFt === undefined) altitude = '';
  else {
    const arrow =
      a.vertRateFpm === undefined || Math.abs(a.vertRateFpm) < 200 ? '' : a.vertRateFpm > 0 ? '↑' : '↓';
    altitude = `${Math.round(a.altMslFt / 100) * 100}ft${arrow}`;
  }
  return [`${aircraftLabel(a)}${type}`, [altitude, speed].filter(Boolean).join(' ')];
}

function roundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}
