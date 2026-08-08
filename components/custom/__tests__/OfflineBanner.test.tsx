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

// Partial mock: keep the REAL store (useNetworkStore, useIsConnected, etc — so
// `setNet` below still drives the same instance the component reads) but stub
// the neutral probe. It hits real hosts over real fetch, which has no place in
// a unit test — the probe's own behavior (both hosts, http fallback, timeout)
// is covered directly in lib/stores/__tests__/network-store.test.ts.
const mockProbeInternetReachable = jest.fn(async (_timeoutMs?: number) => true);
jest.mock('@/lib/stores/network-store', () => {
    const actual = jest.requireActual('@/lib/stores/network-store');
    return {
        ...actual,
        probeInternetReachable: (timeoutMs?: number) => mockProbeInternetReachable(timeoutMs),
    };
});

import OfflineBanner, { SHOW_DELAY_MS } from '@/components/custom/OfflineBanner';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useUserStore } from '@/lib/stores/user-store';

const setNet = (
    s: Partial<{
        isConnected: boolean;
        serverReachable: boolean;
        serverSlow: boolean;
        internetReachable: boolean;
    }>,
) => useNetworkStore.setState(s as never);

describe('OfflineBanner', () => {
    beforeEach(() => {
        jest.useFakeTimers();
        setNet({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
        useUserStore.setState({ needsReauth: false } as never);
        mockProbeInternetReachable.mockClear();
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

    // ── the three-way fork ───────────────────────────────────────────────
    // One message used to cover all three states. Now each state gets its own
    // string, because "you're offline" and "Mera is down" point the user at
    // different fixes.
    describe('three-way copy fork', () => {
        it('device offline (isConnected: false) shows the offline string, regardless of internetReachable', () => {
            setNet({ isConnected: false, internetReachable: false });
            const { getByText } = render(<OfflineBanner />);
            advance();
            expect(getByText('common.offlineBannerOffline')).toBeTruthy();
        });

        it('link up but the neutral probe failed shows the internet-down string, not "Mera is down"', () => {
            setNet({ isConnected: true, serverReachable: false, internetReachable: false });
            const { getByText } = render(<OfflineBanner />);
            advance();
            expect(getByText('common.offlineBannerInternetDown')).toBeTruthy();
        });

        it('link up, internet fine, only the server unreachable shows the Mera-down string', () => {
            setNet({ isConnected: true, serverReachable: false, internetReachable: true });
            const { getByText } = render(<OfflineBanner />);
            advance();
            expect(getByText('common.offlineBannerServerDown')).toBeTruthy();
        });

        it('link up, internet fine, server merely slow ALSO shows the Mera-down string (not the internet-down one)', () => {
            setNet({ isConnected: true, serverSlow: true, internetReachable: true });
            const { getByText } = render(<OfflineBanner />);
            advance();
            expect(getByText('common.offlineBannerServerDown')).toBeTruthy();
        });
    });

    // ── firing the neutral probe ─────────────────────────────────────────
    describe('neutral-probe firing', () => {
        it('fires the probe once when there IS a link but something downstream is still wrong', () => {
            setNet({ isConnected: true, serverReachable: false });
            render(<OfflineBanner />);
            expect(mockProbeInternetReachable).toHaveBeenCalledTimes(1);
        });

        it('never fires the probe when the device is confirmed offline — that verdict is already certain', () => {
            setNet({ isConnected: false });
            render(<OfflineBanner />);
            expect(mockProbeInternetReachable).not.toHaveBeenCalled();
        });

        it('does not fire while healthy', () => {
            render(<OfflineBanner />);
            expect(mockProbeInternetReachable).not.toHaveBeenCalled();
        });

        it('re-fires on reconnect mid-episode so a stale verdict from before the drop is not reused', () => {
            setNet({ isConnected: false });
            const { rerender } = render(<OfflineBanner />);
            expect(mockProbeInternetReachable).not.toHaveBeenCalled();

            act(() => { setNet({ isConnected: true, serverReachable: false }); });
            rerender(<OfflineBanner />);
            expect(mockProbeInternetReachable).toHaveBeenCalledTimes(1);
        });
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
