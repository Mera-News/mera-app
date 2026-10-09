// Seam test for the PIN lock: pin-service, app-lock-service, the one-shot force reset, the pin
// store's init() and the reauth handler (invariant 7). Real secure store, DB, SHA-256 and stores;
// the clock is the only thing faked.
import { createHash } from 'node:crypto';
import { act, renderHook } from '@testing-library/react-native';
import Constants from 'expo-constants';
import { router } from 'expo-router';
import { useReauthSuccess } from '@/components/custom/auth/useReauthSuccess';
import { __resetAppRestartForTests, activeHolds, requestRestart, restartContext } from '@/lib/app-restart';
import { setSetting } from '@/lib/database/services/setting-service';
import { isAppLockEnabled, setAppLockEnabled } from '@/lib/security/app-lock-service';
import { resolveLaunchRoute } from '@/lib/security/launch-route';
import { runPinForceResetOnce } from '@/lib/security/pin-force-reset';
import {
    changePin,
    clearPin,
    cooldownForFailCount,
    getCooldownRemainingMs,
    isPinSet,
    setPin,
    verifyPin,
} from '@/lib/security/pin-service';
import logger from '@/lib/logger';
import { usePinStore } from '@/lib/stores/pin-store';
import { secureStore } from '@/lib/utils/secure-store-adapter';
import { FIXTURE_ACCOUNT, failSecureStore, secureStoreDump, setAppState, useFakeClock } from '@/test/helpers';

// The restart marker is written by requestRestart, which only acts on a build with updates on.
jest.mock('expo-updates', () => ({ isEnabled: true, reloadAsync: jest.fn(async () => undefined) }));

const SLUG = Constants.expoConfig?.slug || 'app';
const RECORD_KEY = `${SLUG}_pin_record`;
const ATTEMPTS_KEY = `${SLUG}_pin_attempts`;
const LOCK_KEY = `${SLUG}_app_lock_enabled`;
const MARKER_KEY = `${SLUG}_pin_force_reset_v1`;
const MIN = 60_000;

const routerMock = () => router as unknown as { replace: jest.Mock };
const dump = () => secureStoreDump();

const PIN_STORE_DEFAULTS = {
    pinSet: false,
    lockEnabled: false,
    locked: false,
    lastBackgroundedAt: null,
    initialized: false,
};

/** A device that has opted in and set a PIN, after the one-shot reset has already run. */
async function enrolDevice(pin = '1234') {
    await runPinForceResetOnce();
    await setPin(pin);
    await setAppLockEnabled(true);
}

beforeEach(() => {
    jest.clearAllMocks();
    // pin-service narrates every call with a timing line.
    jest.spyOn(logger, 'info').mockImplementation(() => {});
    usePinStore.setState(PIN_STORE_DEFAULTS);
    __resetAppRestartForTests();
});

