/**
 * Label placement. Every aircraft wants a label next to it; labels must not cover each other or another
 * aircraft. This is plain geometry in screen pixels, so it can be tested without a browser.
 */

export interface LabelRequest {
  id: string;
  /** Where the aircraft is on screen. */
  x: number;
  y: number;
  /** Size of the full label and of the one-line fallback. */
  width: number;
  height: number;
  compactWidth: number;
  compactHeight: number;
  /** Higher goes first: the selected aircraft, then the nearest. */
  priority: number;
  /** The slot this label had last frame. Trying it first stops labels from hopping about. */
  previousSlot?: number;
}

export interface LabelPlacement {
  id: string;
  left: number;
  top: number;
  width: number;
  height: number;
  slot: number;
  compact: boolean;
  /** The aircraft's screen position, for the leader line. */
  anchorX: number;
  anchorY: number;
}

export interface Viewport {
  width: number;
  height: number;
}

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Offsets tried in order: beside the aircraft first, then further out. [x direction, y direction, distance]. */
const SLOTS: [number, number, number][] = [
  [1, -1, 14],
  [1, 1, 14],
  [-1, -1, 14],
  [-1, 1, 14],
  [1, -1, 44],
  [1, 1, 44],
  [-1, -1, 44],
  [-1, 1, 44],
];
/** Clear space kept around every label, and around every aircraft marker. */
const MARGIN = 3;
const MARKER = 7;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;

function rectFor(x: number, y: number, w: number, h: number, slot: number): Rect {
  const [dx, dy, gap] = SLOTS[slot] as [number, number, number];
  const left = dx > 0 ? x + gap : x - gap - w;
  const top = dy > 0 ? y + gap * 0.6 : y - gap * 0.6 - h;
  return { left, top, right: left + w, bottom: top + h };
}

/**
 * Places as many labels as fit. A label that fits nowhere at full size is tried as one line; one that still
 * does not fit is left out (the aircraft keeps its marker). Returns placements keyed by id.
 */
export function placeLabels(
  requests: readonly LabelRequest[],
  viewport: Viewport,
): Map<string, LabelPlacement> {
  const placed = new Map<string, LabelPlacement>();
  const taken: Rect[] = [];
  // Every aircraft's own marker is an obstacle for everyone else's label.
  const markers = requests.map((r) => ({
    id: r.id,
    rect: { left: r.x - MARKER, top: r.y - MARKER, right: r.x + MARKER, bottom: r.y + MARKER },
  }));
  const bounds: Rect = { left: 2, top: 2, right: viewport.width - 2, bottom: viewport.height - 2 };
  const order = [...requests].sort((a, b) => b.priority - a.priority);

  const fits = (rect: Rect, id: string): boolean => {
    if (
      rect.left < bounds.left ||
      rect.top < bounds.top ||
      rect.right > bounds.right ||
      rect.bottom > bounds.bottom
    ) {
      return false;
    }
    const padded = {
      left: rect.left - MARGIN,
      top: rect.top - MARGIN,
      right: rect.right + MARGIN,
      bottom: rect.bottom + MARGIN,
    };
    for (const other of taken) if (overlaps(padded, other)) return false;
    for (const marker of markers) if (marker.id !== id && overlaps(rect, marker.rect)) return false;
    return true;
  };

  for (const request of order) {
    const slots = SLOTS.map((_, i) => i);
    if (request.previousSlot !== undefined && request.previousSlot < SLOTS.length) {
      slots.splice(slots.indexOf(request.previousSlot), 1);
      slots.unshift(request.previousSlot);
    }
    let done = false;
    for (const compact of [false, true]) {
      const w = compact ? request.compactWidth : request.width;
      const h = compact ? request.compactHeight : request.height;
      for (const slot of slots) {
        const rect = rectFor(request.x, request.y, w, h, slot);
        if (!fits(rect, request.id)) continue;
        taken.push(rect);
        placed.set(request.id, {
          id: request.id,
          left: rect.left,
          top: rect.top,
          width: w,
          height: h,
          slot,
          compact,
          anchorX: request.x,
          anchorY: request.y,
        });
        done = true;
        break;
      }
      if (done) break;
    }
  }
  return placed;
}

/** The id of the label (or marker) under a screen point, if any. Labels win over markers. */
export function hitTestLabels(
  placements: Iterable<LabelPlacement>,
  x: number,
  y: number,
  markerRadius = 10,
): string | null {
  let nearest: { id: string; d: number } | null = null;
  for (const p of placements) {
    if (x >= p.left && x <= p.left + p.width && y >= p.top && y <= p.top + p.height) return p.id;
    const d = Math.hypot(x - p.anchorX, y - p.anchorY);
    if (d <= markerRadius && (!nearest || d < nearest.d)) nearest = { id: p.id, d };
  }
  return nearest?.id ?? null;
}
