import type { PublicCamera } from '@towercab/shared';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CameraPlayer } from './players';

export type CameraLayout = 'pip' | 'split' | 'grid' | 'overlay';
export const CAMERA_LAYOUTS: readonly CameraLayout[] = ['pip', 'split', 'grid', 'overlay'];

interface Props {
  cameras: PublicCamera[];
  /** The camera on show. In the grid, the one that was last on show. */
  activeId: string | null;
  layout: CameraLayout;
  /** The 3D view is looking through the active camera. */
  matched: boolean;
  /** Where the picture goes in overlay mode: the 3D view's own element, between the scene and its labels. */
  overlayHost: HTMLElement | null;
  onSelect(id: string): void;
  onLayout(layout: CameraLayout): void;
  onMatch(): void;
  /** The shape of the active camera's picture, for lining the 3D view up with it. */
  onAspect(aspect: number): void;
  onClose(): void;
}

const PIP_KEY = 'towercab.pip';
interface PipBox {
  left: number;
  top: number;
  width: number;
  height: number;
}
const DEFAULT_PIP: PipBox = { left: 16, top: 56, width: 440, height: 300 };

function loadPip(): PipBox {
  try {
    const saved = JSON.parse(localStorage.getItem(PIP_KEY) ?? 'null') as Partial<PipBox> | null;
    if (saved && [saved.left, saved.top, saved.width, saved.height].every((n) => typeof n === 'number')) {
      return saved as PipBox;
    }
  } catch {
    // No storage, or something else's data: use the default.
  }
  return DEFAULT_PIP;
}

function savePip(box: PipBox): void {
  try {
    localStorage.setItem(PIP_KEY, JSON.stringify(box));
  } catch {
    // Remembering the window's place is a convenience only.
  }
}

/** Credit and link for a camera: who runs it, and where to see it at the source. */
function Credit({ camera }: { camera: PublicCamera }) {
  if (!camera.attribution && !camera.link) return null;
  return (
    <footer className="camera-credit">
      {camera.link ? (
        <a href={camera.link} target="_blank" rel="noreferrer noopener">
          {camera.attribution ?? 'Source'}
        </a>
      ) : (
        camera.attribution
      )}
    </footer>
  );
}

function LayoutButtons({
  layout,
  canOverlay,
  onLayout,
}: Pick<Props, 'layout' | 'onLayout'> & { canOverlay: boolean }) {
  const options: { id: CameraLayout; label: string; title: string }[] = [
    { id: 'pip', label: 'Window', title: 'A window over the 3D view that you can move and resize' },
    { id: 'split', label: 'Split', title: 'The 3D view and the camera side by side' },
    { id: 'grid', label: 'Grid', title: 'Every camera at this airport' },
  ];
  if (canOverlay) {
    options.push({ id: 'overlay', label: 'Overlay', title: 'The 3D labels drawn over the camera picture' });
  }
  return (
    <fieldset className="segmented small" aria-label="Camera layout">
      {options.map((o) => (
        <button
          key={o.id}
          type="button"
          className={layout === o.id ? 'on' : ''}
          aria-pressed={layout === o.id}
          title={o.title}
          onClick={() => onLayout(o.id)}
          data-testid={`camera-layout-${o.id}`}
        >
          {o.label}
        </button>
      ))}
    </fieldset>
  );
}

