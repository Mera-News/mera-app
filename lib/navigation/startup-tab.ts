// The device-local "which tab opens on launch" preference.
//
// Same shape as lib/subscription/first-open-dismissal.ts, and for the same
// reason: `hydrateAllStores()` (lib/database/hydrate-stores.ts) is
// fire-and-forget, so the cold-start router in app/logged-in/index.tsx (and
// the post-onboarding handoff in app/logged-in/onboarding.tsx) can reach its
// `router.replace` before the Zustand store has hydrated from disk, silently
// ignoring the preference. This leaf module reads the setting directly
// (`getSetting`, no Zustand) so those two routers never depend on hydration
// timing. `lib/stores/startup-tab-store.ts` still hydrates in the normal
// Promise.all — it drives the settings UI, nothing else.
//
// The route names are inverted from what a user would call them: `feed` is
// the Feed deck, `for_you` is the Dashboard, `around` is Explore (see
// app/logged-in/app_container/_layout.tsx). This module is the one place
// that mapping is encoded — callers pass/receive the real route name.

import { getSetting } from '@/lib/database/services/setting-service';

export const STARTUP_TAB_SETTING_KEY = 'startup_tab';

/** Real route names under app_container, not the user-facing tab labels. */
export type StartupTab = 'feed' | 'for_you' | 'around';

export const STARTUP_TAB_DEFAULT: StartupTab = 'feed';

const VALID_STARTUP_TABS: readonly StartupTab[] = ['feed', 'for_you', 'around'];

/** Narrows a raw settings-table string to a valid route name, falling back to
 *  the default on anything unrecognized (unset, corrupt, or a future/removed
 *  option). */
export function parseStartupTab(raw: string | null | undefined): StartupTab {
    return (VALID_STARTUP_TABS as readonly string[]).includes(raw ?? '')
        ? (raw as StartupTab)
        : STARTUP_TAB_DEFAULT;
}

/**
 * Which tab should open on launch. FAILS to the default ('feed') on an
 * unreadable setting — the same fail-safe shape as readFirstOpenDismissed(),
 * just with a different direction: there is no wrong side to fail toward
 * here, so it collapses to "behave as if the user never set a preference."
 */
export async function readStartupTab(): Promise<StartupTab> {
    try {
        return parseStartupTab(await getSetting(STARTUP_TAB_SETTING_KEY));
    } catch {
        return STARTUP_TAB_DEFAULT;
    }
}
