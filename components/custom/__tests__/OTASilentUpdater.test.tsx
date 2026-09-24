/* eslint-disable @typescript-eslint/no-require-imports */
// The whole OTA lifecycle: when it looks, and when a downloaded bundle is worth
// a restart. This is the app's only self-triggering restart, so the negatives
// here matter as much as the positives.
//
// THE OWNER'S COMPLAINT, which is the first thing this file pins: "the app
// refreshes every time it's foregrounded, even if it's at the latest version".
// A return with nothing pending must produce NO restart at all. A suite that
// only tested the positive would pass with that bug fully present.
//
// The arming cases came across from the deleted AppRestartOnForeground: they are
// still the riskiest lines in the file, they just live here now.

import { render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn() },
}));
jest.mock('@/lib/utils/transient-error', () => ({
    isTransientNetworkError: () => false,
}));

// Stubbed, and NOT optional: the real module lazy-requires setting-service,
// which imports the SQLite singleton at module scope.
const mockRequestRestart = jest.fn(async (_reason: string) => {});
const mockAlreadyAttempted = jest.fn(async (_id: string) => false);
const mockMarkAttempted = jest.fn(async (_id: string) => {});
jest.mock('@/lib/app-restart', () => ({
    requestRestart: (reason: string) => mockRequestRestart(reason),
    otaRestartAlreadyAttempted: (id: string) => mockAlreadyAttempted(id),
    markOtaRestartAttempted: (id: string) => mockMarkAttempted(id),
}));

const mockCheck = jest.fn();
const mockFetch = jest.fn();
const updatesState = { isEnabled: true };
// `latestContext` is a live module binding on the real package, reassigned by a
// native event. A getter is the only faithful stub.
const mockContext: { value: unknown } = { value: undefined };
jest.mock('expo-updates', () => ({
    get isEnabled() {
        return updatesState.isEnabled;
    },
    get latestContext() {
        return mockContext.value;
    },
    checkForUpdateAsync: (...a: unknown[]) => mockCheck(...a),
    fetchUpdateAsync: (...a: unknown[]) => mockFetch(...a),
}));

import { AppState, type AppStateStatus } from 'react-native';
import OTASilentUpdater from '../OTASilentUpdater';

// The effect awaits checkForUpdateAsync and THEN fetchUpdateAsync, so a couple
// of microtask ticks is not enough to observe the second call.
const flush = async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
};

/** The real union's success arm. */
const NEW_FETCH = { isNew: true, manifest: { id: 'update-new' }, isRollBackToEmbedded: false };
/** The failure arm. */
const NOTHING_FETCHED = { isNew: false, manifest: undefined, isRollBackToEmbedded: false };
/** A context with a downloaded update waiting to launch. */
const pendingContext = (id: string) => ({
    isUpdatePending: true,
    downloadedManifest: { id },
    sequenceNumber: 1,
});

/** The AppState handler the component registered on mount. */
let handler: ((state: AppStateStatus) => void) | null = null;
const remove = jest.fn();

