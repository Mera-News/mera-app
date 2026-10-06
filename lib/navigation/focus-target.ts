// Jump to the setting: take the reader to the You tab, open the page (and the
// settings sub-screen) where a setting lives, scroll to it and highlight it.
// Going back is the tab bar, or Android Back, which returns to where the jump
// started.
//
// The target is a ONE-SHOT pending value in this store, never a URL param. A
// param would stick (a later plain tap on You would highlight again), the same
// jump twice would not change the URL (nothing would fire), and the target may
// not exist yet when the tab opens (a page outside the pager window, a screen
// still loading). Each `FocusTarget` takes its own id when it is laid out.
//
// Expiry starts when the destination gains focus (`armPendingFocus`), not at
// the tap: an Android tab switch waits for JS, so a clock started at the tap
// could expire before the screen exists.

import { BackHandler } from 'react-native';
import { router } from 'expo-router';
import { create } from 'zustand';

import { useCurrentSurface, useCurrentSurfaceStore } from '@/components/custom/nav/current-surface';
import { navigateToPage, navigateToTabScreen, setPendingPage } from '@/components/custom/nav/navigate-to-page';
import {
    isCountryPage,
    PAGE_META,
    tabForSurface,
    tabRoute,
    type PageId,
    type SurfaceId,
} from '@/components/custom/nav/page-registry';

/**
 * Everything a jump can land on this wave. More (notification hours, Lite
 * mode, text size...) arrive with the settings-proposals plan; add each one
 * here, to `FOCUS_ROUTES` and as a `FocusTarget` on its screen, together.
 */
export type FocusId =
    | 'profile.facts'
    | 'profile.places'
    | 'profile.sources'
    | 'profile.topicsDeclined'
    | 'meraProtocol.automaticFactCheck';

/** What shapes the Feed and Interests pages: their quick-settings jump. */
export const FEED_SHAPERS: readonly FocusId[] = [
    'profile.facts',
    'profile.places',
    'profile.sources',
    'profile.topicsDeclined',
];

type YouSubScreen = 'mera-protocol';

export interface FocusRoute {
    readonly page: 'profile' | 'settings';
    /** A settings sub-screen pushed in the You stack, if the target is in one. */
    readonly screen?: YouSubScreen;
    /** The surface the reader is on once the jump lands. */
    readonly surface: SurfaceId;
}

const FOCUS_ROUTES: Readonly<Record<FocusId, FocusRoute>> = {
    'profile.facts': { page: 'profile', surface: 'profile' },
    'profile.places': { page: 'profile', surface: 'profile' },
    'profile.sources': { page: 'profile', surface: 'profile' },
    'profile.topicsDeclined': { page: 'profile', surface: 'profile' },
    'meraProtocol.automaticFactCheck': { page: 'settings', screen: 'mera-protocol', surface: 'settings:mera-protocol' },
};

export function routeForFocus(id: FocusId): FocusRoute {
    return FOCUS_ROUTES[id];
}

/** How long an armed target waits to be laid out before it is dropped. */
export const FOCUS_EXPIRY_MS = 5_000;
/** A jump whose destination never gained focus (navigation failed) is
 *  dropped after this, so it never fires on some later, unrelated visit. */
export const FOCUS_UNARMED_MAX_AGE_MS = 30_000;

interface PendingFocus {
    /** Targets not yet taken. */
    readonly ids: readonly FocusId[];
    /** The one the destination scrolls to (the first asked for). */
    readonly scrollTo: FocusId;
    readonly at: number;
    readonly armedAt: number | null;
}

interface Jump {
    readonly origin: SurfaceId;
    readonly destination: SurfaceId;
}

interface FocusState {
    pending: PendingFocus | null;
    jump: Jump | null;
}

export const useFocusTargetStore = create<FocusState>()(() => ({ pending: null, jump: null }));

/** The ids still waiting, for `FocusTarget` to react to. */
export function usePendingFocusIds(): readonly FocusId[] {
    return useFocusTargetStore((s) => s.pending?.ids ?? EMPTY);
}
const EMPTY: readonly FocusId[] = [];

