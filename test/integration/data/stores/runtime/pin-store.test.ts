// pin-store with the real pin-service, app-lock-service, pin-force-reset and app-restart, over the
// stateful secure store and the real settings table (the restart marker is a settings row).
// Covers shouldLockAfterBackground, init on a COLD boot and on a RESTART boot, the restart hold,
// setLockEnabled and the foreground lock timing (setAppState on a strict clock).
// Replaces lib/stores/__tests__/pin-store.test.ts (which mocked all three security modules).
//
// `runPinForceResetOnce` runs inside init() and, on a store with no marker, clears the PIN and the
// lock flag. Every "lock on" case therefore stamps the marker first by running the real service once.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import Constants from 'expo-constants';
import logger from '@/lib/logger';
import * as appRestart from '@/lib/app-restart';
import {
  RESTART_MARKER_KEY,
  __resetAppRestartForTests,
  activeHolds,
  initRestartContext,
  requestRestart,
  wasJsRestartSync,
} from '@/lib/app-restart';
import { isAppLockEnabled, setAppLockEnabled } from '@/lib/security/app-lock-service';
import * as pinForceReset from '@/lib/security/pin-force-reset';
import { runPinForceResetOnce } from '@/lib/security/pin-force-reset';
import * as pinService from '@/lib/security/pin-service';
import { isPinSet, setPin } from '@/lib/security/pin-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import {
  BACKGROUND_LOCK_THRESHOLD_MS,
  shouldLockAfterBackground,
  usePinStore,
} from '@/lib/stores/pin-store';
import { advanceUntilDone, failSecureStore, healSecureStore, secureStoreDump, setAppState, useStrictClock } from '@/test/helpers';
import { resetStore, settle } from './support';

const NOW = Date.parse('2026-10-09T10:00:00.000Z');
const SLUG = Constants.expoConfig?.slug;
const FORCE_RESET_KEY = `${SLUG}_pin_force_reset_v1`;
const LOCK_FLAG_KEY = `${SLUG}_app_lock_enabled`;
const PIN_RECORD_KEY = `${SLUG}_pin_record`;
const MIN = 60_000;

const store = () => usePinStore.getState();

/** A device in the state a user leaves it in: the one-shot reset done, a PIN set, the lock opted into. */
async function seedLock(over: { pin?: boolean; lock?: boolean; resetDone?: boolean } = {}) {
  const { pin = true, lock = true, resetDone = true } = over;
  if (resetDone) await runPinForceResetOnce();
  if (pin) await setPin('1234');
  if (lock) await setAppLockEnabled(true);
}

/** The marker `requestRestart` writes, with the app away for `awayMs` before now (null: never left). */
const seedRestartMarker = (awayMs: number | null) =>
  setSetting(
    RESTART_MARKER_KEY,
    JSON.stringify({
      reason: 'ota',
      at: Date.now(),
      backgroundedAt: awayMs == null ? null : Date.now() - awayMs,
      lastForegroundAt: null,
    }),
  );

const spies: jest.SpyInstance[] = [];
const spy = <T extends object>(target: T, method: keyof T & string): jest.SpyInstance<Promise<unknown>, unknown[]> => {
  const s = jest.spyOn(target, method as never) as unknown as jest.SpyInstance<Promise<unknown>, unknown[]>;
  spies.push(s);
  return s;
};

