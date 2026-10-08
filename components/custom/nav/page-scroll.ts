// Re-tapping the tab you are on scrolls its VISIBLE page to the top (owner),
// on every page with a scroll view. ONE mechanism: TabPages listens for the
// tab's `tabPress` (the native tab bar emits it on a re-tap too) and sends it
// to the target the visible page registered; a page registers its list with
// `usePageScrollTarget(ref)`, through a context TabPages gives each panel, so
// no page wires a listener of its own.
//
// A screen pushed in the tab's stack: the native bar pops it (popToRoot), and
// this ignores that tap (the tab's root is not focused), so one tap pops and
// the next scrolls. A page that also passes `onRefresh` keeps the old second
// tap: at the top, a re-tap refreshes (decideTabPressAction).

import { createContext, useContext, useEffect, useRef, type RefObject } from 'react';

import type { PageId } from './page-registry';

/** Whatever list the page draws: a FlatList (scrollToOffset) or a ScrollView
 *  (scrollTo). */
export interface ScrollableLike {
  scrollToOffset?: (p: { offset: number; animated?: boolean }) => void;
  scrollTo?: (p: { x?: number; y?: number; animated?: boolean }) => void;
}

export interface PageScrollOptions {
  /** The list's offset: with it, a re-tap at the top can refresh. */
  readonly getOffset?: () => number;
  /** The page's pull-to-refresh (the same function its RefreshControl calls). */
  readonly onRefresh?: () => void;
  readonly isRefreshing?: boolean;
}

export interface PageScrollTarget {
  readonly ref: RefObject<ScrollableLike | null>;
  /** The page's latest options, read at tap time. */
  readonly options: RefObject<PageScrollOptions>;
}

/** A page's register: returns the unregister. */
export type RegisterPageScroll = (target: PageScrollTarget) => () => void;

export const PageScrollContext = createContext<RegisterPageScroll | null>(null);

/** Which registered target a re-tap goes to: the visible page's, and none
 *  while Arrange is open or nothing is registered. */
export function retapTarget<T>(
  targets: ReadonlyMap<PageId, T>,
  activeId: PageId | null,
  arranging: boolean,
): T | null {
  if (arranging || activeId === null) return null;
  return targets.get(activeId) ?? null;
}

/** Scroll a registered list to its top. */
export function scrollListToTop(ref: RefObject<ScrollableLike | null>, animated: boolean): void {
  const list = ref.current;
  if (!list) return;
  if (list.scrollToOffset) list.scrollToOffset({ offset: 0, animated });
  else list.scrollTo?.({ x: 0, y: 0, animated });
}

/** The page's list, for its tab's re-tap. Options are read at tap time. */
export function usePageScrollTarget(ref: RefObject<ScrollableLike | null>, opts: PageScrollOptions = {}): void {
  const register = useContext(PageScrollContext);
  const options = useRef(opts);
  options.current = opts;
  useEffect(() => (register ? register({ ref, options }) : undefined), [register, ref]);
}
