// Open a page of any tab: the one way code moves the reader to a page.
//
// No page state in URLs. A request is a one-shot value in this store; the
// target tab's TabPages consumes it when the tab gains focus (or at once if it
// is already focused) and selects that page. A URL param would stick: a later
// plain tap on the tab would re-apply it, and the same page asked for twice
// would not change the URL, so nothing would fire.
//
// Redirect stubs (share-stats, saved-suggestions, ...) and the shortcuts on
// the Feed's empty state go through here too; `params` carries what a page
// needs on arrival (Stats' `card`).
//
// Navigation order: a root push above app_container (article detail, Search,
// a stub) is dismissed first, and only then, so the origin tab's own stack is
// never popped. Then the TARGET tab's stack is popped to its root explicitly
// (a screen pushed there earlier, Facts in You, would otherwise stay on top of
// the page the jump is for), and only then is the tab navigated to.
//
// The explicit pop goes through a per-tab popper registered by each tab's
// root screen (`useRegisterTabStack`), because only a screen inside that stack
// holds its navigation object; navigating to the tab's path alone does not
// promise a pop.

import { router, useNavigation, type Href } from 'expo-router';
import { useEffect } from 'react';
import { create } from 'zustand';

import { useCurrentSurface } from './current-surface';
import { tabForSurface, tabOfPage, tabRoute, type PageId, type SurfaceId, type TabId } from './page-registry';

export interface PageRequest {
  readonly page: PageId;
  /** One-shot arrival params for the page (Stats: `card`). */
  readonly params: Readonly<Record<string, string>> | null;
  /** Where the jump started, for the jump-origin Back. Null: unknown. */
  readonly origin: SurfaceId | null;
  /** Epoch ms of the request. */
  readonly at: number;
}

/**
 * A request nobody consumed within this long is dropped, so a jump whose
 * navigation failed never fires on some later, unrelated tap of that tab.
 * Generous on purpose: an Android tab switch waits for JS, and a cold start
 * through a deep link still has the startup gate to pass.
 */
export const PENDING_PAGE_MAX_AGE_MS = 30_000;

/** Which end of a tab's page order a cross-tab swipe lands on. */
export type TabEdge = 'first' | 'last';

interface PendingEdge {
  readonly tab: TabId;
  readonly edge: TabEdge;
  readonly at: number;
}

interface PendingPageState {
  request: PageRequest | null;
  edge: PendingEdge | null;
}

export const usePendingPageStore = create<PendingPageState>()(() => ({ request: null, edge: null }));

/** The pending cross-tab landing, for TabPages to react to while focused. */
export function usePendingEdge(): PendingEdge | null {
  return usePendingPageStore((s) => s.edge);
}

/** The pending request, for TabPages to react to while its tab is focused. */
export function usePendingPageRequest(): PageRequest | null {
  return usePendingPageStore((s) => s.request);
}

export interface NavigateToPageOptions {
  readonly params?: Readonly<Record<string, string>>;
  /** A redirect stub opened cold (nothing under it to dismiss): replace the
   *  stub with the tab instead of pushing the tab on top of it. */
  readonly replace?: boolean;
}

/** Pops a tab's stack to its root; registered by the tab's root screen. */
type StackPopper = () => void;
const stackPoppers = new Map<TabId, StackPopper>();

/** Register `pop` as `tab`'s stack popper; returns the unregister. */
export function registerTabStack(tab: TabId, pop: StackPopper): () => void {
  stackPoppers.set(tab, pop);
  return () => {
    if (stackPoppers.get(tab) === pop) stackPoppers.delete(tab);
  };
}

/** Call from each tab's ROOT screen (the stack's first route). */
export function useRegisterTabStack(tab: TabId): void {
  const navigation = useNavigation();
  useEffect(
    () =>
      registerTabStack(tab, () => {
        const nav = navigation as unknown as {
          getState: () => { index: number } | undefined;
          popToTop: () => void;
        };
        if ((nav.getState()?.index ?? 0) > 0) nav.popToTop();
      }),
    [tab, navigation],
  );
}

/** Set the pending request without navigating (`+native-intent`, which
 *  returns the path itself). */
export function setPendingPage(page: PageId, params: Readonly<Record<string, string>> | null = null): void {
  usePendingPageStore.setState({
    request: { page, params, origin: useCurrentSurface.getState(), at: Date.now() },
  });
}

/** Dismiss a root push, pop the target tab's stack, then open the tab. */
function openTab(tab: TabId, origin: SurfaceId | null, replace: boolean | undefined): void {
  // A surface inside a tab never dismisses: that would pop its own stack.
  const fromRootPush = origin === null || tabForSurface(origin) === null;
  const dismissed = fromRootPush && router.canDismiss();
  if (dismissed) router.dismissAll();
  stackPoppers.get(tab)?.();
  const href = tabRoute(tab);
  if (replace && !dismissed) router.replace(href);
  else router.navigate(href);
}

export function navigateToPage(page: PageId, opts: NavigateToPageOptions = {}): void {
  const origin = useCurrentSurface.getState();
  usePendingPageStore.setState({
    request: { page, params: opts.params ?? null, origin, at: Date.now() },
  });
  openTab(tabOfPage(page), origin, opts.replace);
}

/**
 * Open a screen pushed inside a tab's stack (`you/sources`), on top of that
 * tab's ROOT: same dismiss and pop order as `navigateToPage`, then a push.
 * The tab keeps whatever page it was on.
 */
export function navigateToTabScreen(
  tab: TabId,
  screen: string,
  opts: NavigateToPageOptions = {},
): void {
  openTab(tab, useCurrentSurface.getState(), opts.replace);
  // Built at run time from a screen name, so typed routes cannot check it;
  // the route-files test asserts every caller's screen exists.
  router.push({ pathname: `${tabRoute(tab)}/${screen}`, params: opts.params ?? {} } as Href);
}

/**
 * The page swipe ran past a tab's last (or before its first) page: open the
 * neighbouring tab on its first (or last) page. The tab's own order decides
 * which page that is, so the landing is an EDGE, not a page id.
 */
export function navigateToTabEdge(tab: TabId, edge: TabEdge): void {
  usePendingPageStore.setState({ edge: { tab, edge, at: Date.now() } });
  openTab(tab, useCurrentSurface.getState(), false);
}

/** Take the pending edge landing if it is for `tab` and still fresh. One-shot. */
export function consumePendingEdge(tab: TabId, now: number = Date.now()): TabEdge | null {
  const { edge } = usePendingPageStore.getState();
  if (!edge || edge.tab !== tab) return null;
  usePendingPageStore.setState({ edge: null });
  return now - edge.at > PENDING_PAGE_MAX_AGE_MS ? null : edge.edge;
}

/** Take the pending request if it is for `tab` and still fresh. One-shot. */
export function consumePendingPage(tab: TabId, now: number = Date.now()): PageRequest | null {
  const { request } = usePendingPageStore.getState();
  if (!request) return null;
  if (now - request.at > PENDING_PAGE_MAX_AGE_MS) {
    usePendingPageStore.setState({ request: null });
    return null;
  }
  if (tabOfPage(request.page) !== tab) return null;
  usePendingPageStore.setState({ request: null });
  return request;
}

/** Account switch (wired in clearAllStores by L4). */
export function resetPendingPage(): void {
  usePendingPageStore.setState({ request: null, edge: null });
}
