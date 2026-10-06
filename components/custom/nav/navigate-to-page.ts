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
// never popped. Then the target tab is navigated to.

import { router } from 'expo-router';
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

interface PendingPageState {
  request: PageRequest | null;
}

export const usePendingPageStore = create<PendingPageState>()(() => ({ request: null }));

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

export function navigateToPage(page: PageId, opts: NavigateToPageOptions = {}): void {
  const origin = useCurrentSurface.getState();
  usePendingPageStore.setState({
    request: { page, params: opts.params ?? null, origin, at: Date.now() },
  });
  const href = tabRoute(tabOfPage(page));
  // A surface inside a tab never dismisses: that would pop its own stack.
  const fromRootPush = origin === null || tabForSurface(origin) === null;
  if (fromRootPush && router.canDismiss()) {
    router.dismissAll();
    router.navigate(href);
    return;
  }
  if (opts.replace) {
    router.replace(href);
    return;
  }
  router.navigate(href);
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
  usePendingPageStore.setState({ request: null });
}
