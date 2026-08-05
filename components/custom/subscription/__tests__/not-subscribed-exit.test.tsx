/* eslint-disable @typescript-eslint/no-require-imports */
// not-subscribed-exit.test.tsx — leaving the paywall must leave the
// subscription store AGREEING with the server.
//
// The trap, which `lib/subscription/present-companion-paywall.ts` already
// documents for the companion surfaces: `deriveAiAccess` consults `serverTier`
// FIRST and reads 'none' as locked, so a store still holding the PRE-purchase
// 'none' outranks RevenueCat's freshly-updated customerInfo. This screen used to
// `router.replace('/logged-in')` without re-reading billing at all.
//
// That was survivable while /logged-in only ever chose between the feed and
// onboarding. It is not survivable now that the same gate routes a `locked`
// user BACK to this screen: a user who had genuinely just paid would be bounced
// paywall → /logged-in → paywall, forever.

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
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return { SafeAreaView: (p: any) => <View {...p} /> };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockReplace = jest.fn();
jest.mock('expo-router', () => ({ useRouter: () => ({ replace: (...a: any[]) => mockReplace(...a) }) }));

jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: { user: { id: 'u1' } }, isPending: false }) },
}));

const mockGetUserPersona = jest.fn(async () => ({}));
jest.mock('@/lib/account-service', () => ({
    AccountService: { getUserPersona: (...a: any[]) => mockGetUserPersona(...(a as [])) },
}));

// `isRevenueCatConfigured: false` keeps the auto-present effect inert, so these
// tests exercise the EXIT path in isolation.
jest.mock('@/lib/revenuecat', () => ({
    getCustomerInfoSafe: jest.fn(async () => null),
    getOfferingSafe: jest.fn(async () => null),
    isRevenueCatConfigured: () => false,
    logRevenueCatDiagnostics: jest.fn(async () => {}),
}));
jest.mock('react-native-purchases-ui', () => ({
    __esModule: true,
    default: { presentPaywall: jest.fn() },
    PAYWALL_RESULT: { PURCHASED: 'PURCHASED', RESTORED: 'RESTORED' },
}));

jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: { getState: () => ({ setCustomerInfo: jest.fn() }) },
}));
jest.mock('@/lib/database/services/setting-service', () => ({ setSetting: jest.fn(async () => {}) }));

const order: string[] = [];
const mockSyncEntitlement = jest.fn(async () => { order.push('sync'); });
jest.mock('@/lib/subscription/entitlement-sync', () => ({
    syncEntitlement: (...a: any[]) => mockSyncEntitlement(...(a as [])),
}));

import NotSubscribedScreen from '@/components/custom/auth/NotSubscribedScreen';

beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    mockReplace.mockImplementation((...a: any[]) => { order.push(`replace:${a[0]}`); });
    mockGetUserPersona.mockResolvedValue({});
});

describe('leaving the paywall for /logged-in', () => {
    it('forces an entitlement sync BEFORE handing back to the router gate', async () => {
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByText('account.refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockSyncEntitlement).toHaveBeenCalledWith({ force: true });
        // Ordering is the whole point: replacing first would hand /logged-in a
        // store that still says 'none'.
        expect(order).toEqual(['sync', 'replace:/logged-in']);
    });

    it('does not sync or leave while the server still refuses', async () => {
        mockGetUserPersona.mockRejectedValue(new Error('402'));
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByText('account.refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockSyncEntitlement).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('"Continue without a plan" records the dismissal and drops into companion mode', async () => {
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByText('companion.continueWithoutPlan'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        const { setSetting } = require('@/lib/database/services/setting-service');
        // The flag the pre-onboarding gate reads to decide 'companion' rather
        // than looping back to this screen.
        expect(setSetting).toHaveBeenCalledWith('companion_first_open_dismissed', 'true');
        expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });
});

export {};
