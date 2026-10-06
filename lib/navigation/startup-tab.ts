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

/** A tab that can open on launch; each is a route folder under app_container. */
export type StartupTab = 'feed' | 'world' | 'library';
/** The same type under the name DisplaySettingsScreen imports. */
export type LaunchTab = StartupTab;

export const STARTUP_TAB_DEFAULT = 'feed' as const;

const VALID_STARTUP_TABS: readonly string[] = ['feed', 'world', 'library'];
const LEGACY_STARTUP_TABS: Readonly<Record<string, StartupTab>> = {
  for_you: 'feed',
  around: 'world',
};

/** Narrows a raw settings-table string to a current tab, translating the two
 *  old route names and falling back to the default on anything else (unset,
 *  corrupt, or a value from a newer build). Never returns an old route name. */
export function parseStartupTab(raw: string | null | undefined): StartupTab {
  const v = raw ?? '';
  if (VALID_STARTUP_TABS.includes(v)) return v as StartupTab;
  return LEGACY_STARTUP_TABS[v] ?? STARTUP_TAB_DEFAULT;
}

/**
 * Which tab route should open on launch. FAILS to the default ('feed') on an
 * unreadable setting: there is no wrong side to fail toward here, so it
 * collapses to "behave as if the user never set a preference."
 */
export async function readStartupTab(): Promise<StartupTab> {
  try {
    return parseStartupTab(await getSetting(STARTUP_TAB_SETTING_KEY));
  } catch {
    return STARTUP_TAB_DEFAULT;
  }
}
