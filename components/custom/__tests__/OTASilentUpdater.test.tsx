/* eslint-disable @typescript-eslint/no-require-imports */
// The silent updater only works if it ASKS. It used to register an AppState
// listener and nothing else — and `AppState.addEventListener('change', …)` fires
// on a TRANSITION, so with the app already `active` at mount nothing ran until
// the user backgrounded and returned. An app left open never checked at all.
//
// These tests pin two things: that the ask happens, and that NOTHING is
// rendered. The second is the regression test for making OTA updates silent —
// this component used to take the screen over with a non-dismissible modal on
// every single publish.

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
    default: { captureException: jest.fn() },
}));
jest.mock('@/lib/utils/transient-error', () => ({
    isTransientNetworkError: () => false,
}));

const mockCheck = jest.fn();
const mockFetch = jest.fn();
const updatesState = { isEnabled: true };
jest.mock('expo-updates', () => ({
    get isEnabled() {
        return updatesState.isEnabled;
    },
    checkForUpdateAsync: (...a: unknown[]) => mockCheck(...a),
    fetchUpdateAsync: (...a: unknown[]) => mockFetch(...a),
}));

import OTASilentUpdater from '../OTASilentUpdater';

// The effect awaits checkForUpdateAsync and THEN fetchUpdateAsync, so a couple
// of microtask ticks is not enough to observe the second call.
const flush = async () => {
    for (let i = 0; i < 12; i++) await Promise.resolve();
};

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
        updatesState.isEnabled = true;
        mockCheck.mockResolvedValue({ isAvailable: false });
        mockFetch.mockResolvedValue(undefined);
    });

    // THE REGRESSION. Without an explicit call at mount, a device that simply
    // stays open never asks, and a published update reaches it only on the next
    // cold start via expo-updates' own launch check.
    it('checks for an update on mount, without waiting for a foreground transition', async () => {
        render(<OTASilentUpdater />);
        await flush();
        expect(mockCheck).toHaveBeenCalledTimes(1);
    });

    it('downloads the update when one is available', async () => {
        mockCheck.mockResolvedValue({ isAvailable: true });
        render(<OTASilentUpdater />);
        await flush();
        expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it('does not download when none is available', async () => {
        render(<OTASilentUpdater />);
        await flush();
        expect(mockFetch).not.toHaveBeenCalled();
    });

    // `Updates.isEnabled` is false in a dev client and in any build without
    // expo-updates; asking there throws.
    it('does not ask at all when updates are disabled', async () => {
        updatesState.isEnabled = false;
        render(<OTASilentUpdater />);
        await flush();
        expect(mockCheck).not.toHaveBeenCalled();
    });

    // A failed check must never take the app down — it runs on every foreground.
    it('survives a rejected check', async () => {
        mockCheck.mockRejectedValue(new Error('offline'));
        expect(() => render(<OTASilentUpdater />)).not.toThrow();
        await flush();
    });

    // THE OTHER REGRESSION. OTA updates are silent: downloading a bundle must
    // produce no UI whatsoever. This component previously rendered a
    // non-dismissible takeover modal here, on every publish. Note the
    // expo-updates mock deliberately exposes NO `useUpdates` — a component that
    // renders nothing has no reason to subscribe to update state, and if someone
    // reintroduces that subscription to drive a banner, this file fails loudly
    // rather than quietly rendering it.
    it('renders nothing, so a downloaded update is invisible to the user', async () => {
        mockCheck.mockResolvedValue({ isAvailable: true });
        const tree = render(<OTASilentUpdater />);
        await flush();
        expect(mockFetch).toHaveBeenCalledTimes(1);
        expect(tree.toJSON()).toBeNull();
    });
});
