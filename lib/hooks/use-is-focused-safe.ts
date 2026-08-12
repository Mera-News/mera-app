// use-is-focused-safe — "is this component visible and is the app in front?"
//
// ## Why `useIsFocused` is not enough
//
// `@react-navigation/native`'s `useIsFocused()` THROWS outside a navigator:
// it calls `useNavigation()`, which raises "Couldn't find a navigation object"
// when there is no navigation context (see
// node_modules/@react-navigation/core/src/useIsFocused.tsx). That is not a
// theoretical case in this app — `NativeUpdateGate` renders `ForceUpdateScreen`
// from OUTSIDE the `<Stack>` in `app/_layout.tsx`, and `FullScreenErrorFallback`
// can render above the navigator when the failing boundary is high enough. A
// bare `useIsFocused()` in anything those trees mount turns the
// mandatory-update screen into a white-screen crash.
//
// So `useIsFocusedSafe()` reads the navigation context directly and treats
// "no navigator" as focused — the honest default, since a component with no
// navigator above it is not competing with any other screen.
//
// ## The friction this removes
//
// Several looping animations need the same predicate — "run only while the
// user can actually see me": components/ui/skeleton,
// config-panel/PersonaL1MeraProtocol, profile/AdvancedHubScreen, and MeraLogo.
// (for-you/FeedStatusShimmer was the fifth until its indeterminate bar was
// deleted; its replacement is an ActivityIndicator outside the glass, which
// needs no gate.)
// Tabs stay mounted (see FocusFreeze @deprecated), so a blurred tab's
// animations otherwise run forever behind whatever the user is actually
// looking at. `MeraLogo` is the expensive one: it animates an SVG `<G
// transform>`, which RNSVG rasterises on the CPU (documented at
// AbstractGradientBackdrop.tsx:336-342), and it sits permanently at the bottom
// of the Feed via `AllCaughtUpCard`.
//
// AppState gating follows the same refcount-free shape as `lib/time-tick.ts`:
// a backgrounded app animates nothing.

import { useContext, useEffect, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import { NavigationContext } from '@react-navigation/native';

/**
 * `useIsFocused()` that returns `true` instead of throwing when there is no
 * navigator above the caller.
 */
export function useIsFocusedSafe(): boolean {
  // Unconditional — `useContext` is safe with or without a provider, which is
  // exactly what `useNavigation()` is not.
  const navigation = useContext(NavigationContext);

  const [focused, setFocused] = useState(() =>
    navigation ? navigation.isFocused() : true,
  );

  useEffect(() => {
    if (!navigation) {
      setFocused(true);
      return;
    }
    // Sync immediately: the navigator may have changed focus between the
    // initial render and this effect.
    setFocused(navigation.isFocused());
    const unsubFocus = navigation.addListener('focus', () => setFocused(true));
    const unsubBlur = navigation.addListener('blur', () => setFocused(false));
    return () => {
      unsubFocus();
      unsubBlur();
    };
  }, [navigation]);

  return focused;
}

/** True while the app is in the foreground. `inactive` (app switcher, a system
 *  alert) still shows content, so only a real `background` stops animation —
 *  the same asymmetry `lib/time-tick.ts` documents. */
export function useAppIsForegrounded(): boolean {
  const [active, setActive] = useState(
    () => AppState.currentState !== 'background',
  );

  useEffect(() => {
    const sub = AppState.addEventListener('change', (s: AppStateStatus) => {
      setActive(s !== 'background');
    });
    return () => sub.remove();
  }, []);

  return active;
}

/**
 * The gate for a continuously looping animation: run only when this component
 * is the focused screen AND the app is in front.
 *
 * Deliberately NOT used for animations that convey liveness of an in-flight
 * operation the user is waiting on (e.g. a chat streaming indicator) — a paused
 * indicator there reads as a hung request rather than as an idle screen.
 */
export function useAnimationsActive(): boolean {
  const focused = useIsFocusedSafe();
  const foregrounded = useAppIsForegrounded();
  return focused && foregrounded;
}
