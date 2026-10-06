// The device-local "which tab opens on launch" preference.
//
// Same shape as lib/subscription/first-open-dismissal.ts, and for the same
// reason: `hydrateAllStores()` (lib/database/hydrate-stores.ts) is
// fire-and-forget, so the cold-start router in app/logged-in/index.tsx can
// reach its `router.replace` before the Zustand store has hydrated from disk,
// silently ignoring the preference. This leaf module reads the setting directly
// (`getSetting`, no Zustand) so that router never depends on hydration timing.
// `lib/stores/startup-tab-store.ts` still hydrates in the normal Promise.all;
// it drives the settings UI, nothing else.
//
// Values are the tab route names: `feed | world | library`. Older builds
// stored `for_you` (the Dashboard) and `around` (Explore). Those are
// translated ON READ (`for_you` -> feed, `around` -> world) and the row is
// never rewritten, so an old backup restored onto this build still parses, a
// new value restored onto an older build falls back to its default, and there
// is no migration to run twice.

import { getSetting } from '@/lib/database/services/setting-service';

export const STARTUP_TAB_SETTING_KEY = 'startup_tab';

/** Tab route names under app_container. */
export type StartupTab =
  | 'feed'
  | 'world'
  | 'library'
  /** @deprecated Old Dashboard route; `parseStartupTab` maps it to `feed`. Removed in navx P11. */
  | 'for_you'
  /** @deprecated Old Explore route; `parseStartupTab` maps it to `world`. Removed in navx P11. */
  | 'around';

export const STARTUP_TAB_DEFAULT = 'feed' as const;

const VALID_STARTUP_TABS: readonly string[] = ['feed', 'world', 'library'];
const LEGACY_STARTUP_TABS: Readonly<Record<string, StartupTab>> = {
  for_you: 'feed',
  around: 'world',
};

/** Narrows a raw settings-table string to a current tab, translating the two
 *  old route names and falling back to the default on anything else (unset,
 *  corrupt, or a value from a newer build). Never returns a deprecated value. */
export function parseStartupTab(raw: string | null | undefined): StartupTab {
  const v = raw ?? '';
  if (VALID_STARTUP_TABS.includes(v)) return v as StartupTab;
  return LEGACY_STARTUP_TABS[v] ?? STARTUP_TAB_DEFAULT;
}

/** The route that exists for each tab until the new tab folders land (navx
 *  P3a). Typed routes reject `app_container/world` before then, so
 *  readStartupTab keeps returning a current route name; navx P2b narrows it. */
type StartupRoute = 'feed' | 'for_you' | 'around';
const ROUTE_BEFORE_NEW_TABS: Readonly<Record<string, StartupRoute>> = {
  feed: 'feed',
  world: 'around',
  library: 'for_you',
};

/**
 * Which tab route should open on launch. FAILS to the default ('feed') on an
 * unreadable setting: there is no wrong side to fail toward here, so it
 * collapses to "behave as if the user never set a preference."
 */
export async function readStartupTab(): Promise<StartupRoute> {
  try {
    return ROUTE_BEFORE_NEW_TABS[parseStartupTab(await getSetting(STARTUP_TAB_SETTING_KEY))];
  } catch {
    return STARTUP_TAB_DEFAULT;
  }
}