describe('pin-store', () => {
  beforeEach(() => {
    useStrictClock(NOW);
    // The hold subscription is module-level: unlock first so it releases, THEN clear the restart
    // module (which empties its holds), then the store itself.
    usePinStore.setState({ locked: false });
    __resetAppRestartForTests();
    resetStore(usePinStore);
    setAppState('active');
  });
  afterEach(() => {
    for (const s of spies.splice(0)) s.mockRestore();
    delete process.env.EXPO_PUBLIC_RESTART_DEBUG;
  });

  describe('shouldLockAfterBackground', () => {
    const now = 1_000_000_000;
    const longAgo = now - (BACKGROUND_LOCK_THRESHOLD_MS + 1000);

    it('does not lock when the user has not opted into the lock', () => {
      expect(shouldLockAfterBackground(longAgo, now, true, false)).toBe(false);
    });
    it('does not lock without a PIN', () => {
      expect(shouldLockAfterBackground(longAgo, now, false, true)).toBe(false);
    });
    it('does not lock without a background timestamp', () => {
      expect(shouldLockAfterBackground(null, now, true, true)).toBe(false);
    });
    it('does not lock within the threshold, nor at exactly the threshold', () => {
      expect(shouldLockAfterBackground(now - (BACKGROUND_LOCK_THRESHOLD_MS - 1000), now, true, true)).toBe(false);
      expect(shouldLockAfterBackground(now - BACKGROUND_LOCK_THRESHOLD_MS, now, true, true)).toBe(false);
    });
    it('locks one millisecond past the threshold', () => {
      expect(shouldLockAfterBackground(now - BACKGROUND_LOCK_THRESHOLD_MS - 1, now, true, true)).toBe(true);
      expect(shouldLockAfterBackground(longAgo, now, true, true)).toBe(true);
    });
  });

  describe('init on a COLD boot', () => {
    it('lock on and a PIN set: pinSet, lockEnabled and locked, record untouched', async () => {
      await seedLock();

      await store().init();

      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true, initialized: true });
      expect(await isPinSet()).toBe(true);
    });

    it('lock off and no PIN (the default for everyone): not locked', async () => {
      await store().init();
      expect(store()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false, initialized: true });
    });

    it('lock on but no PIN record: not locked', async () => {
      await seedLock({ pin: false });
      await store().init();
      expect(store()).toMatchObject({ pinSet: false, lockEnabled: true, locked: false });
    });

    it('lock off but a stale PIN record (set back when it was mandatory): record cleared, not locked', async () => {
      await seedLock({ lock: false });
      expect(await isPinSet()).toBe(true);

      await store().init();

      expect(await isPinSet()).toBe(false);
      expect(store()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false });
    });

    it('is idempotent: a second call reads nothing again', async () => {
      await seedLock();
      await store().init();
      await setAppLockEnabled(false); // changed on disk after the first read
      await store().init();
      expect(store().lockEnabled).toBe(true);
      expect(store().locked).toBe(true);
    });
  });

  describe('init and the one-shot PIN reset', () => {
    it('runs the reset BEFORE reading the flags: a device with no marker boots with the gate off and the record gone', async () => {
      await seedLock({ resetDone: false });
      expect(await isPinSet()).toBe(true);
      expect(await isAppLockEnabled()).toBe(true);

      await store().init();

      // reading first would report lockEnabled and route the user to /pin-lock on the way through
      expect(store()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false, initialized: true });
      expect(await isPinSet()).toBe(false);
      expect(await isAppLockEnabled()).toBe(false);
      expect(secureStoreDump()[FORCE_RESET_KEY]).toBe('1');
    });

    it('a PIN set AFTER the reset survives every later launch', async () => {
      await store().init(); // the launch that stamps the marker
      resetStore(usePinStore);
      await setPin('1234');
      await setAppLockEnabled(true);

      await store().init();

      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true });
      expect(await isPinSet()).toBe(true);
    });

    it('an unreadable reset marker defers the reset instead of destroying a PIN the user chose', async () => {
      await seedLock({ resetDone: false });
      failSecureStore(FORCE_RESET_KEY, 'get');

      await store().init();

      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true });
      expect(secureStoreDump()[PIN_RECORD_KEY]).toBeDefined();
      expect(secureStoreDump()[FORCE_RESET_KEY]).toBeUndefined();
    });

    // runPinForceResetOnce is total by contract, so init's own catch is reachable only by making the
    // collaborator throw (R23: one call of a real export). A throwing reset must not discard the
    // reads: the gate is decided from them, and a lock that is on stays on.
    it('PE18 a reset that throws still leaves the gate decided from the reads (lock on, PIN set, locked)', async () => {
      await seedLock();
      const err = new Error('keychain');
      spy(pinForceReset, 'runPinForceResetOnce').mockRejectedValueOnce(err);

      await store().init();

      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true, initialized: true });
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'pin-store', method: 'init' } });
    });

    it('PE18 a PIN read that throws fails closed: the lock was on, so the gate stays engaged', async () => {
      await seedLock();
      const err = new Error('keychain locked');
      spy(pinService, 'readPinRecordState').mockRejectedValueOnce(err);

      await store().init();

      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true, initialized: true });
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'pin-store', method: 'init' } });
    });

    // PE20: a launch whose reads both fail. In the foreground init() re-reads, then fails closed; in
    // the background it defers and the next foreground re-reads (see test/integration/persona/pin.test.ts).
    // This one runs with AppState active, so init() takes the foreground path: the strict clock is
    // driven through its retry waits and the gate still ends locked.
    describe('a launch whose PIN reads failed (before first unlock)', () => {
      /** Lock on and a PIN set on disk; the launch cannot read either; then the keychain opens. */
      async function launchWithFailedReads() {
        await seedLock();
        failSecureStore(PIN_RECORD_KEY, 'get');
        failSecureStore(LOCK_FLAG_KEY, 'get');
        await advanceUntilDone(store().init());
        healSecureStore(PIN_RECORD_KEY);
        healSecureStore(LOCK_FLAG_KEY);
        setAppState('background');
        jest.setSystemTime(NOW + BACKGROUND_LOCK_THRESHOLD_MS + 1);
        setAppState('active');
        await settle();
      }

      test('PE20 a launch whose PIN reads failed re-reads them on the next foreground and locks', async () => {
        await launchWithFailedReads();
        expect(store().locked).toBe(true);
      });
    });
  });

  describe('init on a RESTART boot', () => {
    // Every background -> foreground return that restarts runs the marker read below. If it came back
    // empty the cold-start branch would engage and ask for the PIN on each return.
    it('reads and deletes the marker row at init() time', async () => {
      await seedLock();
      await seedRestartMarker(3_000);
      expect(await getSetting(RESTART_MARKER_KEY)).not.toBeNull();

      await store().init();

      expect(await getSetting(RESTART_MARKER_KEY)).toBeNull();
    });

    it('does NOT lock after a 3-second background', async () => {
      await seedLock();
      await seedRestartMarker(3_000);
      await store().init();
      expect(store().locked).toBe(false);
      expect(store()).toMatchObject({ pinSet: true, lockEnabled: true });
    });

    it('locks only past the threshold: not at exactly 5 minutes, yes one millisecond later', async () => {
      await seedLock();
      await seedRestartMarker(BACKGROUND_LOCK_THRESHOLD_MS);
      await store().init();
      expect(store().locked).toBe(false);

      __resetAppRestartForTests();
      resetStore(usePinStore);
      await seedRestartMarker(BACKGROUND_LOCK_THRESHOLD_MS + 1);
      await store().init();
      expect(store().locked).toBe(true);
    });

    it('LOCKS after a 10-minute background, so the threshold still bites', async () => {
      await seedLock();
      await seedRestartMarker(10 * MIN);
      await store().init();
      expect(store().locked).toBe(true);
    });

    it('a null background stamp means the user never left: an OTA restart fired in the foreground does not lock', async () => {
      await seedLock();
      await seedRestartMarker(null);
      await store().init();
      expect(store().locked).toBe(false);
    });

    it('with the lock off a restart boot is not locked however long the user was away', async () => {
      await seedLock({ pin: false, lock: false });
      await seedRestartMarker(60 * MIN);
      await store().init();
      expect(store().locked).toBe(false);
    });

    it('the marker is single-use: the next boot is a cold start and locks', async () => {
      await seedLock();
      await seedRestartMarker(3_000);
      await store().init();
      expect(store().locked).toBe(false);

      __resetAppRestartForTests();
      resetStore(usePinStore);
      await store().init();
      expect(store().locked).toBe(true);
    });

    it('shares one marker read with the root bootstrap: initRestartContext() and init() agree it is a restart', async () => {
      await seedLock();
      await seedRestartMarker(3_000);

      await Promise.all([initRestartContext(), store().init()]);

      expect(wasJsRestartSync()).toBe(true);
      expect(store().locked).toBe(false);
    });

    // Fail-closed: an unreadable marker must never be the reason a gate is open.
    it('an unparseable marker falls back to the cold-start lock and is reported', async () => {
      await seedLock();
      await setSetting(RESTART_MARKER_KEY, '{ not json');

      await store().init();

      expect(store().locked).toBe(true);
      expect(logger.captureException).toHaveBeenCalledWith(expect.any(Error), {
        tags: { module: 'app-restart', method: 'readMarker' },
      });
    });

    // restartContext() catches its own errors, so init's catch is reachable only through a
    // rejecting collaborator (R23).
    it('a restart context that rejects also falls back to the cold-start lock', async () => {
      await seedLock();
      const err = new Error('boom');
      spy(appRestart, 'restartContext').mockRejectedValueOnce(err);

      await store().init();

      expect(store().locked).toBe(true);
      expect(logger.captureException).toHaveBeenCalledWith(err, { tags: { store: 'pin-store', method: 'init-restart' } });
    });
  });

  describe('the restart hold', () => {
    // `locked` is in-memory only, so a reload recomputes it from the threshold. Without the hold a
    // locked user could step out to a password manager and come back UNLOCKED after the restart.
    it('is taken while the gate is engaged and released on unlock', async () => {
      await seedLock();

      await store().init();
      expect(store().locked).toBe(true);
      expect(activeHolds()).toEqual(['pin-lock']);

      store().unlock();
      expect(activeHolds()).toEqual([]);
    });

    it('is not taken when the gate is off', async () => {
      await store().init();
      expect(activeHolds()).toEqual([]);
    });

    it('is taken when the lock engages at runtime, once however often it engages', async () => {
      await seedLock();
      await store().init();
      store().unlock();
      expect(activeHolds()).toEqual([]);

      store().lock();
      store().lock();

      expect(activeHolds()).toEqual(['pin-lock']);
    });

    it('is released when a just-entered PIN unlocks through setPinSet', async () => {
      await seedLock();
      await store().init();
      expect(activeHolds()).toEqual(['pin-lock']);

      store().setPinSet(true);

      expect(store().locked).toBe(false);
      expect(activeHolds()).toEqual([]);
    });

    it('is taken again by a later lock after an unlock', async () => {
      await seedLock();
      await store().init();
      store().unlock();
      store().lock();
      expect(activeHolds()).toEqual(['pin-lock']);
    });

    it('is what makes requestRestart skip while locked, and a restart go ahead once unlocked', async () => {
      process.env.EXPO_PUBLIC_RESTART_DEBUG = 'true';
      await seedLock();
      await store().init();

      await requestRestart('ota');
      expect(logger.info).toHaveBeenCalledWith('[app-restart] would restart (ota, blocked-by: hold:pin-lock)');

      store().unlock();
      await requestRestart('ota');
      expect(logger.info).toHaveBeenCalledWith('[app-restart] would restart (ota, blocked-by: none)');
    });
  });

  describe('setLockEnabled', () => {
    it('turning the lock off clears the PIN record and the flag', async () => {
      await seedLock();
      await store().init();
      expect(store().locked).toBe(true);

      await store().setLockEnabled(false);

      expect(await isPinSet()).toBe(false);
      expect(await isAppLockEnabled()).toBe(false);
      expect(store()).toMatchObject({ lockEnabled: false, pinSet: false, locked: false, lastBackgroundedAt: null });
      expect(activeHolds()).toEqual([]);
    });

    it('turning the lock on persists the flag and leaves the PIN record alone', async () => {
      await seedLock({ lock: false });
      store().setPinSet(true); // the caller has just persisted a fresh PIN (Settings, Security)

      await store().setLockEnabled(true);

      expect(await isAppLockEnabled()).toBe(true);
      expect(await isPinSet()).toBe(true);
      expect(store()).toMatchObject({ lockEnabled: true, pinSet: true, locked: false });
    });

    it('a failed write leaves the store untouched, so the UI cannot claim an unsaved preference', async () => {
      await seedLock({ lock: false });
      failSecureStore(LOCK_FLAG_KEY, 'set', new Error('keychain unavailable'));

      await expect(store().setLockEnabled(true)).rejects.toThrow('keychain unavailable');

      expect(store().lockEnabled).toBe(false);
      expect(await isAppLockEnabled()).toBe(false);
    });
  });

  describe('foreground lock timing (AppState on a strict clock)', () => {
    /** An unlocked device with the lock opted into, the AppState listener wired. */
    async function unlockedDevice() {
      await seedLock();
      await store().init();
      store().unlock();
    }

    it('background then foreground past the threshold locks, and clears the marker', async () => {
      await unlockedDevice();

      setAppState('background');
      expect(store().lastBackgroundedAt).toBe(NOW);
      jest.setSystemTime(NOW + BACKGROUND_LOCK_THRESHOLD_MS + 1);
      setAppState('active');

      expect(store().locked).toBe(true);
      expect(store().lastBackgroundedAt).toBeNull();
      expect(activeHolds()).toEqual(['pin-lock']);
    });

    it('does not lock at exactly the threshold, nor after a brief background', async () => {
      await unlockedDevice();

      setAppState('background');
      jest.setSystemTime(NOW + BACKGROUND_LOCK_THRESHOLD_MS);
      setAppState('active');
      expect(store().locked).toBe(false);

      setAppState('background');
      jest.setSystemTime(Date.now() + 1000);
      setAppState('active');
      expect(store().locked).toBe(false);
    });

    it('a brief background does not accumulate against a stale timestamp', async () => {
      await unlockedDevice();

      setAppState('background');
      jest.setSystemTime(NOW + 1000);
      setAppState('active');
      jest.setSystemTime(NOW + BACKGROUND_LOCK_THRESHOLD_MS + 500);
      setAppState('background');
      jest.setSystemTime(Date.now() + 1000);
      setAppState('active');

      expect(store().locked).toBe(false);
    });

    it('"inactive" (control centre, app switcher) is not a background window', async () => {
      await unlockedDevice();

      setAppState('inactive');
      expect(store().lastBackgroundedAt).toBeNull();
      jest.setSystemTime(NOW + 10 * MIN);
      setAppState('active');

      expect(store().locked).toBe(false);
    });

    it('does not lock on foreground when the lock is off', async () => {
      await store().init(); // lock off, no PIN
      setAppState('background');
      jest.setSystemTime(NOW + 10 * MIN);
      setAppState('active');
      expect(store().locked).toBe(false);
    });

    it('markBackgrounded and handleForeground take explicit times', async () => {
      await unlockedDevice();
      const base = 5_000_000;

      store().markBackgrounded(base);
      store().handleForeground(base + BACKGROUND_LOCK_THRESHOLD_MS + 1);

      expect(store().locked).toBe(true);
      expect(store().lastBackgroundedAt).toBeNull();
    });

    it('unlock clears the locked flag and the background marker', async () => {
      await unlockedDevice();
      store().lock();
      store().markBackgrounded(123);

      store().unlock();

      expect(store().locked).toBe(false);
      expect(store().lastBackgroundedAt).toBeNull();
    });
  });
});
