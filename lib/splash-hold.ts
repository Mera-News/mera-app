// Keeps the native splash up until the first real screen has committed.
//
// WHY. expo-router hides the splash right after the first root render. What
// followed on a cold start was NativeUpdateGate's spinner on black and then
// about a second of pure black while the first tab committed (measured, and
// the same with Static background on, so it is JS mount time, not the
// animated backdrop). Holding the splash over that window turns
// splash > spinner > black > Feed into splash > Feed.
//
// THE RULE. `holdSplash()` runs once at module scope in app/_layout.tsx (the
// public preventAutoHideAsync is what stops expo-router's own auto-hide).
// `SplashReleaser` releases on the first pathname that is not a startup gate,
// which covers every destination without listing them (tabs, /login,
// /pin-lock, onboarding, deep links). The gates release for the screens they
// render in place (IdentitySwitchFailedScreen, ForceUpdateScreen).
//
// IT CAN NEVER HANG. A hard cap hides it regardless, so a missed release costs
// a few seconds of splash, never a stuck app.

import * as SplashScreen from 'expo-splash-screen';
import { usePathname } from 'expo-router';
import { useEffect } from 'react';

/** The most the splash may be held past JS start. */
export const SPLASH_MAX_HOLD_MS = 4000;

/** Pathnames of the startup gates: while one of these is showing, nothing the
 *  user came for has rendered yet. */
export const STARTUP_GATE_PATHNAMES: readonly string[] = ['/', '/logged-in'];

let held = false;
let released = false;
let capTimer: ReturnType<typeof setTimeout> | null = null;

function hideNow(): void {
  try {
    SplashScreen.hide();
  } catch {
    // No native module (tests, web): nothing to hide.
  }
}

/** Call once, at module scope in the root layout. Idempotent. */
export function holdSplash(): void {
  if (held) return;
  held = true;
  void SplashScreen.preventAutoHideAsync().catch(() => {
    // Already hidden or no native module: nothing is being held.
  });
  capTimer = setTimeout(() => releaseSplash('cap'), SPLASH_MAX_HOLD_MS);
}

/**
 * Hide the splash now. Callers run after the commit that mounted the screen,
 * so the content is already in the tree. Idempotent: only the first call does
 * anything.
 *
 * NEVER wait for a frame here (`requestAnimationFrame`). On Android,
 * expo-splash-screen holds the splash with an OnPreDrawListener that cancels
 * every draw of the content view until `hide()` runs; a hide scheduled on a
 * frame therefore waits for a frame that the held splash never lets happen.
 * That deadlock left Android on a black, untouchable screen with JS running
 * underneath, and the 4s cap went through the same path so it never fired
 * either.
 */
export function releaseSplash(_reason: string): void {
  if (released) return;
  released = true;
  if (capTimer) {
    clearTimeout(capTimer);
    capTimer = null;
  }
  hideNow();
}

/** True for a pathname the user actually came for (not a startup gate). */
export function isPastStartupGates(pathname: string | null | undefined): boolean {
  if (!pathname) return false;
  return !STARTUP_GATE_PATHNAMES.includes(pathname);
}

/**
 * Mounted once in the root layout, inside the router. Releases the splash on
 * the first pathname that is not a startup gate; the effect runs after the
 * commit that mounted that route, so for a tab it fires after the tab's first
 * render. Renders nothing (a .ts file on purpose: no JSX needed).
 */
export function SplashReleaser(): null {
  const pathname = usePathname();
  useEffect(() => {
    if (isPastStartupGates(pathname)) releaseSplash(`route:${pathname}`);
  }, [pathname]);
  return null;
}

/** Test seam: forget process state, as a JS reload would. */
export function __resetSplashHoldForTests(): void {
  held = false;
  released = false;
  if (capTimer) clearTimeout(capTimer);
  capTimer = null;
}
