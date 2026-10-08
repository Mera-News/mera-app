// The header track's label rule (owner): every option shows its icon; every
// label shows when they ALL fit the space the header gives the track, else
// only the selected option's. The track never scrolls. Measured widths in,
// a decision out, so the rule is tested without a renderer.

export interface HeaderTrackMetrics {
  /** An option's padding on each side. */
  readonly pad: number;
  readonly icon: number;
  /** Between icon, label and dot. */
  readonly gap: number;
  /** A dot's room beyond its gap. */
  readonly dot: number;
  /** The track's own padding and border, both sides. */
  readonly chrome: number;
}

/** The header track at 1.1x the board's 14pt (owner): 14pt option padding,
 *  a 15pt icon, 7pt gaps, a 10pt picked dot (less its -2 margin), and the
 *  track's 3pt padding and 1pt border on each side. */
export const HEADER_METRICS: HeaderTrackMetrics = { pad: 14, icon: 15, gap: 7, dot: 8, chrome: 8 };

/** One option's width: icon only (`labelWidth` null), or icon and label. */
export function headerOptionWidth(labelWidth: number | null, hasDot: boolean, m: HeaderTrackMetrics): number {
  let w = 2 * m.pad + m.icon;
  if (labelWidth !== null) w += m.gap + labelWidth;
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
): boolean | null {
  if (available === null || available <= 0) return null;
  let total = m.chrome;
  for (let i = 0; i < labelWidths.length; i++) {
    const w = labelWidths[i];
    if (w === undefined) return null;
    total += headerOptionWidth(w, dots[i] ?? false, m);
  }
  return total <= available;
}

/** All labels when they all fit; otherwise only the selected option's. */
export function headerLabelShown(selected: boolean, allFit: boolean | null): boolean {
  return selected || allFit === true;
}
