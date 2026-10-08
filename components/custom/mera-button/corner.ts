// Where the Mera button sits: one of four PHYSICAL corners (RTL leaves
// top-left at top-left), shared by every tab and page, chosen by dragging it
// and kept on this phone only.
//
// Pure geometry first (worklet-safe, so the drag's end can pick a corner on the
// UI thread), then the store. The setting is local, never in a backup, and
// records nothing about reading: it is where the reader parked a button.

import { create } from 'zustand';

export type MeraCorner = 'tl' | 'tr' | 'bl' | 'br';

export const MERA_CORNERS: readonly MeraCorner[] = ['tl', 'tr', 'bl', 'br'];
export const DEFAULT_CORNER: MeraCorner = 'br';
export const MERA_BUTTON_CORNER_KEY = 'mera_button_corner';
/** Pan activation distance: a press or a small wobble stays a tap. */
export const DRAG_ACTIVATION = 8;

/** The quadrant a drop point falls in. A drop exactly on a midline goes right
 *  and bottom (today's spot). Out-of-bounds points clamp by construction. */
export function nearestCorner(cx: number, cy: number, width: number, height: number): MeraCorner {
  'worklet';
  const right = cx >= width / 2;
  const bottom = cy >= height / 2;
  if (bottom) return right ? 'br' : 'bl';
  return right ? 'tr' : 'tl';
}

export interface CornerFrame {
  /** The overlay's size: the tab's content area. */
  readonly width: number;
  readonly height: number;
  /** y of the top corners' top edge (below the page header). */
  readonly top: number;
  /** Distance from the overlay's bottom to the button's bottom edge. */
  readonly bottom: number;
  /** Distance from the left or right edge. */
  readonly inset: number;
  readonly size: number;
}

/** The top-left point of the button in `corner`, in overlay coordinates. */
export function cornerPoint(corner: MeraCorner, f: CornerFrame): { x: number; y: number } {
  'worklet';
  const left = corner === 'tl' || corner === 'bl';
  const top = corner === 'tl' || corner === 'tr';
  return {
    x: left ? f.inset : f.width - f.inset - f.size,
    y: top ? f.top : f.height - f.bottom - f.size,
  };
}

/**
 * A dragged button's top-left point, kept inside the box the four corners
 * span: below the page header, above the tab bar (or the home indicator off
 * the tabs), the side insets as at rest. It never rides over either bar.
 */
export function clampToFrame(x: number, y: number, f: CornerFrame): { x: number; y: number } {
  'worklet';
  const minY = f.top;
  const maxY = Math.max(minY, f.height - f.bottom - f.size);
  const maxX = Math.max(f.inset, f.width - f.inset - f.size);
  return { x: Math.min(maxX, Math.max(f.inset, x)), y: Math.min(maxY, Math.max(minY, y)) };
}

/** The tooltip sits on the side of the button facing the screen's middle. */
export function tooltipSide(corner: MeraCorner): 'left' | 'right' {
  return corner === 'tl' || corner === 'bl' ? 'right' : 'left';
}

function isCorner(v: unknown): v is MeraCorner {
  return typeof v === 'string' && (MERA_CORNERS as readonly string[]).includes(v);
}

function settings(): typeof import('@/lib/database/services/setting-service') {
  // LAZY: setting-service builds a WatermelonDB collection at module scope.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('@/lib/database/services/setting-service');
}

interface CornerState {
  corner: MeraCorner;
  hydrated: boolean;
}

export const useMeraCornerStore = create<CornerState>()(() => ({
  corner: DEFAULT_CORNER,
  hydrated: false,
}));

export function useMeraCorner(): MeraCorner {
  return useMeraCornerStore((s) => s.corner);
}

let hydrating: Promise<void> | null = null;

/** Reads the stored corner once per JS context. Idempotent; never rejects (a
 *  failed read keeps the default). */
export function hydrateMeraButtonCorner(): Promise<void> {
  if (!hydrating) {
    hydrating = (async () => {
      let corner = DEFAULT_CORNER;
      try {
        const raw = await settings().getSetting(MERA_BUTTON_CORNER_KEY);
        if (isCorner(raw)) corner = raw;
      } catch {
        // The default is a correct answer.
      }
      useMeraCornerStore.setState({ corner, hydrated: true });
    })();
  }
  return hydrating;
}

/** Moves the button and remembers it. The store updates at once; the write
 *  is best-effort. */
export function setMeraCorner(corner: MeraCorner): void {
  if (useMeraCornerStore.getState().corner !== corner) useMeraCornerStore.setState({ corner });
  void Promise.resolve()
    .then(() => settings().setSetting(MERA_BUTTON_CORNER_KEY, corner))
    .catch(() => undefined);
}

/** Account switch: the settings table is wiped, so the default comes back. */
export function resetMeraButtonCorner(): void {
  hydrating = null;
  useMeraCornerStore.setState({ corner: DEFAULT_CORNER, hydrated: false });
}
