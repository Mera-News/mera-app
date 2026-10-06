import type { FeedStatusMode } from '@/lib/feed-status-mode';

/**
 * The feed's status, as an i18n key, for the screen's announcement of the
 * capped and error states (use-feed-mode-announcement). `deferred` folds onto
 * `idle`: it is a pipeline count the reader cannot act on.
 */
export function a11yStateKey(mode: FeedStatusMode): string {
  // A plain string, read through `tAny`: the key is genuinely COMPUTED from
  // `mode`, so there is no literal for a typed `t()` to check.
  switch (mode) {
    case 'processing':
      return 'feedStatus.modeProcessing';
    case 'error':
      return 'feedStatus.modeError';
    case 'limited':
      return 'feedStatus.modeLimited';
    default:
      return 'feedStatus.idle';
  }
}

function channel(v: number): number {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an sRGB triple. */
export function luminance([r, g, b]: readonly [number, number, number]): number {
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio between two sRGB triples (the section footer's ink test). */
export function contrastRatio(
  a: readonly [number, number, number],
  b: readonly [number, number, number],
): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Parses `#RRGGBB` or `rgb(r, g, b)`; throws on anything else so a test
 *  cannot pass by failing to read a colour. */
export function parseRgb(color: string): [number, number, number] {
  const hex = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(color);
  if (hex) return [parseInt(hex[1], 16), parseInt(hex[2], 16), parseInt(hex[3], 16)];
  const rgb = /^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/.exec(color);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  throw new Error(`unparseable colour: ${color}`);
}