describe('pin-service', () => {
    it('isPinSet is false before and true after setPin', async () => {
        expect(await isPinSet()).toBe(false);
        await setPin('1234');
        expect(await isPinSet()).toBe(true);
    });

    it('verifies the correct PIN and rejects a wrong one, counting the miss', async () => {
        await setPin('4821');

        expect((await verifyPin('4821')).success).toBe(true);
        expect(await verifyPin('0000')).toMatchObject({ success: false, failCount: 1 });
    });

    it('stores a salted SHA-256 record and never the raw PIN', async () => {
        await setPin('1234');

        const record = JSON.parse(dump()[RECORD_KEY]);

        expect(Object.keys(record).sort()).toEqual(['algo', 'createdAt', 'hashHex', 'saltHex']);
        expect(record.algo).toBe('sha256-v1');
        expect(record.saltHex).toMatch(/^[0-9a-f]{32}$/);
        expect(typeof record.createdAt).toBe('number');
        expect(record.hashHex).toBe(createHash('sha256').update(`${record.saltHex}:1234`).digest('hex'));
    });

    it('draws a fresh salt per PIN, so equal PINs store different hashes', async () => {
        await setPin('1234');
        const first = JSON.parse(dump()[RECORD_KEY]);
        await setPin('1234');
        const second = JSON.parse(dump()[RECORD_KEY]);

        expect(second.saltHex).not.toBe(first.saltHex);
        expect(second.hashHex).not.toBe(first.hashHex);
    });

    it('a correct attempt resets the failure counter', async () => {
        await setPin('1234');
        await verifyPin('0000');
        await verifyPin('0000');

        const ok = await verifyPin('1234');

        expect(ok).toEqual({ success: true, failCount: 0 });
        expect(await getCooldownRemainingMs()).toBe(0);
        expect(dump()[ATTEMPTS_KEY]).toBeUndefined();
    });

    it('no record: a verify fails without arming anything', async () => {
        expect(await verifyPin('1234')).toEqual({ success: false, failCount: 0 });
        expect(dump()[ATTEMPTS_KEY]).toBeUndefined();
    });

    it('an unreadable record reads as no PIN set', async () => {
        await setPin('1234');
        failSecureStore(RECORD_KEY, 'get');

        expect(await isPinSet()).toBe(false);
    });

    describe('cooldown', () => {
        it('only arms on multiples of 5, escalating 30s, 60s, 5min', () => {
            expect(cooldownForFailCount(0)).toBe(0);
            expect(cooldownForFailCount(1)).toBe(0);
            expect(cooldownForFailCount(4)).toBe(0);
            expect(cooldownForFailCount(5)).toBe(30_000);
            expect(cooldownForFailCount(9)).toBe(0);
            expect(cooldownForFailCount(10)).toBe(60_000);
            expect(cooldownForFailCount(15)).toBe(5 * MIN);
            expect(cooldownForFailCount(20)).toBe(5 * MIN);
        });

        it('locks for 30s at 5 misses, 60s at 10 and 5min at 15, refusing even the right PIN meanwhile', async () => {
            useFakeClock(Date.now());
            await setPin('1234');
            const miss = async (n: number) => {
                let last = await verifyPin('0000');
                for (let i = 1; i < n; i += 1) last = await verifyPin('0000');
                return last;
            };

            const fourth = await miss(4);
            expect(fourth).toMatchObject({ failCount: 4, lockedUntil: undefined, remainingMs: undefined });

            const fifth = await miss(1);
            expect(fifth.failCount).toBe(5);
            expect(fifth.remainingMs).toBeGreaterThan(29_000);
            expect(fifth.remainingMs).toBeLessThanOrEqual(30_000);
            expect(fifth.lockedUntil).toBeGreaterThan(Date.now());

            // Locked: the correct PIN is refused and the counter does not move.
            const during = await verifyPin('1234');
            expect(during).toMatchObject({ success: false, failCount: 5 });
            expect(during.remainingMs).toBeGreaterThan(0);

            jest.advanceTimersByTime(30_001);
            expect(await getCooldownRemainingMs()).toBe(0);
            const tenth = await miss(5);
            expect(tenth.failCount).toBe(10);
            expect(tenth.remainingMs).toBeGreaterThan(59_000);
            expect(tenth.remainingMs).toBeLessThanOrEqual(60_000);

            jest.advanceTimersByTime(60_001);
            const fifteenth = await miss(5);
            expect(fifteenth.failCount).toBe(15);
            expect(fifteenth.remainingMs).toBeGreaterThan(5 * MIN - 1_000);
            expect(fifteenth.remainingMs).toBeLessThanOrEqual(5 * MIN);

            // Past the last lock, a 16th miss arms nothing; the right PIN then clears the count.
            jest.advanceTimersByTime(5 * MIN + 1);
            expect(await miss(1)).toMatchObject({ failCount: 16, lockedUntil: undefined });
            expect(await verifyPin('1234')).toEqual({ success: true, failCount: 0 });
        });

        it('persists the attempt state in the keychain, so a relaunch cannot reset it', async () => {
            await setPin('1234');
            for (let i = 0; i < 5; i += 1) await verifyPin('0000');

            const persisted = JSON.parse(dump()[ATTEMPTS_KEY]);

            expect(persisted.failCount).toBe(5);
            expect(persisted.lockedUntil).toBeGreaterThan(Date.now());
            expect(await getCooldownRemainingMs()).toBeGreaterThan(0);
        });

        it('lifts after the cooldown, then allows entry', async () => {
            useFakeClock(Date.now());
            await setPin('1234');
            for (let i = 0; i < 5; i += 1) await verifyPin('0000');

            jest.advanceTimersByTime(30_001);

            expect(await getCooldownRemainingMs()).toBe(0);
            expect((await verifyPin('1234')).success).toBe(true);
        });
    });

    describe('changePin', () => {
        it('rejects when the current PIN is wrong, and the old PIN still works', async () => {
            await setPin('1111');

            const res = await changePin('9999', '2222');

            expect(res).toMatchObject({ success: false, result: { success: false, failCount: 1 } });
            expect((await verifyPin('1111')).success).toBe(true);
        });

        it('changes the PIN when the current PIN is correct', async () => {
            await setPin('1111');

            expect(await changePin('1111', '2222')).toEqual({ success: true });

            expect((await verifyPin('2222')).success).toBe(true);
            expect((await verifyPin('1111')).success).toBe(false);
        });
    });

    describe('records from before sha256-v1', () => {
        const legacy = (extra: object = {}) =>
            JSON.stringify({ saltHex: 'aa'.repeat(16), hashHex: 'bb'.repeat(32), createdAt: Date.now(), ...extra });
        const seed = (value: string) => secureStore.setItemAsync(RECORD_KEY, value);

        it('isPinSet treats an algo-mismatched record as if no PIN were set', async () => {
            await seed(legacy());
            expect(await isPinSet()).toBe(false);
        });

        it('verifyPin rejects it without burning an attempt or arming a cooldown', async () => {
            await seed(legacy());

            const res = await verifyPin('1234');

            expect(res).toEqual({ success: false, failCount: 0 });
            expect(dump()[ATTEMPTS_KEY]).toBeUndefined();
        });

        it('an explicit non-current algo is treated the same as a missing one', async () => {
            await seed(legacy({ algo: 'scrypt-legacy' }));

            expect(await isPinSet()).toBe(false);
            expect((await verifyPin('1234')).success).toBe(false);
        });

        it('self-heals: setPin after a legacy record overwrites it with the current algo', async () => {
            await seed(legacy());

            await setPin('1234');

            expect(await isPinSet()).toBe(true);
            expect((await verifyPin('1234')).success).toBe(true);
            expect(JSON.parse(dump()[RECORD_KEY]).algo).toBe('sha256-v1');
        });
    });

    it('clearPin removes the record and the attempt state', async () => {
        await setPin('1234');
        await verifyPin('0000');
        expect(dump()[ATTEMPTS_KEY]).toBeDefined();

        await clearPin();

        expect(await isPinSet()).toBe(false);
        expect(dump()[RECORD_KEY]).toBeUndefined();
        expect(dump()[ATTEMPTS_KEY]).toBeUndefined();
    });
});

