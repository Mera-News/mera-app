import { AppState, type AppStateStatus } from 'react-native';
import { create } from 'zustand';
import { holdRestart, restartContext, type RestartContext } from '@/lib/app-restart';
import logger from '@/lib/logger';
import {
  readAppLockState,
  setAppLockEnabled as persistAppLockEnabled,
} from '@/lib/security/app-lock-service';
import { clearPin, readPinRecordState } from '@/lib/security/pin-service';
import { runPinForceResetOnce } from '@/lib/security/pin-force-reset';

// Re-lock the app when it returns to the foreground after more than this long
// in the background. Cold start with the lock enabled always locks.
export const BACKGROUND_LOCK_THRESHOLD_MS = 5 * 60_000;

// A foreground launch whose keychain reads both fail re-reads this many more times, this far apart,
// before failing closed.
export const GATE_READ_RETRIES = 3;
export const GATE_READ_RETRY_MS = 500;

interface Gate {
  lockEnabled: boolean;
  pinSet: boolean;
}
const FAIL_CLOSED: Gate = { lockEnabled: true, pinSet: true };

const unreadable = (err: unknown) => {
  logger.captureException(err, { tags: { store: 'pin-store', method: 'init' } });
  return 'unreadable' as const;
};

/**
 * Reads the flag and the PIN record and decides the gate. An unreadable read is never taken as
 * "off" or "no PIN": the record is the tie-break (a record present means the lock was on, because
 * the lock-off path always deletes it). Returns null when both reads fail and nothing can be
 * decided. The one deletion is a record found under a flag that READ as off.
 */
async function readGate(): Promise<Gate | null> {
  const [record, flag] = await Promise.all([
    readPinRecordState().catch(unreadable),
    readAppLockState().catch(unreadable),
  ]);
  if (flag === 'unreadable') {
    if (record === 'unreadable') return null;
    return { lockEnabled: record === 'set', pinSet: record === 'set' };
  }
  if (flag === 'on') return { lockEnabled: true, pinSet: record !== 'absent' };
  // Invariant: lock off ⇒ no PIN record. This is what disables the gate for users who set a PIN
  // back when it was mandatory; drop the stale hash rather than keep one nobody can reach.
  if (record === 'set') await clearPin();
  return { lockEnabled: false, pinSet: false };
}

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
  /**
   * In memory only. init() ran in the background (before first unlock) and could read neither the
   * flag nor the record, so it committed "no lock" to defer; the next foreground re-reads.
   */
  unresolved: boolean;

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
  unresolved: false,

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
    // One-shot PIN gate reset (see pin-force-reset.ts). Deliberately BEFORE the reads below:
    // app/index.tsx awaits init() before resolveLaunchRoute, so a device cleared here reports
    // lockEnabled:false on the very launch that clears it and cannot be routed to /pin-lock on the
    // way through. Its own try, so a throwing reset never discards the reads.
    try {
      await runPinForceResetOnce();
    } catch (err) {
      logger.captureException(err, { tags: { store: 'pin-store', method: 'init' } });
    }

    // Both reads failing is a keychain that is not open yet. In the foreground that is worth a few
    // more tries, then it fails CLOSED (Forgot PIN on /pin-lock is the way out). In the background
    // (a wake before first unlock) the person cannot be looking at a PIN screen, so defer: commit
    // "no lock" and let the next foreground re-read (resolveUnresolved).
    const foreground = AppState.currentState === 'active';
    let gate = await readGate();
    for (let i = 0; gate == null && foreground && i < GATE_READ_RETRIES; i += 1) {
      await new Promise<void>((resolve) => setTimeout(resolve, GATE_READ_RETRY_MS));
      gate = await readGate();
    }
    const unresolved = gate == null && !foreground;
    const { lockEnabled, pinSet } = gate ?? (unresolved ? { lockEnabled: false, pinSet: false } : FAIL_CLOSED);
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
      unresolved,
    });
    syncRestartHold(get().locked);
    ensureRestartHoldSync();
    ensureAppStateListener();
  },

  setPinSet: (v) =>
    set({
      pinSet: v,
      unresolved: false,
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
        ? { lockEnabled: true, locked: false, unresolved: false }
        : { lockEnabled: false, pinSet: false, locked: false, lastBackgroundedAt: null, unresolved: false },
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

/**
 * NOTHING RESTARTS THE APP WHILE THE PIN GATE IS ENGAGED.
 *
 * `locked` IS IN-MEMORY ONLY: no persist helper, not in `hydrateAllStores`, and
 * `app/index.tsx` routes straight off it. So any JS reload destroys it and
 * `init()` rebuilds it from the background threshold alone — a reload while the
 * lock screen is up comes back with `locked: false` and lets the user in without
 * a PIN. That is the whole hazard, and it does not depend on what triggered the
 * reload.
 *
 * WHAT CAN TRIGGER ONE HERE: a downloaded OTA becoming pending. That is rarer
 * than the trigger this hold was first written against, and exactly as bad — the
 * reader is sitting on the lock screen, a bundle finishes downloading, and the
 * restart walks them past the gate. Rarer is not safer; it is harder to
 * reproduce.
 *
 * A HOLD RATHER THAN A ROUTE ENTRY, and both exist. The hold does not depend on
 * listener order or on which screen is showing, so it covers a restart requested
 * from anywhere while the gate is engaged. `/pin-lock` is also in
 * `RESTART_BLOCKED_ROUTES` (now checked inside `blockedBy()` in
 * lib/app-restart.ts, so it applies to every reason rather than one), which
 * covers the window before this subscription is wired. Do not delete either one
 * on the grounds that the other exists.
 *
 * The cost is that a restart requested while locked is DROPPED, not queued —
 * that is the deferral rule in lib/app-restart.ts and it is deliberate. Nothing
 * replays it; the update lands at the next cold start instead.
 */
let releaseRestartHold: (() => void) | null = null;

function syncRestartHold(locked: boolean): void {
  if (locked) {
    if (releaseRestartHold == null) releaseRestartHold = holdRestart('pin-lock');
    return;
  }
  if (releaseRestartHold != null) {
    releaseRestartHold();
    releaseRestartHold = null;
  }
}

let restartHoldSubscribed = false;

function ensureRestartHoldSync(): void {
  if (restartHoldSubscribed) return;
  restartHoldSubscribed = true;
  usePinStore.subscribe((state, prev) => {
    if (state.locked !== prev.locked) syncRestartHold(state.locked);
  });
}

// The first foreground after a deferred init(): read once more, decide with the same table, and set
// `locked` with cold-start semantics (the person has not passed the gate in this process). Still
// unreadable in the foreground fails closed, as init() does.
async function resolveUnresolved(): Promise<void> {
  const { lockEnabled, pinSet } = (await readGate()) ?? FAIL_CLOSED;
  usePinStore.setState({
    lockEnabled,
    pinSet,
    locked: lockEnabled && pinSet,
    lastBackgroundedAt: null,
    unresolved: false,
  });
}

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
      if (usePinStore.getState().unresolved) void resolveUnresolved();
      else usePinStore.getState().handleForeground();
    }
  });
}
