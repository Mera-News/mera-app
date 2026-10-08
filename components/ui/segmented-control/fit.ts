// The header track's label rule (owner), measured widths in, a mode out, so
// it is tested without a renderer. The track never scrolls.
//  - `names`: names only, no icons (Library, You: when every NAME fits).
//  - `full`: icon and name on every option (Feed: when they all fit).
//  - `compact`: icons, and only the selected option's name. What any track
//    falls back to: long locales, large text sizes.

export interface HeaderTrackMetrics {
  /** An option's padding on each side. */
  readonly pad: number;
  /** An option's padding on each side in `names` mode (no icon). */
  readonly namesPad: number;
  readonly icon: number;
  /** Between icon, label and dot. */
  readonly gap: number;
  /** A dot's room beyond its gap. */
  readonly dot: number;
  /** The track's own padding and border, both sides. */
  readonly chrome: number;
}

/** The header track at 1.1x the board's 14pt (owner): 14pt option padding
 *  (10 for a name alone, so Library's four names fit a 375pt phone),
 *  a 15pt icon, 7pt gaps, a 10pt picked dot (less its -2 margin), and the
 *  track's 3pt padding and 1pt border on each side. */
export const HEADER_METRICS: HeaderTrackMetrics = { pad: 14, namesPad: 10, icon: 15, gap: 7, dot: 8, chrome: 8 };

/** One option's width: icon only (`labelWidth` null), or icon and label;
 *  `icon` false: the name alone. */
export function headerOptionWidth(
  labelWidth: number | null,
  hasDot: boolean,
  m: HeaderTrackMetrics,
  icon: boolean = true,
): number {
  let w = 2 * (icon ? m.pad : m.namesPad) + (icon ? m.icon : 0);
  if (labelWidth !== null) w += (icon ? m.gap : 0) + labelWidth;
  if (hasDot) w += m.gap + m.dot;
  return w;
}

/**
 * Whether every option fits with its label. Null until every label and the
 * available width are measured (callers show the compact track meanwhile).
 */
export function allHeaderLabelsFit(
  labelWidths: readonly (number | undefined)[],
  dots: readonly boolean[],
  available: number | null,
  m: HeaderTrackMetrics,
  icons: boolean = true,
): boolean | null {
  if (available === null || available <= 0) return null;
  let total = m.chrome;
  for (let i = 0; i < labelWidths.length; i++) {
    const w = labelWidths[i];
    if (w === undefined) return null;
    total += headerOptionWidth(w, dots[i] ?? false, m, icons);
  }
  return total <= available;
}

export type HeaderTrackMode = 'names' | 'full' | 'compact';

/**
 * The track's mode. `namesFirst` (Library, You): names alone when they all
 * fit, else compact. Otherwise (Feed): icons and names when they all fit,
 * else compact. Compact until everything is measured.
 */
export function headerTrackMode(
  labelWidths: readonly (number | undefined)[],
  dots: readonly boolean[],
  available: number | null,
  m: HeaderTrackMetrics,
  namesFirst: boolean,
): HeaderTrackMode {
  const fits = allHeaderLabelsFit(labelWidths, dots, available, m, !namesFirst);
  if (fits !== true) return 'compact';
  return namesFirst ? 'names' : 'full';
}

/** Whether an option shows its name, and its icon, in `mode`. */
export function headerOptionParts(selected: boolean, mode: HeaderTrackMode): { label: boolean; icon: boolean } {
  return { label: selected || mode !== 'compact', icon: mode !== 'names' };
}
