// Redirect stubs for routes that moved into the four tabs. An old link, a
// push payload or a restored screen still opens; it lands on the page or the
// tab screen that replaced it.
//
// Not expo-router's <Redirect>: that replaces the stub with the target href,
// which leaves the tab's page to the URL (no page state in URLs) and, from a
// root push, stacks a second copy of the tabs. These go through
// navigateToPage / navigateToTabScreen, which dismiss the stub (a root push)
// first, or replace it when it was opened cold with nothing underneath.

import { router, useNavigation } from 'expo-router';
import { useEffect, useRef } from 'react';

import { navigateToPage, navigateToTabScreen } from './navigate-to-page';
import type { PageId, TabId } from './page-registry';

// The redirect must not dismiss while this stub's own push is still animating: dismissing it
// mid-push together with another root screen left Android with a blank screen. So it waits for
// the push's transitionEnd.
// Lite (animation: 'none') and a cold open with nothing underneath may emit no transition, so the
// fallback guarantees the redirect.
const SETTLE_FALLBACK_MS = 500;

type TransitionNav = {
  addListener(
    type: 'transitionEnd',
    cb: (e: { data?: { closing?: boolean } }) => void,
  ): () => void;
};

export function useRedirectWhenSettled(run: () => void): void {
  const navigation = useNavigation() as unknown as TransitionNav;
  const done = useRef(false);
  useEffect(() => {
    const fire = () => {
      if (done.current) return;
      done.current = true;
      run();
    };
    const unsubscribe = navigation.addListener('transitionEnd', (e) => {
      if (!e.data?.closing) fire();
    });
    const timer = setTimeout(fire, SETTLE_FALLBACK_MS);
    return () => {
      unsubscribe();
      clearTimeout(timer);
    };
    // Mount only: a stub never re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function PageRedirect({ page }: { page: PageId }): null {
  useRedirectWhenSettled(() => navigateToPage(page, { replace: !router.canDismiss() }));
  return null;
}

export function TabScreenRedirect({
  tab,
  screen,
  params,
}: {
  tab: TabId;
  screen: string;
  params?: Readonly<Record<string, string>>;
}): null {
  useRedirectWhenSettled(() => navigateToTabScreen(tab, screen, { params, replace: !router.canDismiss() }));
  return null;
}
