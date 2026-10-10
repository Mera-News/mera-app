/* eslint-disable @typescript-eslint/no-require-imports -- the services are spied on the module object, so they are required */
// Owner ruling W1: an unreadable identity at launch waits and retries a few seconds on the launch
// screen before showing sign-in. Real settings service, in-memory DB and keychain fake; faults are
// injected at the two reads (getSetting, the cookie). The clock is strict, so a wait costs no wall time.
import Constants from 'expo-constants';
import { advanceUntilDone, failSecureStore, useFakeClock } from '@/test/helpers';
import {
    IDENTITY_READ_ATTEMPTS,
    IDENTITY_READ_RETRY_MS,
    readLocalIdentityStateSettled,
} from '@/lib/security/launch-route';

const settings = require('@/lib/database/services/setting-service') as typeof import('@/lib/database/services/setting-service');

const NOW = '2026-10-10T08:00:00.000Z';
const COOKIE = `${Constants.expoConfig?.slug || 'app'}_cookie`;

let getSettingSpy: jest.SpyInstance;
let timeoutSpy: jest.SpyInstance;
const waits = () => timeoutSpy.mock.calls.filter(([, ms]) => ms === IDENTITY_READ_RETRY_MS).length;

/** Runs the settled read under the strict clock; returns its state and the fake ms it took. */
async function settle() {
    const start = Date.now();
    const state = await advanceUntilDone(readLocalIdentityStateSettled());
    return { state, elapsed: Date.now() - start };
}

beforeEach(() => {
    useFakeClock(NOW);
    getSettingSpy = jest.spyOn(settings, 'getSetting');
    timeoutSpy = jest.spyOn(global, 'setTimeout');
});
afterEach(() => {
    getSettingSpy.mockRestore();
    timeoutSpy.mockRestore();
});

describe('readLocalIdentityStateSettled (owner ruling W1)', () => {
    it('a stamp present reads present with no wait', async () => {
        await settings.setSetting('cached_user_id', 'user-1');

        const { state } = await settle();

        expect(state).toBe('present');
        expect(waits()).toBe(0);
    });

    it('both reads complete and are empty: absent at once, no retry', async () => {
        const { state } = await settle();

        expect(state).toBe('absent');
        expect(waits()).toBe(0);
        expect(getSettingSpy).toHaveBeenCalledTimes(1);
    });

    it('unknown twice, then the stamp reads: present after exactly 2 waits and 3 reads', async () => {
        failSecureStore(COOKIE, 'get');
        // Reads 1 and 2 find an empty settings table while the keychain throws; read 3 finds the stamp.
        getSettingSpy.mockImplementation(async () => (getSettingSpy.mock.calls.length >= 3 ? 'user-1' : null));

        const { state, elapsed } = await settle();

        expect(state).toBe('present');
        expect(getSettingSpy).toHaveBeenCalledTimes(3);
        expect(waits()).toBe(2);
        expect(elapsed).toBe(2 * IDENTITY_READ_RETRY_MS);
    });

    it('unknown every time: unknown after IDENTITY_READ_ATTEMPTS reads, never absent', async () => {
        failSecureStore(COOKIE, 'get');

        const { state, elapsed } = await settle();

        expect(state).toBe('unknown');
        expect(getSettingSpy).toHaveBeenCalledTimes(IDENTITY_READ_ATTEMPTS);
        expect(waits()).toBe(IDENTITY_READ_ATTEMPTS - 1);
        expect(elapsed).toBe((IDENTITY_READ_ATTEMPTS - 1) * IDENTITY_READ_RETRY_MS);
    });
});
