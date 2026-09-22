import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';
import { restartContext, type RestartContext } from '@/lib/app-restart';
import logger from '@/lib/logger';
import {
  isAppLockEnabled as readIsAppLockEnabled,
  setAppLockEnabled as persistAppLockEnabled,
} from '@/lib/security/app-lock-service';
import { clearPin, isPinSet as readIsPinSet } from '@/lib/security/pin-service';
import { runPinForceResetOnce } from '@/lib/security/pin-force-reset';

// Re-lock the app when it returns to the foreground after more than this long
// in the background. Cold start with the lock enabled always locks.
export const BACKGROUND_LOCK_THRESHOLD_MS = 5 * 60_000;

/**
 * Pure lock-timing decision, extracted for unit testing. Locks only when the
 * user has opted into the lock AND a PIN exists, we have a recorded background
 * timestamp, and the gap exceeds the threshold.
 */
export function shouldLockAfterBackground(
  lastBackgroundedAt: number | null,
  now: number,
  pinSet: boolean,
  lockEnabled: boolean,
): boolean {
  if (!lockEnabled) return false;
  if (!pinSet) return false;
  if (lastBackgroundedAt == null) return false;
  return now - lastBackgroundedAt > BACKGROUND_LOCK_THRESHOLD_MS;
}

interface PinState {
  pinSet: boolean;
  /** The user has opted into the PIN gate (see app-lock-service.ts). */
  lockEnabled: boolean;
  locked: boolean;
  lastBackgroundedAt: number | null;
  initialized: boolean;

  init: () => Promise<void>;
  setPinSet: (v: boolean) => void;
  setLockEnabled: (enabled: boolean) => Promise<void>;
  lock: () => void;
  unlock: () => void;
  markBackgrounded: (at?: number) => void;
  handleForeground: (now?: number) => void;
}

export const usePinStore = create<PinState>()((set, get) => ({
  pinSet: false,
  lockEnabled: false,
  locked: false,
  lastBackgroundedAt: null,
  initialized: false,

  // Reads the opt-in flag and the on-device PIN record, and engages the lock on
  // cold start when both are present. Idempotent — safe to call from both the
  // root layout and the launch gate; the AppState listener is wired exactly
  // once (see below).
  //
  // A JS RESTART IS NOT A COLD START. Since every background -> foreground
  // return reloads the app (lib/app-restart.ts), an unconditional cold-start
  // lock would turn a three-second background into a PIN entry, on every single
  // return — the most visible regression this change could have. On a restart
  // boot the ordinary threshold rule is applied instead, against the background
  // stamp the marker carried across the reload, so the security semantics are
  // exactly what they were: away longer than BACKGROUND_LOCK_THRESHOLD_MS locks,
  // shorter does not. A real cold start still locks unconditionally.
  //
  // This runs in an earlier effect than the root bootstrap's
  // `initRestartContext()`, so it awaits the memoised promise itself rather
  // than reading `wasJsRestartSync()`. Both callers end up on one marker read.
  init: async () => {
    if (get().initialized) return;
    let pinSet = false;
    let lockEnabled = false;
    // Fails to "cold start", which is the locking side. An unreadable marker
    // must never be the reason a PIN gate does not engage.
    let restart: RestartContext = {
      wasJsRestart: false,
      backgroundedAt: null,
      lastForegroundAt: null,
    };
    try {
      restart = await restartContext();
    } catch (err) {
      logger.captureException(err, { tags: { store: 'pin-store', method: 'init-restart' } });
    }
    try {
      // One-shot PIN gate reset (see pin-force-reset.ts). Deliberately BEFORE the
      // reads below: app/index.tsx awaits init() before resolveLaunchRoute, so a
      // device cleared here reports lockEnabled:false on the very launch that
      // clears it and cannot be routed to /pin-lock on the way through.
      await runPinForceResetOnce();

      [pinSet, lockEnabled] = await Promise.all([readIsPinSet(), readIsAppLockEnabled()]);

      // Invariant: lock off ⇒ no PIN record. This is what disables the gate for
      // users who set a PIN back when it was mandatory — they carry a record
      // but no opt-in flag, so we drop the stale record here rather than keep a
      // hash nobody can reach. Re-enabling always writes a fresh PIN.
      if (!lockEnabled && pinSet) {
        await clearPin();
        pinSet = false;
      }
    } catch (err) {
      logger.captureException(err, { tags: { store: 'pin-store', method: 'init' } });
    }
    set({
      pinSet,
      lockEnabled,
      // Cold start with the lock on and a PIN configured ⇒ locked until entry.
      // A restart boot instead applies the same threshold a warm foreground
      // would, against the pre-restart background stamp. A null stamp (an OTA
      // restart fired while the user was looking at the app) means they never
      // left, so it does not lock.
      locked: restart.wasJsRestart
        ? shouldLockAfterBackground(restart.backgroundedAt, Date.now(), pinSet, lockEnabled)
        : lockEnabled && pinSet,
      initialized: true,
    });
    ensureAppStateListener();
  },

  setPinSet: (v) =>
    set({
      pinSet: v,
      // Setting a PIN implies the user just entered it (setup/change), so we
      // don't re-lock here. Clearing a PIN (reauth/logout) also unlocks.
      locked: false,
    }),

  // Turning the lock ON assumes the caller has just persisted a fresh PIN
  // (Settings → Security runs the two-step setup first). Turning it OFF clears
  // the record, so the flag and the record can never drift apart. Persistence
  // happens before the state change: a failed write must not leave the UI
  // claiming a preference the device didn't save.
  setLockEnabled: async (enabled) => {
    if (!enabled) {
      await clearPin();
    }
    await persistAppLockEnabled(enabled);
    set(
      enabled
        ? { lockEnabled: true, locked: false }
        : { lockEnabled: false, pinSet: false, locked: false, lastBackgroundedAt: null },
    );
  },

  lock: () => set({ locked: true }),

  unlock: () => set({ locked: false, lastBackgroundedAt: null }),

  markBackgrounded: (at = Date.now()) => set({ lastBackgroundedAt: at }),

  handleForeground: (now = Date.now()) => {
    const { lastBackgroundedAt, pinSet, lockEnabled } = get();
    if (shouldLockAfterBackground(lastBackgroundedAt, now, pinSet, lockEnabled)) {
      set({ locked: true });
    }
    // Clear the marker either way so a subsequent brief background doesn't
    // accumulate against a stale timestamp.
    set({ lastBackgroundedAt: null });
  },
}));

let appStateSubscribed = false;

// Subscribe once. Record a timestamp when the app truly backgrounds; on the
// return to 'active', re-lock if we were away longer than the threshold.
// 'inactive' (transient iOS states: control center, Face ID, app switcher) is
// intentionally ignored so those don't count as a background window.
function ensureAppStateListener(): void {
  if (appStateSubscribed) return;
  appStateSubscribed = true;
  AppState.addEventListener('change', (status: AppStateStatus) => {
    if (status === 'background') {
      usePinStore.getState().markBackgrounded();
    } else if (status === 'active') {
      usePinStore.getState().handleForeground();
    }
  });
}
