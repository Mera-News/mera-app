// The Feed's resume anchor, pure: which row is at the top, and the step that
// brings a row back there. useFeedScreen owns the refs and the list.

export interface AnchorLand {
  /** The id a scrollToIndex was issued for; null before the first one. */
  issuedFor: string | null;
  /** The previous frame's offset once settling; null until one is read. */
  prev: number | null;
}

export type AnchorStep =
  | { result: 'pending'; scrollToIndex: null }
  | { result: 'pending'; scrollToIndex: number }
  | { result: 'missing'; scrollToIndex: null }
  | { result: 'done'; scrollToIndex: null };

/** The topmost rendered row among those on screen, or null. */
export function firstOnScreenId(order: readonly string[], onScreen: ReadonlySet<string>): string | null {
  let lo = Infinity;
  for (const id of onScreen) {
    const i = order.indexOf(id);
    if (i >= 0 && i < lo) lo = i;
  }
  return lo === Infinity ? null : order[lo];
}

/**
 * One frame of landing on row `id`. Mutates `land`. Not ready (list still
 * warming up): pending. Not in the list: missing (the caller goes to the top).
 * Otherwise one scrollToIndex, then pending until two frames report the same offset.
 */
export function anchorStep(
  ready: boolean,
  order: readonly string[],
  id: string,
  offset: number,
  land: AnchorLand,
): AnchorStep {
  if (!ready) return { result: 'pending', scrollToIndex: null };
  const index = order.indexOf(id);
  if (index < 0) return { result: 'missing', scrollToIndex: null };
  if (land.issuedFor !== id) {
    land.issuedFor = id;
    land.prev = null;
    return { result: 'pending', scrollToIndex: index };
  }
  const settled = land.prev !== null && land.prev === offset;
  land.prev = offset;
  return settled ? { result: 'done', scrollToIndex: null } : { result: 'pending', scrollToIndex: null };
}
