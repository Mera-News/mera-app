// Which surface the reader is on, and whether the Arrange overlay is open.
//
// One small store because its readers sit OUTSIDE the tree that knows the
// answer: the Mera button mounts once per tab beside the tab's Stack, the
// jump-to-setting Back handler runs from wherever the jump started, and
// neither is a descendant of the page that is showing.
//
// Written only through `useReportSurface` (pages, pushed tab screens, Search)
// and `setArrangeOpen` (TabPages). A page reports on focus while it is the
// active page and clears on blur if it is still the one reported, so a root
// push (article detail) leaves `surface` null rather than stale.
//
// Nothing here is persisted and nothing records what the reader looks at: it
// is the current value only, for the screen to operate (invariant 9).

import { useFocusEffect } from 'expo-router';
import { useCallback } from 'react';
import { create } from 'zustand';

import type { SurfaceId } from './page-registry';

interface CurrentSurfaceState {
  surface: SurfaceId | null;
  arrangeOpen: boolean;
}

const INITIAL: CurrentSurfaceState = { surface: null, arrangeOpen: false };

export const useCurrentSurfaceStore = create<CurrentSurfaceState>()(() => INITIAL);

function useCurrentSurfaceHook(): SurfaceId | null {
  return useCurrentSurfaceStore((s) => s.surface);
}

/** The surface showing now. `useCurrentSurface.getState()` reads it outside
 *  React (the jump-origin Back records where a jump started). */
export const useCurrentSurface = Object.assign(useCurrentSurfaceHook, {
  getState: (): SurfaceId | null => useCurrentSurfaceStore.getState().surface,
});

/** True while a tab's Arrange overlay is open (the Mera button hides). */
export function useArrangeOpen(): boolean {
  return useCurrentSurfaceStore((s) => s.arrangeOpen);
}

export function setArrangeOpen(open: boolean): void {
  if (useCurrentSurfaceStore.getState().arrangeOpen !== open) {
    useCurrentSurfaceStore.setState({ arrangeOpen: open });
  }
}

/** Set `surface`; a no-op when unchanged. Exported for tests and TabPages. */
export function reportSurface(surface: SurfaceId): void {
  if (useCurrentSurfaceStore.getState().surface !== surface) {
    useCurrentSurfaceStore.setState({ surface });
  }
}

/** Clear `surface`, but only if it is still `surface` (a newer report wins). */
export function clearSurface(surface: SurfaceId): void {
  if (useCurrentSurfaceStore.getState().surface === surface) {
    useCurrentSurfaceStore.setState({ surface: null });
  }
}

/**
 * Report `id` while this screen is focused and `enabled` (a pager page passes
 * its `active`). Clears on blur, or when `enabled` turns false, if still ours.
 */
export function useReportSurface(id: SurfaceId, enabled: boolean = true): void {
  useFocusEffect(
    useCallback(() => {
      if (!enabled) return undefined;
      reportSurface(id);
      return () => clearSurface(id);
    }, [id, enabled]),
  );
}

/** Account switch (wired in clearAllStores by L4). */
export function resetCurrentSurface(): void {
  useCurrentSurfaceStore.setState(INITIAL);
}
