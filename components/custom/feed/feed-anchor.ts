// The Feed's resume anchor, pure: which row is at the top, and the step that
// brings a row back there. useFeedScreen owns the refs and the list.

export interface AnchorLand {
  /** The id being landed on; null before the first frame. */
  issuedFor: string | null;
  /** The previous frame's offset; null on the first frame. */
  prev: number | null;
  /** Frames spent on this id. */
  frames: number;
}

/** Frames before two equal offsets may count as settled: a scroll command's
 *  offset reaches JS a frame or more later, so an early pair is the OLD place. */
export const ANCHOR_MIN_FRAMES = 3;

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
 * Otherwise the scrollToIndex is issued EVERY frame until two frames report the
 * same offset (after ANCHOR_MIN_FRAMES): a far row fails its first scrollToIndex
 * and the list's onScrollToIndexFailed retries with no header offset, so only a
 * repeat with ours puts the row below the header. A repeat at the target is a no-op.
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
    land.frames = 0;
  }
  land.frames += 1;
  const settled = land.frames > ANCHOR_MIN_FRAMES && land.prev !== null && land.prev === offset;
  land.prev = offset;
  return settled ? { result: 'done', scrollToIndex: null } : { result: 'pending', scrollToIndex: index };
}
