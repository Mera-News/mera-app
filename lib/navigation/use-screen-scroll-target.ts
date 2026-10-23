// The React side of the resume spot (`resume-spot.ts`): a pushed screen offers
// its scroller for capture and for the restored landing, says whether its
// entity exists, and reads whether its list waits for that landing.
//
// Kept apart from resume-spot.ts so the gate and the restart marker load no
// React Navigation.

import { useRoute } from '@react-navigation/native';
import { useEffect, useRef, useSyncExternalStore } from 'react';

import {
  isRestoreHidden,
  isRestoreInProgress,
  registerScrollTarget,
  reportRestoredScreen,
  subscribeResumeSpot,
  type ResumeScrollTarget,
} from './resume-spot';

/** A FlatList (scrollToOffset) or a ScrollView (scrollTo). */
export interface ScrollableRefLike {
  scrollToOffset?: (p: { offset: number; animated?: boolean }) => void;
  scrollTo?: (p: { x?: number; y?: number; animated?: boolean }) => void;
}

export interface ScreenScrollOptions {
  /** The list's offset now, pt: a ref or a UI-written shared value, never state. */
  readonly getOffset: () => number;
  readonly getAnchor?: ResumeScrollTarget['getAnchor'];
  readonly scrollToAnchor?: ResumeScrollTarget['scrollToAnchor'];
}

/**
 * Register this screen's list. Returns `restoreHidden`: true while a restored
 * scroll is landing on it, so the screen draws the list at opacity 0 until it
 * lands (components/custom/nav RestoreReveal does the fade).
 */
export function useScreenScrollTarget(
  ref: { readonly current: ScrollableRefLike | null },
  opts: ScreenScrollOptions,
): { restoreHidden: boolean } {
  const route = useRoute();
  const latest = useRef(opts);
  latest.current = opts;
  useEffect(() => {
    const target: ResumeScrollTarget = {
      getOffset: () => latest.current.getOffset(),
      scrollTo: (y) => {
        const list = ref.current;
        if (list?.scrollToOffset) list.scrollToOffset({ offset: y, animated: false });
        else list?.scrollTo?.({ x: 0, y, animated: false });
      },
      getAnchor: () => latest.current.getAnchor?.() ?? null,
      scrollToAnchor: latest.current.scrollToAnchor
        ? (id, delta) => latest.current.scrollToAnchor?.(id, delta) ?? 'missing'
        : undefined,
    };
    return registerScrollTarget(route.key, target);
  }, [route.key, ref]);
  return { restoreHidden: useRestoreHidden(route.key) };
}

/** True while `routeKey`'s list waits for its restored scroll. */
export function useRestoreHidden(routeKey: string | null | undefined): boolean {
  return useSyncExternalStore(subscribeResumeSpot, () => isRestoreHidden(routeKey));
}

/** True while a restore rebuilds the stacks (their pushes run with no animation). */
export function useRestoreInProgress(): boolean {
  return useSyncExternalStore(subscribeResumeSpot, isRestoreInProgress);
}

/**
 * An article or publication screen: report 'ready' once its entity loaded,
 * 'missing' when it is gone (never for a network error). 'loading' reports
 * nothing. Only a restored screen acts on it.
 */
export function useReportRestoredScreen(status: 'loading' | 'ready' | 'missing'): void {
  const route = useRoute();
  useEffect(() => {
    if (status !== 'loading') reportRestoredScreen(route.key, status);
  }, [route.key, status]);
}
