/* eslint-disable @typescript-eslint/no-require-imports */
// The fail-closed screen.
//
// THE LOAD-BEARING ABSENCE IN THIS FILE: there is no `@/lib/stores/user-store`
// mock and no persona mock, and there must never be one. `wipeAllLocalUserData`
// clears the database and only THEN resets Zustand, so on a DB failure — the
// only way to reach this screen — every in-memory store still holds the
// PREVIOUS user's data. If somebody adds a store read to the component, the
// real store's WatermelonDB adapter comes with it and this suite fails to even
// import. That failure is the guard working, not a missing mock.

import { act, fireEvent, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return { Button: (p: any) => <Pressable {...p} />, ButtonText: (p: any) => <Text {...p} /> };
});
jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return { SafeAreaView: (p: any) => <View {...p} /> };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), warn: jest.fn(), info: jest.fn() },
}));

const mockSignOutAndWipe = jest.fn(async () => {});
jest.mock('@/lib/security/local-wipe', () => ({ signOutAndWipe: () => mockSignOutAndWipe() }));

const mockSetBlocked = jest.fn((_v: boolean) => {});
jest.mock('@/lib/security/identity-gate', () => ({
    setIdentitySwitchBlocked: (v: boolean) => mockSetBlocked(v),
}));

import IdentitySwitchFailedScreen, {
    __resetIdentitySwitchRetriesForTests,
} from '../IdentitySwitchFailedScreen';

beforeEach(() => {
    jest.clearAllMocks();
    __resetIdentitySwitchRetriesForTests();
    mockSignOutAndWipe.mockResolvedValue(undefined);
});

describe('the blocking screen', () => {
    it('stands the layout watcher down while it is mounted, and back up on unmount', () => {
        // The ids genuinely disagree here — the exact condition the watcher
        // fires on — so without this it would navigate out from under a user
        // looking at an unrecoverable state.
        const { unmount } = render(<IdentitySwitchFailedScreen onRetry={jest.fn()} />);
        expect(mockSetBlocked).toHaveBeenCalledWith(true);

        unmount();
        expect(mockSetBlocked).toHaveBeenLastCalledWith(false);
    });

    it('retries the wipe through the caller, which owns the identity', () => {
        const onRetry = jest.fn();
        const { getByTestId } = render(<IdentitySwitchFailedScreen onRetry={onRetry} />);

        fireEvent.press(getByTestId('identity-switch-retry'));

        expect(onRetry).toHaveBeenCalledTimes(1);
    });

    it('bounds retries to 3 PER PROCESS — a remount does not refill the budget', () => {
        const onRetry = jest.fn();
        const first = render(<IdentitySwitchFailedScreen onRetry={onRetry} />);
        fireEvent.press(first.getByTestId('identity-switch-retry'));
        fireEvent.press(first.getByTestId('identity-switch-retry'));
        first.unmount();

        // Remounted: a per-mount counter would hand back three more attempts,
        // and each one resets the database.
        const second = render(<IdentitySwitchFailedScreen onRetry={onRetry} />);
        fireEvent.press(second.getByTestId('identity-switch-retry'));
        fireEvent.press(second.getByTestId('identity-switch-retry'));
        fireEvent.press(second.getByTestId('identity-switch-retry'));

        // Three across BOTH mounts, not three per mount. Asserted on the
        // callback rather than on a `disabled` prop: the button is disabled as
        // well, but a disabled prop that silently stopped being honoured would
        // still let the callback fire, and the callback is what resets the
        // database.
        expect(onRetry).toHaveBeenCalledTimes(3);
        expect(second.queryByText('auth.identitySwitchFailedExhausted')).toBeTruthy();
    });

    it('names the exhausted state instead of leaving a dead button', () => {
        const { getByTestId, queryByText } = render(
            <IdentitySwitchFailedScreen onRetry={jest.fn()} />,
        );
        expect(queryByText('auth.identitySwitchFailedExhausted')).toBeNull();

        for (let i = 0; i < 3; i++) fireEvent.press(getByTestId('identity-switch-retry'));

        expect(queryByText('auth.identitySwitchFailedExhausted')).toBeTruthy();
    });

    // THE ESCAPE. Never disabled — not while a retry is in flight, not once the
    // budget is spent. It is the only guaranteed way off this screen and it
    // works even when the wipe throws again, because signOutAndWipe navigates
    // before it erases.
    it('"Sign out and start over" stays enabled after the retry budget is spent', async () => {
        const { getByTestId } = render(<IdentitySwitchFailedScreen onRetry={jest.fn()} />);
        for (let i = 0; i < 3; i++) fireEvent.press(getByTestId('identity-switch-retry'));

        const signOut = getByTestId('identity-switch-sign-out');

        await act(async () => {
            fireEvent.press(signOut);
            await Promise.resolve();
        });

        expect(mockSignOutAndWipe).toHaveBeenCalledTimes(1);
    });

    it('a sign-out that throws is swallowed — the user is already out by then', async () => {
        mockSignOutAndWipe.mockRejectedValue(new Error('database is locked'));
        const { getByTestId } = render(<IdentitySwitchFailedScreen onRetry={jest.fn()} />);

        await act(async () => {
            fireEvent.press(getByTestId('identity-switch-sign-out'));
            await Promise.resolve();
        });

        const logger = require('@/lib/logger').default;
        expect(logger.captureException).toHaveBeenCalled();
    });

    it('renders only static copy', () => {
        const { queryByText } = render(<IdentitySwitchFailedScreen onRetry={jest.fn()} />);
        expect(queryByText('auth.identitySwitchFailedTitle')).toBeTruthy();
        expect(queryByText('auth.identitySwitchFailedBody')).toBeTruthy();
        expect(queryByText('auth.identitySwitchFailedWhy')).toBeTruthy();
    });
});

export {};