/** Cameras next to, over, or instead of the 3D view. */
export function CameraDock(props: Props) {
  const { cameras, layout, matched, overlayHost } = props;
  const active = cameras.find((c) => c.id === props.activeId) ?? cameras[0];
  const [opacity, setOpacity] = useState(0.75);
  const [pip, setPip] = useState<PipBox>(loadPip);
  const pipRef = useRef<HTMLElement>(null);
  const drag = useRef<{ x: number; y: number; left: number; top: number } | null>(null);

  // Keep the window's size when the viewer resizes it by its corner.
  useEffect(() => {
    const element = pipRef.current;
    if (!element || layout !== 'pip') return;
    const observer = new ResizeObserver(() => {
      const { offsetWidth: width, offsetHeight: height } = element;
      if (width === 0 || height === 0) return;
      setPip((box) => {
        if (box.width === width && box.height === height) return box;
        const next = { ...box, width, height };
        savePip(next);
        return next;
      });
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [layout]);

  if (!active) return null;
  const canOverlay = Boolean(active.pose);

  const controls = (
    <header
      className="camera-bar"
      onPointerDown={(event) => {
        // The bar is the window's handle, except where it holds a control.
        if (layout !== 'pip' || (event.target as HTMLElement).closest('button, select, input, a')) return;
        drag.current = { x: event.clientX, y: event.clientY, left: pip.left, top: pip.top };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        const start = drag.current;
        const stage = pipRef.current?.parentElement;
        if (!start || !stage) return;
        // Stay inside the 3D view, with the bar always within reach.
        const left = Math.min(Math.max(0, start.left + event.clientX - start.x), stage.clientWidth - 80);
        const top = Math.min(Math.max(0, start.top + event.clientY - start.y), stage.clientHeight - 32);
        setPip((box) => ({ ...box, left, top }));
      }}
      onPointerUp={() => {
        if (drag.current) savePip(pip);
        drag.current = null;
      }}
    >
      {layout === 'pip' && (
        <span className="camera-grip" aria-hidden="true" title="Drag to move" data-testid="camera-grip">
          ⠿
        </span>
      )}
      {cameras.length > 1 && layout !== 'grid' ? (
        <label className="field">
          <span className="visually-hidden">Camera</span>
          <select
            value={active.id}
            onChange={(e) => props.onSelect(e.target.value)}
            data-testid="camera-select"
          >
            {cameras.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <strong className="camera-name">
          {layout === 'grid' ? `${cameras.length} cameras` : active.name}
        </strong>
      )}
      <LayoutButtons layout={layout} canOverlay={canOverlay} onLayout={props.onLayout} />
      {canOverlay && layout !== 'grid' && layout !== 'overlay' && (
        <button
          type="button"
          className={matched ? 'on' : ''}
          aria-pressed={matched}
          title="Put the 3D view where this camera is, looking the same way"
          onClick={props.onMatch}
          data-testid="camera-match"
        >
          Match view
        </button>
      )}
      {layout === 'overlay' && (
        <label className="camera-opacity" title="How much of the camera picture shows over the 3D view">
          <span>Picture</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={opacity}
            onChange={(e) => setOpacity(Number(e.target.value))}
            data-testid="camera-opacity"
          />
        </label>
      )}
      <span className="spacer" />
      <button
        type="button"
        className="icon"
        onClick={props.onClose}
        aria-label="Close cameras"
        title="Close (C)"
      >
        ×
      </button>
    </header>
  );

  if (layout === 'grid') {
    return (
      <section className="camera-grid-view" data-testid="camera-dock" data-layout="grid" aria-label="Cameras">
        {controls}
        <div className="camera-grid">
          {cameras.map((camera) => (
            <article key={camera.id} className="camera-tile">
              <header>
                <strong>{camera.name}</strong>
                <button
                  type="button"
                  onClick={() => {
                    props.onSelect(camera.id);
                    props.onLayout('split');
                  }}
                >
                  Open
                </button>
              </header>
              <div className="camera-body">
                <CameraPlayer camera={camera} />
              </div>
              <Credit camera={camera} />
            </article>
          ))}
        </div>
      </section>
    );
  }

  if (layout === 'overlay') {
    return (
      <>
        {overlayHost &&
          createPortal(
            <div className="camera-overlay" style={{ opacity }} data-testid="camera-overlay">
              <CameraPlayer key={active.id} camera={active} onAspect={props.onAspect} />
            </div>,
            overlayHost,
          )}
        <section
          className="camera-overlay-bar"
          data-testid="camera-dock"
          data-layout="overlay"
          aria-label="Cameras"
        >
          {controls}
          <Credit camera={active} />
        </section>
      </>
    );
  }

  return (
    <section
      ref={pipRef}
      className={layout === 'pip' ? 'camera-pip' : 'camera-split'}
      style={
        layout === 'pip' ? { left: pip.left, top: pip.top, width: pip.width, height: pip.height } : undefined
      }
      data-testid="camera-dock"
      data-layout={layout}
      aria-label="Cameras"
    >
      {controls}
      <div className="camera-body">
        <CameraPlayer key={active.id} camera={active} onAspect={props.onAspect} />
      </div>
      <Credit camera={active} />
    </section>
  );
}