describe('app-lock-service', () => {
    it('is off when the key has never been written (the lock is opt-in)', async () => {
        expect(await isAppLockEnabled()).toBe(false);
    });

    it('round-trips both values', async () => {
        await setAppLockEnabled(true);
        expect(await isAppLockEnabled()).toBe(true);
        await setAppLockEnabled(false);
        expect(await isAppLockEnabled()).toBe(false);
    });

    it('writes under an app-slug-scoped key', async () => {
        await setAppLockEnabled(true);

        expect(Object.keys(dump())).toEqual([LOCK_KEY]);
        expect(dump()[LOCK_KEY]).toBe('1');
    });

    it('treats any unrecognised stored value as off', async () => {
        await secureStore.setItemAsync(LOCK_KEY, 'true');

        expect(await isAppLockEnabled()).toBe(false);
    });

    it('fails open (off) on a read error rather than stranding the user', async () => {
        await setAppLockEnabled(true);
        failSecureStore(LOCK_KEY, 'get', new Error('keychain unavailable'));

        expect(await isAppLockEnabled()).toBe(false);
    });

    it('propagates a write failure so the caller can keep the UI honest', async () => {
        failSecureStore(LOCK_KEY, 'set', new Error('keychain unavailable'));

        await expect(setAppLockEnabled(true)).rejects.toThrow('keychain unavailable');
    });
});

