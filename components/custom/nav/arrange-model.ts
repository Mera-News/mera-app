// The Arrange overlay's draft, as pure functions. Nothing is written until ✓:
// the draft holds the new order, the removed pages and the added countries,
// and ✕ (or Android Back) simply drops it.

import { countryPageId, type PageId } from './page-registry';
import type { ArrangeCountryOption, ArrangeDraft } from './types';

export interface ArrangeState {
  /** Current order, existing pages and added countries together. */
  readonly order: readonly PageId[];
  readonly removed: readonly PageId[];
  readonly added: readonly ArrangeCountryOption[];
}

export function initialArrange(order: readonly PageId[]): ArrangeState {
  return { order: [...order], removed: [], added: [] };
}

/** Move the item at `from` to position `to` (both in the current order). */
export function moveItem<T>(list: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || from >= list.length) return [...list];
  const out = [...list];
  const [item] = out.splice(from, 1);
  out.splice(Math.max(0, Math.min(to, out.length)), 0, item);
  return out;
}

export function reorder(state: ArrangeState, from: number, to: number): ArrangeState {
  return { ...state, order: moveItem(state.order, from, to) };
}

export function removePage(state: ArrangeState, id: PageId): ArrangeState {
  const added = state.added.filter((c) => countryPageId(c.alpha2) !== id);
  const wasAdded = added.length !== state.added.length;
  return {
    order: state.order.filter((p) => p !== id),
    // A country added in this draft and removed again was never there.
    removed: wasAdded || state.removed.includes(id) ? state.removed : [...state.removed, id],
    added,
  };
}

export function addCountry(state: ArrangeState, option: ArrangeCountryOption): ArrangeState {
  const id = countryPageId(option.alpha2);
  if (state.order.includes(id)) return state;
  return {
    order: [...state.order, id],
    // Re-adding a country removed in this draft cancels the removal.
    removed: state.removed.filter((p) => p !== id),
    added: state.removed.includes(id) ? state.added : [...state.added, option],
  };
}

export function toDraft(state: ArrangeState): ArrangeDraft {
  return {
    order: state.order,
    removed: state.removed,
    added: state.added.map((c) => c.alpha2.toUpperCase()),
  };
}

/** The search's matches, without anything already in the draft. */
export function filterAddable(
  options: readonly ArrangeCountryOption[],
  state: ArrangeState,
): ArrangeCountryOption[] {
  const taken = new Set(state.order);
  return options.filter((o) => !taken.has(countryPageId(o.alpha2)));
}

export interface PillRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

/**
 * Where a pill dropped at (x, y) goes, over a WRAPPED row of measured pills:
 * the pill whose centre is nearest, before it when the point is in its
 * leading half and after it otherwise. RTL mirrors the halves.
 */
export function dropIndexFor(rects: readonly (PillRect | undefined)[], x: number, y: number, rtl = false): number {
  let best = -1;
  let bestDist = Infinity;
  rects.forEach((r, i) => {
    if (!r) return;
    const cx = r.x + r.width / 2;
    const cy = r.y + r.height / 2;
    const d = (cx - x) ** 2 + (cy - y) ** 2 * 4;
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  });
  if (best < 0) return 0;
  const r = rects[best]!;
  const leading = rtl ? x > r.x + r.width / 2 : x < r.x + r.width / 2;
  return leading ? best : best + 1;
}

/** `dropIndexFor` gives an insertion slot in the list WITH the dragged pill;
 *  convert it to the target index once that pill is taken out. */
export function slotToIndex(from: number, slot: number): number {
  return slot > from ? slot - 1 : slot;
}
