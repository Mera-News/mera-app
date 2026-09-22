/* eslint-disable @typescript-eslint/no-require-imports */
// Settings -> Manage subscription, and specifically its RESTART HOLD.
//
// This is the app's primary purchase route (Profile -> Manage subscription ->
// View Plans), and every true background -> foreground return now reloads the
// app. Without the hold, the return that carries the user back from a purchase
// is the return that throws away `refreshUserBillingAfterPurchase` mid-retry:
// they paid and the app does not know. None of that produces an error anywhere,
// which is why the hold is asserted here rather than left to a device.
//
// Copy is asserted by KEY, never by English text — `t` is mocked to echo it.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('@/components/custom/AbstractGradientBackdrop', () => ({
    __esModule: true,
    default: () => null,
}));

// This screen uses RN's own ScrollView, not the gluestack one, and its native
// component spec is untranspiled ESM under this jest config
// (AndroidHorizontalScrollContentViewNativeComponent.js: "Unexpected token
// 'export'"). It throws on the post-loading render only, React unmounts the
// tree, and the visible failure is a missing testID plus
// `window.dispatchEvent is not a function` from React's own error reporter
// under `testEnvironment: 'node'` — naming neither ScrollView nor this file.
// Proxy so every other RN export stays lazy and real; same pattern as
// ManageDataScreen.test.tsx.
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    const StubScrollView = ({ children, ...rest }: any) =>
        ReactLib.createElement(actual.View, rest, children);
    StubScrollView.Context = ReactLib.createContext(null);
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') return StubScrollView;
            return (target as any)[prop];
        },
    });
});

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

// `i18n` as well as `t`: the screen reads `i18n.language` for its date
// formatting, and a `{ t }`-only stub throws during render — which React then
// reports through `window.dispatchEvent`, a function that does not exist under
// `testEnvironment: 'node'`. The visible failure is an unmounted tree and a
// missing testID, naming neither the real error nor this line.
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, opts?: any) => (opts ? `${k}:${JSON.stringify(opts)}` : k),
        i18n: { language: 'en' },
    }),
}));

jest.mock('react-native-safe-area-context', () => ({
    useSafeAreaInsets: () => ({ top: 0, bottom: 0, left: 0, right: 0 }),
}));

// --- gluestack ui + icons -> RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View testID="spinner" {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text } = require('react-native');
    return {
        Button: (p: any) => <Pressable testID="manage-view-plans" {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });
jest.mock('../../UsageWidget', () => ({ __esModule: true, default: () => null }));

// --- the hold under test ---------------------------------------------------
const mockImmediateRelease = jest.fn();
const mockHoldRestartAcrossPurchase = jest.fn((_label: string) => mockImmediateRelease);
jest.mock('@/lib/subscriptions/subscribe-flow', () => ({
    holdRestartAcrossPurchase: (label: string) => mockHoldRestartAcrossPurchase(label),
}));

// --- checkout collaborators, each recording its call ORDER -----------------
const order: string[] = [];
const mockEnsureEmail = jest.fn(async () => { order.push('ensureEmail'); return true; });
jest.mock('@/lib/subscription/email-capture', () => ({
    ensureEmailBeforeCheckout: () => mockEnsureEmail(),
}));

const mockPresentPaywall = jest.fn(async (_opts: any) => { order.push('presentPaywall'); return 'NOT_PRESENTED'; });
jest.mock('react-native-purchases-ui', () => ({
    __esModule: true,
    default: {
        presentPaywall: (opts: any) => mockPresentPaywall(opts),
        presentCustomerCenter: jest.fn(async () => {}),
    },
    PAYWALL_RESULT: {
        PURCHASED: 'PURCHASED',
        RESTORED: 'RESTORED',
        CANCELLED: 'CANCELLED',
        NOT_PRESENTED: 'NOT_PRESENTED',
        ERROR: 'ERROR',
    },
}));

const mockFetchUserBilling = jest.fn(async () => null);
const mockRefreshAfterPurchase = jest.fn(async () => { order.push('refreshBilling'); return null; });
jest.mock('@/lib/billing-service', () => ({
    fetchUserBilling: () => mockFetchUserBilling(),
    refreshUserBillingAfterPurchase: () => mockRefreshAfterPurchase(),
}));

jest.mock('@/lib/revenuecat', () => ({
    getActiveEntitlementInfo: () => null,
    getActiveTier: () => null,
    getCustomerInfoSafe: async () => null,
    getOfferingSafe: async () => null,
    logRevenueCatDiagnostics: async () => {},
}));