describe('runPinForceResetOnce', () => {
    /** An enrolled device with the one-shot not yet run: the state being reset. */
    async function enrolBeforeReset() {
        await setPin('1234');
        await setAppLockEnabled(true);
        expect(await isPinSet()).toBe(true);
        expect(await isAppLockEnabled()).toBe(true);
    }

    it('clears the PIN record and the opt-in flag on an enrolled device, and stamps the marker', async () => {
        await enrolBeforeReset();

        await runPinForceResetOnce();

        expect(await isPinSet()).toBe(false);
        expect(await isAppLockEnabled()).toBe(false);
        expect(dump()[RECORD_KEY]).toBeUndefined();
        expect(dump()[MARKER_KEY]).toBe('1');
    });

    it('is a no-op on a device that never had a PIN, and still stamps', async () => {
        await runPinForceResetOnce();

        expect(await isPinSet()).toBe(false);
        expect(await isAppLockEnabled()).toBe(false);
        expect(dump()[MARKER_KEY]).toBe('1');
    });

    it('runs once per marker: a PIN set AFTER the reset survives the next call', async () => {
        await enrolBeforeReset();
        await runPinForceResetOnce();
        await enrolBeforeReset(); // the user opts back in via Settings

        await runPinForceResetOnce();

        expect(await isPinSet()).toBe(true);
        expect(await isAppLockEnabled()).toBe(true);
    });

    it('leaves the marker unstamped when a write fails, so the next launch retries', async () => {
        await enrolBeforeReset();
        failSecureStore(LOCK_KEY, 'set');

        await runPinForceResetOnce();

        expect(dump()[MARKER_KEY]).toBeUndefined();
    });

    it('completes on the next launch once the marker write has failed once', async () => {
        await enrolBeforeReset();
        // One failure injected on a real object: the marker is the only write that fails.
        const original = secureStore.setItemAsync;
        const spy = jest.spyOn(secureStore, 'setItemAsync').mockImplementation(async (k: string, v: string) => {
            if (k === MARKER_KEY) throw new Error('keychain unavailable');
            return original(k, v);
        });

        await runPinForceResetOnce();
        expect(dump()[MARKER_KEY]).toBeUndefined();

        spy.mockRestore();
        await runPinForceResetOnce();
        expect(dump()[MARKER_KEY]).toBe('1');
        expect(await isAppLockEnabled()).toBe(false);
    });

    it('defers rather than resetting when the marker is unreadable', async () => {
        await enrolBeforeReset();
        await runPinForceResetOnce();
        await enrolBeforeReset();
        failSecureStore(MARKER_KEY, 'get', new Error('keychain locked'));

        await runPinForceResetOnce();

        expect(await isPinSet()).toBe(true);
        expect(await isAppLockEnabled()).toBe(true);
    });

    it('never throws, so it cannot block the launch gate', async () => {
        failSecureStore(MARKER_KEY, 'get');
        await expect(runPinForceResetOnce()).resolves.toBeUndefined();
    });

    it('never throws when the marker write fails either', async () => {
        failSecureStore(MARKER_KEY, 'set');
        await expect(runPinForceResetOnce()).resolves.toBeUndefined();
    });
});

