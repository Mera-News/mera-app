// Which surface the reader is on, whether the Arrange overlay is open, and
// which tabs show their "something new" dot in the tab bar.
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

import type { AskMeraSubject } from '@/components/custom/floating-chat/ask-mera';

import type { SurfaceId, TabId } from './page-registry';

interface HeaderBottom {
  /** Who reported it (`tab:<tab>`, `interest:<factId>`, ...); only they clear it. */
  readonly owner: string;
  /** The top chrome's lowest point, window coordinates, pt. */
  readonly y: number;
}

interface CurrentSurfaceState {
  surface: SurfaceId | null;
  arrangeOpen: boolean;
  headerBottom: HeaderBottom | null;
  /** A tab's dot: new content there (Feed: articles arrived while away; You:
   *  unread notices). Set by each tab's owner, drawn by the tab layout. */
  tabDots: Readonly<Record<TabId, boolean>>;
  /** The article an `article` surface is about (the Mera button opens on it). */
  article: AskMeraSubject | null;
}

const INITIAL: CurrentSurfaceState = {
  surface: null,
  arrangeOpen: false,
  headerBottom: null,
  tabDots: { feed: false, world: false, library: false, you: false },
  article: null,
};

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

export function useTabDot(tab: TabId): boolean {
  return useCurrentSurfaceStore((s) => s.tabDots[tab]);
}

export function setTabDot(tab: TabId, on: boolean): void {
  const dots = useCurrentSurfaceStore.getState().tabDots;
  if (dots[tab] !== on) useCurrentSurfaceStore.setState({ tabDots: { ...dots, [tab]: on } });
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

/**
 * An article page: reports the `article` surface and its subject while
 * focused, and clears both on blur if still its own (a nested article page
 * reports over its parent and the parent's report returns on Back).
 */
export function useReportArticleSurface(subject: AskMeraSubject | undefined): void {
  useFocusEffect(
    useCallback(() => {
      const article = subject ?? null;
      useCurrentSurfaceStore.setState({ surface: 'article', article });
      // Owner-only clear, like clearSurface: on Back the tab may report its
      // own surface before this blur runs, and that report must survive.
      return () => {
        const now = useCurrentSurfaceStore.getState();
        if (now.surface === 'article' && now.article === article) {
          useCurrentSurfaceStore.setState({ surface: null, article: null });
        }
      };
    }, [subject]),
  );
}

export function useArticleSubject(): AskMeraSubject | null {
  return useCurrentSurfaceStore((s) => s.article);
}

/**
 * Where the showing screen's top chrome ends, in window coordinates (pt), so
 * something mounted OUTSIDE that screen (the Mera button in its top corners)
 * can sit below it. Null when the showing screen reports none: callers fall
 * back to their own estimate. A collapsing header reports its EXPANDED bottom
 * at all times, so a reader never moves during a scroll (owner).
 */
export function useHeaderBottom(): number | null {
  return useCurrentSurfaceStore((s) => s.headerBottom?.y ?? null);
}

export function reportHeaderBottom(owner: string, y: number): void {
  const prev = useCurrentSurfaceStore.getState().headerBottom;
  const next = Math.round(y);
  if (prev && prev.owner === owner && prev.y === next) return;
  useCurrentSurfaceStore.setState({ headerBottom: { owner, y: next } });
}

/** A header drawn at the top of a view whose window y is `rootY`: its
 *  bottom edge in window points. `headerHeight` includes the status bar
 *  inset when the header pads for it (TabPages). */
export function headerBottomInWindow(rootY: number, headerHeight: number): number {
  return rootY + headerHeight;
}

/** Clear the header bottom, but only if `owner` still holds it. */
export function clearHeaderBottom(owner: string): void {
  if (useCurrentSurfaceStore.getState().headerBottom?.owner === owner) {
    useCurrentSurfaceStore.setState({ headerBottom: null });
  }
}

/** Account switch (wired in clearAllStores by L4). */
export function resetCurrentSurface(): void {
  useCurrentSurfaceStore.setState(INITIAL);
}
