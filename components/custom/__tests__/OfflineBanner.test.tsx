/* eslint-disable @typescript-eslint/no-require-imports */
// OfflineBanner — the global connectivity band.
//
// The banner reads user-store (for needsReauth), which transitively imports the
// WatermelonDB singleton and its native SQLiteAdapter. Mock the DB seam so the
// module graph is importable under Jest — same pattern as apollo-client.test.ts.
jest.mock('@/lib/database/index', () => {
    const { makeDatabaseMock } = require('@/lib/__test-helpers__/mockDatabase');
    return makeDatabaseMock();
});

import { act, render } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (k: string) => k }),
}));

jest.mock('@/components/ui/hstack', () => {
    const { View } = require('react-native');
    return { HStack: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/text', () => {
    const { Text } = require('react-native');
    return { Text };
});
jest.mock('@/components/ui/icon', () => {
    const { View } = require('react-native');
    return { Icon: (p: any) => <View {...p} />, AlertCircleIcon: 'AlertCircleIcon' };
});

import OfflineBanner, { SHOW_DELAY_MS } from '@/components/custom/OfflineBanner';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';

const setNet = (s: Partial<{ isConnected: boolean; serverReachable: boolean; serverSlow: boolean }>) =>
    useNetworkStore.setState(s as never);

describe('OfflineBanner', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        setNet({ isConnected: true, serverReachable: true, serverSlow: false });
        useUserStore.setState({ needsReauth: false } as never);
    });
    afterEach(() => jest.useRealTimers());

    const advance = () => act(() => { jest.advanceTimersByTime(SHOW_DELAY_MS + 10); });

    it('stays hidden while everything is healthy', () => {
        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        expect(queryByTestId('offline-banner')).toBeNull();
    });

    it.each([
        ['device offline', { isConnected: false }],
        ['server unreachable', { serverReachable: false }],
        ['server slow', { serverSlow: true }],
    ])('shows for %s', (_label, state) => {
        setNet(state);
        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        expect(queryByTestId('offline-banner')).toBeTruthy();
    });

    it('does not paint before the show delay — a 300ms blip must not flash a band', () => {
        setNet({ isConnected: false });
        const { queryByTestId } = render(<OfflineBanner />);
        act(() => { jest.advanceTimersByTime(300); });
        expect(queryByTestId('offline-banner')).toBeNull();
    });

    it('hides INSTANTLY on recovery (asymmetric with the delayed show)', () => {
        setNet({ isConnected: false });
        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        expect(queryByTestId('offline-banner')).toBeTruthy();

        act(() => { setNet({ isConnected: true }); });
        expect(queryByTestId('offline-banner')).toBeNull();
    });

    // ── collision with ReauthBanner ──────────────────────────────────────
    // Both are absolutely positioned at the same coordinates; this one is
    // mounted at the ROOT so it paints over the /logged-in slot and would HIDE
    // the actionable banner rather than sit beside it.
    it('yields to ReauthBanner when the only complaint is slowness', () => {
        useUserStore.setState({ needsReauth: true } as never);
        setNet({ serverSlow: true });

        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        // Re-auth is completable on a merely-slow server, so the banner that
        // offers a way out must win.
        expect(queryByTestId('offline-banner')).toBeNull();
    });

    it('still shows when the server is genuinely unreachable, even with needsReauth', () => {
        // ReauthBanner hides itself here (it gates on useIsOnline), so there is
        // no collision — and this band carries the only explanation available.
        useUserStore.setState({ needsReauth: true } as never);
        setNet({ serverReachable: false });

        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        expect(queryByTestId('offline-banner')).toBeTruthy();
    });

    it('still shows when the device is offline, even with needsReauth', () => {
        useUserStore.setState({ needsReauth: true } as never);
        setNet({ isConnected: false });

        const { queryByTestId } = render(<OfflineBanner />);
        advance();
        expect(queryByTestId('offline-banner')).toBeTruthy();
    });
});