describe('OTASilentUpdater', () => {
    // The effect is guarded by `!Updates.isEnabled || __DEV__`, and jest sets
    // __DEV__ TRUE — so without this override every assertion below would pass
    // vacuously against a component that short-circuited before doing anything.
    // That is the failure mode this whole file exists to catch, so it must not
    // be reintroduced by the harness itself.
    const realDev = (global as { __DEV__?: boolean }).__DEV__;
    beforeAll(() => {
        (global as { __DEV__?: boolean }).__DEV__ = false;
    });
    afterAll(() => {
        (global as { __DEV__?: boolean }).__DEV__ = realDev;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        handler = null;
        updatesState.isEnabled = true;
        mockContext.value = undefined;
        mockCheck.mockResolvedValue({ isAvailable: false });
        mockFetch.mockResolvedValue(NOTHING_FETCHED);
        mockAlreadyAttempted.mockResolvedValue(false);
        jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, h) => {
            handler = h as (state: AppStateStatus) => void;
            return { remove } as ReturnType<typeof AppState.addEventListener>;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    const mount = () => {
        const r = render(<OTASilentUpdater />);
        const send = async (...states: AppStateStatus[]) => {
            for (const state of states) handler?.(state);
            await flush();
        };
        return { ...r, send };
    };

    describe('checking', () => {
        // THE REGRESSION. Without an explicit call at mount, a device that simply
        // stays open never asks, and a published update reaches it only on the
        // next cold start via expo-updates' own launch check.
        it('checks on mount, without waiting for a foreground transition', async () => {
            mount();
            await flush();
            expect(mockCheck).toHaveBeenCalledTimes(1);
        });

        it('downloads the update when one is available', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mount();
            await flush();
            expect(mockFetch).toHaveBeenCalledTimes(1);
        });

        it('does not download when none is available', async () => {
            mount();
            await flush();
            expect(mockFetch).not.toHaveBeenCalled();
        });

        // `Updates.isEnabled` is false in a dev client and in any build without
        // expo-updates; asking there throws.
        it('does not ask at all when updates are disabled', async () => {
            updatesState.isEnabled = false;
            mount();
            await flush();
            expect(mockCheck).not.toHaveBeenCalled();
        });

        it('checks again on a return', async () => {
            const { send } = mount();
            await flush();
            await send('background', 'active');
            expect(mockCheck).toHaveBeenCalledTimes(2);
        });

        // A failed check must never take the app down — it runs on every return.
        it('survives a rejected check', async () => {
            mockCheck.mockRejectedValue(new Error('offline'));
            expect(() => mount()).not.toThrow();
            await flush();
        });
    });

    describe('what does NOT restart', () => {
        // THE OWNER'S ACTUAL COMPLAINT. A reader who switches away for three
        // seconds and comes back is on the current bundle and must be left alone.
        it('a return with nothing pending does not restart, at all', async () => {
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockCheck).toHaveBeenCalledTimes(2);
            expect(mockRequestRestart).not.toHaveBeenCalled();
            expect(mockMarkAttempted).not.toHaveBeenCalled();
        });

        // Restarting seconds into a launch buys nothing over expo-updates' own
        // launch-time check, and it is the one restart that can land on a
        // credential screen during onboarding.
        it('NEVER restarts on the mount check, even with a new bundle in hand', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mockFetch.mockResolvedValue(NEW_FETCH);
            mockContext.value = pendingContext('update-new');

            mount();
            await flush();

            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(mockRequestRestart).not.toHaveBeenCalled();
        });

        // Gate on the RESULT, not on the call resolving: the failure arm and the
        // roll-back arm both resolve with `isNew: false`.
        it('does not restart when the fetch produced nothing new', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockFetch).toHaveBeenCalledTimes(2);
            expect(mockRequestRestart).not.toHaveBeenCalled();
        });

        it('does not restart on a roll back to the embedded bundle', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mockFetch.mockResolvedValue({ isNew: false, manifest: undefined, isRollBackToEmbedded: true });
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockRequestRestart).not.toHaveBeenCalled();
        });

        // Nothing to bound a restart against, so it waits for the cold start.
        it('does not restart a pending update with no id', async () => {
            mockContext.value = { isUpdatePending: true, downloadedManifest: undefined, sequenceNumber: 1 };
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockRequestRestart).not.toHaveBeenCalled();
        });
    });

    describe('what DOES restart', () => {
        // Arm one: a download that completed on THIS transition, before the
        // native state-change event landed and wrote `latestContext`.
        it('restarts when this transition fetched a new bundle', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mockFetch.mockResolvedValue(NEW_FETCH);
            mockContext.value = pendingContext('update-new');
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockRequestRestart).toHaveBeenCalledWith('ota');
        });

        // Arm two: an update downloaded in an EARLIER session that never
        // launched. It is already pending at boot and needs no new fetch, so the
        // `isNew` arm never sees it — which is why the gate is an OR.
        it('restarts an update left pending from an earlier session, with no new fetch', async () => {
            mockContext.value = pendingContext('update-from-before');
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockFetch).not.toHaveBeenCalled();
            expect(mockRequestRestart).toHaveBeenCalledWith('ota');
        });

        // `isNew` is hardcoded true on the native loader's success arm, so it
        // means "a download completed", not "it differs from what is running".
        // The context arm is what makes the pending case work when it lags.
        it('restarts on isNew even when the context has not caught up', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mockFetch.mockResolvedValue(NEW_FETCH);
            mockContext.value = { isUpdatePending: false, downloadedManifest: { id: 'update-new' }, sequenceNumber: 0 };
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(mockRequestRestart).toHaveBeenCalledWith('ota');
        });
    });

    describe('the per-update-id guard', () => {
        it('records the attempt BEFORE requesting the restart', async () => {
            const order: string[] = [];
            mockMarkAttempted.mockImplementation(async () => { order.push('mark'); });
            mockRequestRestart.mockImplementation(async () => { order.push('restart'); });
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('background', 'active');

            expect(order).toEqual(['mark', 'restart']);
            expect(mockMarkAttempted).toHaveBeenCalledWith('update-x');
        });

        // THE BOUND. The OTA check is the only restart trigger left and it runs
        // on every return, so a bundle that reloads and fails to launch would
        // otherwise restart on every return for as long as it keeps downloading.
        it('restarts at most once per update id', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('background', 'active');
            expect(mockRequestRestart).toHaveBeenCalledTimes(1);

            mockAlreadyAttempted.mockResolvedValue(true);
            await send('background', 'active');
            await send('background', 'active');

            expect(mockRequestRestart).toHaveBeenCalledTimes(1);
        });

        it('restarts again for a DIFFERENT update id', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();
            await send('background', 'active');
            expect(mockRequestRestart).toHaveBeenCalledTimes(1);

            mockAlreadyAttempted.mockImplementation(async (id: string) => id === 'update-x');
            mockContext.value = pendingContext('update-y');
            await send('background', 'active');

            expect(mockRequestRestart).toHaveBeenCalledTimes(2);
            expect(mockMarkAttempted).toHaveBeenLastCalledWith('update-y');
        });
    });

    describe('arming', () => {
        // THE ONE THAT MATTERS MOST. iOS reports `inactive` for the app switcher,
        // a notification banner pulled down and a Control Centre swipe. None is a
        // departure, and arming on them restarts a user who never left, mid-tap.
        // `!== 'active'` is the single most likely later "simplification" here.
        it('does NOT restart on an inactive -> active transition', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('inactive', 'active');

            expect(mockRequestRestart).not.toHaveBeenCalled();
            expect(mockCheck).toHaveBeenCalledTimes(1);
        });

        it('does NOT restart on active -> inactive -> active with no background', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('active', 'inactive', 'active');

            expect(mockRequestRestart).not.toHaveBeenCalled();
        });

        // An `inactive` on the way OUT is the normal iOS sequence
        // (active -> inactive -> background), so it must not disarm what follows.
        it('restarts exactly once across the full iOS departure sequence', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('inactive', 'background', 'inactive', 'active');

            expect(mockRequestRestart).toHaveBeenCalledTimes(1);
        });

        // Disarmed on use: the second `active` is not a second return.
        it('arms once per departure', async () => {
            mockContext.value = pendingContext('update-x');
            const { send } = mount();
            await flush();

            await send('background', 'active', 'active');

            expect(mockCheck).toHaveBeenCalledTimes(2);
        });
    });

    describe('lifecycle', () => {
        it('removes the AppState subscription on unmount', async () => {
            const r = mount();
            await flush();
            expect(remove).not.toHaveBeenCalled();
            r.unmount();
            expect(remove).toHaveBeenCalledTimes(1);
        });

        // OTA updates are silent: downloading a bundle must produce no UI
        // whatsoever. This component previously rendered a non-dismissible
        // takeover modal here, on every publish. The expo-updates mock
        // deliberately exposes NO `useUpdates` — a component that renders nothing
        // has no reason to subscribe to update state, so reintroducing that
        // subscription to drive a banner fails loudly rather than quietly
        // rendering it.
        it('renders nothing, so a downloaded update is invisible to the user', async () => {
            mockCheck.mockResolvedValue({ isAvailable: true });
            mockFetch.mockResolvedValue(NEW_FETCH);
            const r = mount();
            await flush();
            expect(mockFetch).toHaveBeenCalledTimes(1);
            expect(r.toJSON()).toBeNull();
        });
    });
});
