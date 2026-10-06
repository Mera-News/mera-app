// Redirect stubs for routes that moved into the four tabs. An old link, a
// push payload or a restored screen still opens; it lands on the page or the
// tab screen that replaced it.
//
// Not expo-router's <Redirect>: that replaces the stub with the target href,
// which leaves the tab's page to the URL (no page state in URLs) and, from a
// root push, stacks a second copy of the tabs. These go through
// navigateToPage / navigateToTabScreen, which dismiss the stub (a root push)
// first, or replace it when it was opened cold with nothing underneath.

import { router } from 'expo-router';
import { useEffect, useRef } from 'react';

import { navigateToPage, navigateToTabScreen } from './navigate-to-page';
import type { PageId, TabId } from './page-registry';

function useOnce(run: () => void): void {
  const done = useRef(false);
  useEffect(() => {
    if (done.current) return;
    done.current = true;
    run();
    // Mount only: a stub never re-runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}

export function PageRedirect({
  page,
  params,
}: {
  page: PageId;
  params?: Readonly<Record<string, string>>;
}): null {
  useOnce(() => navigateToPage(page, { params, replace: !router.canDismiss() }));
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
  useOnce(() => navigateToTabScreen(tab, screen, { params, replace: !router.canDismiss() }));
  return null;
}
