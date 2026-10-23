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
//
// A RESTORE BOOT (an update reload that rebuilds the reader's spot) keeps the
// launch look over the whole rebuild, so the reader sees a launch and not the
// startup tab, then a jump: on iOS the held splash ignores route changes while
// the restore runs (`beginRestoreLook` / `endRestoreLook`), and on Android,
// where nothing is held, `components/custom/launch/RestoreCover.tsx` paints the
// same look. The cap grows on such a boot to cover the account check and the
// rebuild.

import * as SplashScreen from 'expo-splash-screen';
import { usePathname } from 'expo-router';
import { useEffect } from 'react';
import { Platform } from 'react-native';

/** The most the splash may be held past JS start. */
export const SPLASH_MAX_HOLD_MS = 4000;

/** On a restore boot: the launch account check (8s cap) plus the gate's restore cap (3s). */
export const RESTORE_LOOK_MAX_MS = 8_000 + 3_000;

/**
 * iOS ONLY. On Android, holding and then manually hiding the splash left the
 * window with no opaque background after the hide (frames never cleared:
 * text smeared over black), so Android keeps expo-router's own auto-hide,
 * exactly as before the hold existed. Do not re-enable on Android without a
 * verified fix on a device or emulator.
 */
function holdsSplash(): boolean {
  return Platform.OS === 'ios';
}

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
  if (!holdsSplash() || held) return;
  held = true;
  void SplashScreen.preventAutoHideAsync().catch(() => {
    // Already hidden or no native module: nothing is being held.
  });
  capTimer = setTimeout(() => releaseSplash('cap'), SPLASH_MAX_HOLD_MS);
  void isRestoreBoot().then((restore) => {
    if (!restore || released) return;
    if (capTimer) clearTimeout(capTimer);
    capTimer = setTimeout(() => releaseSplash('cap'), RESTORE_LOOK_MAX_MS);
  });
}

// ---------------------------------------------------------------------------
// The restore look
// ---------------------------------------------------------------------------

type RestoreLook = 'none' | 'running' | 'done';
let restoreLook: RestoreLook = 'none';
let restoreBoot: Promise<boolean> | null = null;
const lookListeners = new Set<() => void>();

/**
 * Whether this boot carries a spot to rebuild. Lazy: the marker read lives in
 * lib/app-restart.ts, which this module must not pull in at import (the root
 * layout imports this file first). Memoised; a failure reads as "no".
 */
export function isRestoreBoot(): Promise<boolean> {
  if (restoreBoot == null) {
    restoreBoot = (async () => {
      try {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { restartContext } = require('@/lib/app-restart');
        const ctx = await restartContext();
        return ctx.spot != null;
      } catch {
        return false;
      }
    })();
  }
  return restoreBoot;
}

function setRestoreLook(next: RestoreLook): void {
  restoreLook = next;
  lookListeners.forEach((l) => l());
}

/** The gate is about to rebuild the spot: the held splash ignores routes until `endRestoreLook`. */
export function beginRestoreLook(): void {
  setRestoreLook('running');
}

/** The rebuild finished, whatever its result: release what it held. */
export function endRestoreLook(): void {
  setRestoreLook('done');
  releaseSplash('restore');
}

export function restoreLookState(): RestoreLook {
  return restoreLook;
}

export function subscribeRestoreLook(listener: () => void): () => void {
  lookListeners.add(listener);
  return () => lookListeners.delete(listener);
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
  if (!holdsSplash() || released) return;
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
    // The rebuild navigates through tabs and screens the reader is not meant to watch.
    if (restoreLook === 'running') return;
    if (isPastStartupGates(pathname)) releaseSplash(`route:${pathname}`);
  }, [pathname]);
  return null;
}

/** Test seam: forget process state, as a JS reload would. */
export function __resetSplashHoldForTests(): void {
  held = false;
  released = false;
  restoreLook = 'none';
  restoreBoot = null;
  lookListeners.clear();
  if (capTimer) clearTimeout(capTimer);
  capTimer = null;
}