const mockSubscriptionState = {
    customerInfo: null,
    isPremium: false,
    setCustomerInfo: jest.fn(),
    setServerBilling: jest.fn(),
};
jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: Object.assign(
        (sel: any) => sel(mockSubscriptionState),
        { getState: () => mockSubscriptionState },
    ),
}));

jest.mock('@/lib/subscription/activation-toast', () => ({ showSubscriptionActivatedToast: jest.fn() }));
jest.mock('@/lib/subscription/plan-display', () => ({ resolvePlanDisplay: () => ({ name: 'Starter', tier: 'starter' }) }));
jest.mock('@/lib/subscription/plan-price', () => ({ formatPackagePrice: () => null, resolvePricePackage: () => null }));
jest.mock('../observability-labels', () => ({ humanizeKey: (k: string) => k }));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: { captureException: jest.fn(), debug: jest.fn(), info: jest.fn() },
}));

import logger from '@/lib/logger';
import ManageSubscriptionScreen from '../ManageSubscriptionScreen';

const mockLogger = logger as unknown as { captureException: jest.Mock };

const mountScreen = async () => {
    const r = render(<ManageSubscriptionScreen />);
    await waitFor(() => r.getByTestId('manage-view-plans'));
    return r;
};

beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    mockEnsureEmail.mockImplementation(async () => { order.push('ensureEmail'); return true; });
    mockPresentPaywall.mockImplementation(async () => { order.push('presentPaywall'); return 'NOT_PRESENTED'; });
});

describe('the restart hold on the primary purchase route', () => {
    it('is taken when the user taps View Plans', async () => {
        const r = await mountScreen();
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledTimes(1));
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledWith('purchase');
    });

    // AHEAD OF THE EMAIL GATE, not just ahead of the paywall. That gate sends
    // the user to their mail app for a code, which is a true departure on both
    // platforms — and the one that arrives back with a half-finished checkout
    // behind it.
    it('is taken BEFORE the email gate runs', async () => {
        const r = await mountScreen();
        mockHoldRestartAcrossPurchase.mockImplementation((_label: string) => {
            order.push('hold');
            return mockImmediateRelease;
        });

        fireEvent.press(r.getByTestId('manage-view-plans'));

        await waitFor(() => expect(order).toContain('presentPaywall'));
        expect(order[0]).toBe('hold');
        expect(order.indexOf('hold')).toBeLessThan(order.indexOf('ensureEmail'));
    });

    // THE REGRESSION THIS GUARDS. A `finally` release fires while
    // refreshUserBillingAfterPurchase is still retrying — precisely the window
    // the hold exists to cover. The release is timer-owned; the returned
    // function is an immediate release valid only where nothing was opened, and
    // this screen has no such path.
    it('never calls the immediate release, on any ending', async () => {
        const r = await mountScreen();

        // Bought.
        mockPresentPaywall.mockResolvedValue('PURCHASED');
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockRefreshAfterPurchase).toHaveBeenCalled());
        expect(mockImmediateRelease).not.toHaveBeenCalled();

        // Dismissed the paywall.
        mockPresentPaywall.mockResolvedValue('CANCELLED');
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockPresentPaywall).toHaveBeenCalledTimes(2));
        expect(mockImmediateRelease).not.toHaveBeenCalled();

        // Threw.
        mockPresentPaywall.mockRejectedValue(new Error('paywall blew up'));
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockLogger.captureException).toHaveBeenCalled());
        expect(mockImmediateRelease).not.toHaveBeenCalled();
    });

    // A dismissed email sheet aborts the checkout quietly, and the hold still
    // stands: that user is on their way back from their mail app.
    it('holds even when the email gate aborts the checkout', async () => {
        const r = await mountScreen();
        mockEnsureEmail.mockImplementation(async () => { order.push('ensureEmail'); return false; });

        fireEvent.press(r.getByTestId('manage-view-plans'));

        await waitFor(() => expect(mockEnsureEmail).toHaveBeenCalled());
        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledWith('purchase');
        expect(mockPresentPaywall).not.toHaveBeenCalled();
        expect(mockImmediateRelease).not.toHaveBeenCalled();
    });

    it('takes a fresh hold per attempt rather than reusing one', async () => {
        const r = await mountScreen();
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockPresentPaywall).toHaveBeenCalledTimes(1));
        fireEvent.press(r.getByTestId('manage-view-plans'));
        await waitFor(() => expect(mockPresentPaywall).toHaveBeenCalledTimes(2));

        expect(mockHoldRestartAcrossPurchase).toHaveBeenCalledTimes(2);
    });
});