describe('pin-store init()', () => {
    it('drops a PIN record found while the lock is off (a PIN from the mandatory era)', async () => {
        await runPinForceResetOnce();
        await setPin('1234'); // a record, no opt-in flag

        await usePinStore.getState().init();

        expect(usePinStore.getState()).toMatchObject({
            pinSet: false,
            lockEnabled: false,
            locked: false,
            initialized: true,
        });
        expect(dump()[RECORD_KEY]).toBeUndefined();
    });

    it('runs the one-shot reset first, so a device it clears reports the lock off on that very launch', async () => {
        await setPin('1234');
        await setAppLockEnabled(true);

        await usePinStore.getState().init();

        expect(usePinStore.getState()).toMatchObject({ pinSet: false, lockEnabled: false, locked: false });
        expect(dump()[MARKER_KEY]).toBe('1');
    });

    it('a cold start with the lock on and a PIN set is locked, and the gate holds restarts off', async () => {
        await enrolDevice();

        await usePinStore.getState().init();

        expect(usePinStore.getState()).toMatchObject({ pinSet: true, lockEnabled: true, locked: true, initialized: true });
        expect(activeHolds()).toContain('pin-lock');
        expect(
            resolveLaunchRoute({ hasIdentity: true, ...usePinStore.getState() }),
        ).toBe('/pin-lock');
    });

    it('is idempotent: a second init() reads nothing again', async () => {
        await enrolDevice();
        await usePinStore.getState().init();
        usePinStore.getState().unlock();
        await clearPin();

        await usePinStore.getState().init();

        expect(usePinStore.getState()).toMatchObject({ pinSet: true, locked: false });
    });

    describe('after a JS restart', () => {
        beforeEach(() => {
            useFakeClock(Date.now());
        });

        /**
         * Leaves the marker a real restart would: departure tracking armed, the app backgrounded
         * `awayMs` ago (none when null), then requestRestart('ota') writing the settings row.
         */
        async function restartedAfter(awayMs: number | null) {
            (global as { __DEV__?: boolean }).__DEV__ = false;
            try {
                await restartContext();
                if (awayMs !== null) {
                    setAppState('background');
                    jest.advanceTimersByTime(awayMs);
                    setAppState('active');
                }
                await requestRestart('ota');
            } finally {
                (global as { __DEV__?: boolean }).__DEV__ = true;
            }
            // The next process: empty memory, the marker still on disk.
            __resetAppRestartForTests();
            usePinStore.setState(PIN_STORE_DEFAULTS);
        }

        it('locks when the app was away longer than the threshold', async () => {
            await enrolDevice();
            await restartedAfter(6 * MIN);

            await usePinStore.getState().init();

            // The restart path ran: the marker was read, with the departure stamp it carried.
            const context = await restartContext();
            expect(context.wasJsRestart).toBe(true);
            expect(context.backgroundedAt).not.toBeNull();
            expect(usePinStore.getState().locked).toBe(true);
        });

        it('does not lock for a short absence', async () => {
            await enrolDevice();
            await restartedAfter(MIN);

            await usePinStore.getState().init();

            expect((await restartContext()).wasJsRestart).toBe(true);
            expect(usePinStore.getState()).toMatchObject({ pinSet: true, lockEnabled: true, locked: false });
        });

        it('does not lock a restart that happened while the reader never left', async () => {
            await enrolDevice();
            await restartedAfter(null);

            await usePinStore.getState().init();

            expect(await restartContext()).toMatchObject({ wasJsRestart: true, backgroundedAt: null });
            expect(usePinStore.getState().locked).toBe(false);
        });

        it('a real cold start (no marker) still locks at once', async () => {
            await enrolDevice();

            await usePinStore.getState().init();

            expect(usePinStore.getState().locked).toBe(true);
        });
    });
});