export function navigateToSetting(target: FocusId | readonly FocusId[], now: number = Date.now()): void {
    const ids: readonly FocusId[] = typeof target === 'string' ? [target] : target;
    if (ids.length === 0) return;
    const route = routeForFocus(ids[0]);
    const origin = useCurrentSurface.getState();
    useFocusTargetStore.setState({
        pending: { ids, scrollTo: ids[0], at: now, armedAt: null },
        jump: origin ? { origin, destination: route.surface } : null,
    });
    if (origin) listenForBack();
    // L1 owns the order: a root push is dismissed first (never the origin
    // tab's own stack), then the You stack pops to its root, then a push.
    if (route.screen) {
        // The page under the sub-screen, so Back from it lands on Settings.
        setPendingPage(route.page);
        navigateToTabScreen('you', route.screen);
    } else {
        navigateToPage(route.page);
    }
}

/** The destination gained focus: start the expiry clock (idempotent). */
export function armPendingFocus(now: number = Date.now()): void {
    const { pending } = useFocusTargetStore.getState();
    if (pending && pending.armedAt === null) {
        useFocusTargetStore.setState({ pending: { ...pending, armedAt: now } });
    }
}

function isStale(p: PendingFocus, now: number): boolean {
    return p.armedAt === null ? now - p.at > FOCUS_UNARMED_MAX_AGE_MS : now - p.armedAt > FOCUS_EXPIRY_MS;
}

export type FocusTake = 'none' | 'highlight' | 'scroll';

/**
 * A laid-out target takes its id. One-shot: a second call for the same id
 * returns 'none'. 'scroll' means this target is the one to scroll to.
 */
export function takeFocus(id: FocusId, now: number = Date.now()): FocusTake {
    const { pending } = useFocusTargetStore.getState();
    if (!pending || !pending.ids.includes(id)) return 'none';
    if (isStale(pending, now)) {
        useFocusTargetStore.setState({ pending: null });
        return 'none';
    }
    const ids = pending.ids.filter((x) => x !== id);
    useFocusTargetStore.setState({ pending: ids.length > 0 ? { ...pending, ids } : null });
    return id === pending.scrollTo ? 'scroll' : 'highlight';
}

function isPage(surface: SurfaceId): surface is PageId {
    return surface in PAGE_META || isCountryPage(surface);
}

/**
 * Android Back on the jump's destination: return to where the jump started.
 * Returns false (default Back) when no jump is live or the reader has moved on.
 */
export function returnToJumpOrigin(): boolean {
    const { jump } = useFocusTargetStore.getState();
    if (!jump || useCurrentSurface.getState() !== jump.destination) return false;
    useFocusTargetStore.setState({ jump: null });
    if (isPage(jump.origin)) {
        navigateToPage(jump.origin);
        return true;
    }
    const tab = tabForSurface(jump.origin);
    if (!tab) return false;
    // A pushed screen in another tab (One interest): that tab's stack still
    // holds it, so opening the tab is enough.
    router.navigate(tabRoute(tab));
    return true;
}

// The jump ends as soon as the reader is somewhere that is neither end of it
// (the tab bar, a row tapped on the destination). Null is a transition.
useCurrentSurfaceStore.subscribe((s) => {
    const { jump } = useFocusTargetStore.getState();
    if (jump && s.surface !== null && s.surface !== jump.origin && s.surface !== jump.destination) {
        useFocusTargetStore.setState({ jump: null });
    }
});

// Added per jump, never at import: BackHandler runs listeners LIFO, so only a
// listener added AFTER the navigators mounted theirs is asked first. It
// declines (false) unless the live jump's destination is showing. iOS: no-op.
let backSub: { remove: () => void } | null = null;
function listenForBack(): void {
    backSub?.remove();
    backSub = BackHandler.addEventListener('hardwareBackPress', returnToJumpOrigin);
}
function stopListeningForBack(): void {
    backSub?.remove();
    backSub = null;
}
useFocusTargetStore.subscribe((s) => {
    if (s.jump === null && backSub) stopListeningForBack();
});

/** Account switch (wired in clearAllStores by L4). */
export function resetPendingFocus(): void {
    useFocusTargetStore.setState({ pending: null, jump: null });
}
