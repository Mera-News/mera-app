import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';
import logger from '@/lib/logger';
import { isPinSet as readIsPinSet } from '@/lib/security/pin-service';

// Re-lock the app when it returns to the foreground after more than this long
// in the background. Cold start with a PIN set always locks.
export const BACKGROUND_LOCK_THRESHOLD_MS = 5 * 60_000;

/**
 * Pure lock-timing decision, extracted for unit testing. Locks only when a PIN
 * exists, we have a recorded background timestamp, and the gap exceeds the
 * threshold.
 */
export function shouldLockAfterBackground(
  lastBackgroundedAt: number | null,
  now: number,
  pinSet: boolean,
): boolean {
  if (!pinSet) return false;
  if (lastBackgroundedAt == null) return false;
  return now - lastBackgroundedAt > BACKGROUND_LOCK_THRESHOLD_MS;
}

interface PinState {
  pinSet: boolean;
  locked: boolean;
  lastBackgroundedAt: number | null;
  initialized: boolean;

  init: () => Promise<void>;
  setPinSet: (v: boolean) => void;
  lock: () => void;
  unlock: () => void;
  markBackgrounded: (at?: number) => void;
  handleForeground: (now?: number) => void;
}

export const usePinStore = create<PinState>()((set, get) => ({
  pinSet: false,
  locked: false,
  lastBackgroundedAt: null,
  initialized: false,

  // Reads the on-device PIN record and engages the lock on cold start when one
  // exists. Idempotent — safe to call from both the root layout and the launch
  // gate; the AppState listener is wired exactly once (see below).
  init: async () => {
    if (get().initialized) return;
    let pinSet = false;
    try {
      pinSet = await readIsPinSet();
    } catch (err) {
      logger.captureException(err, { tags: { store: 'pin-store', method: 'init' } });
    }
    set({
      pinSet,
      // Cold start with a PIN configured ⇒ locked until entry.
      locked: pinSet,
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

  lock: () => set({ locked: true }),

  unlock: () => set({ locked: false, lastBackgroundedAt: null }),

  markBackgrounded: (at = Date.now()) => set({ lastBackgroundedAt: at }),

  handleForeground: (now = Date.now()) => {
    const { lastBackgroundedAt, pinSet } = get();
    if (shouldLockAfterBackground(lastBackgroundedAt, now, pinSet)) {
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