describe('useReauthSuccess (invariant 7: the lock is opt-in, and only Forgot PIN reaches /pin-setup)', () => {
    const ME = FIXTURE_ACCOUNT.userId;
    const OTHER = 'bbbbbbbbbbbbbbbbbbbbbbbb';

    async function enrolAs(cachedUserId: string | null) {
        await enrolDevice();
        await usePinStore.getState().setLockEnabled(true);
        usePinStore.getState().setPinSet(true);
        if (cachedUserId) await setSetting('cached_user_id', cachedUserId);
    }

    async function verified(reauth: string | undefined, userId: string) {
        const { result } = renderHook(() => useReauthSuccess(reauth));
        await act(async () => {
            await result.current(userId);
        });
    }

    it("reauth='1' for the same user goes to /logged-in with the PIN intact and no /pin-setup", async () => {
        await enrolAs(ME);

        await verified('1', ME);

        expect(routerMock().replace).toHaveBeenCalledTimes(1);
        expect(routerMock().replace).toHaveBeenCalledWith('/logged-in');
        expect(await isPinSet()).toBe(true);
        expect(await isAppLockEnabled()).toBe(true);
        expect(usePinStore.getState()).toMatchObject({ pinSet: true, lockEnabled: true });
    });

    it('no reauth param behaves like the session reauths: /logged-in, PIN untouched', async () => {
        await enrolAs(ME);

        await verified(undefined, ME);

        expect(routerMock().replace).toHaveBeenCalledWith('/logged-in');
        expect(await isPinSet()).toBe(true);
    });

    it("reauth='pin' for the same user clears the PIN, leaves the lock opted in, and goes to /pin-setup", async () => {
        await enrolAs(ME);

        await verified('pin', ME);

        expect(routerMock().replace).toHaveBeenCalledTimes(1);
        expect(routerMock().replace).toHaveBeenCalledWith('/pin-setup');
        expect(await isPinSet()).toBe(false);
        expect(usePinStore.getState().pinSet).toBe(false);
        // A forgotten PIN is replaced, not silently downgraded to no lock.
        expect(await isAppLockEnabled()).toBe(true);
        expect(usePinStore.getState().lockEnabled).toBe(true);
    });

    it.each(['1', 'pin', undefined])(
        'a different user (reauth=%s) turns the lock off and goes to /logged-in, never /pin-setup',
        async (reauth) => {
            await enrolAs(ME);

            await verified(reauth, OTHER);

            expect(routerMock().replace).toHaveBeenCalledTimes(1);
            expect(routerMock().replace).toHaveBeenCalledWith('/logged-in');
            expect(await isAppLockEnabled()).toBe(false);
            expect(await isPinSet()).toBe(false);
            expect(usePinStore.getState()).toMatchObject({ lockEnabled: false, pinSet: false });
        },
    );

    it('no cached user id counts as a different user: lock off, /logged-in', async () => {
        await enrolAs(null);

        await verified('pin', ME);

        expect(routerMock().replace).toHaveBeenCalledWith('/logged-in');
        expect(await isAppLockEnabled()).toBe(false);
        expect(await isPinSet()).toBe(false);
    });
});

describe('an unreadable PIN record at launch', () => {
    /** Lock on, PIN set, then the record's keychain slot refuses reads for a fresh store and init(). */
    async function launchWithUnreadableRecord() {
        await enrolDevice();
        failSecureStore(RECORD_KEY, 'get');
        usePinStore.setState(PIN_STORE_DEFAULTS);
        await usePinStore.getState().init();
        return resolveLaunchRoute({ hasIdentity: true, ...usePinStore.getState() });
    }

    test.failing('B8 an unreadable PIN record keeps the lock engaged', async () => {
        expect(await launchWithUnreadableRecord()).toBe('/pin-lock');
    });

    test('B8 today: an unreadable PIN record reads as no PIN, so the launch goes straight in', async () => {
        expect(await launchWithUnreadableRecord()).toBe('/logged-in');
        expect(usePinStore.getState()).toMatchObject({ lockEnabled: true, pinSet: false, locked: false });
        // Nothing was deleted: the record is still there once the keychain heals.
        expect(dump()[RECORD_KEY]).toBeDefined();
    });
});
