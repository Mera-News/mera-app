/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

// css-interop JSX shim (reads Platform.OS at module load) — same as other tests.
jest.mock('react-native-css-interop/jsx-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-runtime');
    return { jsx: ReactJSXRuntime.jsx, jsxs: ReactJSXRuntime.jsxs, Fragment: ReactJSXRuntime.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const ReactJSXRuntime = require('react/jsx-dev-runtime');
    return { jsxDEV: ReactJSXRuntime.jsxDEV, Fragment: ReactJSXRuntime.Fragment };
});

jest.mock('react-i18next', () => ({
    useTranslation: () => ({ t: (_k: string, o?: any) => o?.defaultValue ?? _k }),
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: unknown[]) => mockRouterPush(...a) },
    useFocusEffect: (cb: () => void) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));

// jest-expo mis-transforms RN's ScrollView native-component file ("Unexpected
// token 'export'"). Proxy RN so ScrollView renders as a plain View; every other
// export stays lazy/real (our ui mocks read View/Text/Pressable/Modal).
jest.mock('react-native', () => {
    const actual = jest.requireActual('react-native');
    const ReactLib = require('react');
    return new Proxy(actual, {
        get(target, prop) {
            if (prop === 'ScrollView') {
                return ({ children, ...rest }: any) => ReactLib.createElement(actual.View, rest, children);
            }
            return (target as any)[prop];
        },
    });
});

// --- gluestack ui + icons → RN primitives ---------------------------------
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/hstack', () => { const { View } = require('react-native'); return { HStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text, View } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
        // `ButtonIcon` was missing here, so the "Learn about Mera" button in the
        // heading row rendered `undefined` and took the whole screen down with an
        // "Element type is invalid" — a factory mock replaces the WHOLE module,
        // so any export it omits resolves to undefined rather than falling back.
        ButtonIcon: (p: any) => <View {...p} />,
    };
});
jest.mock('@/components/ui/icon', () => {
    const { View } = require('react-native');
    return { HelpCircleIcon: (p: any) => <View {...p} /> };
});
jest.mock('@/components/ui/modal', () => {
    const { View } = require('react-native');
    const Passthrough = (p: any) => <View {...p} />;
    const Modal = ({ isOpen, children, ...rest }: any) => (isOpen ? <View {...rest}>{children}</View> : null);
    return {
        Modal,
        ModalBackdrop: Passthrough,
        ModalContent: Passthrough,
        ModalHeader: Passthrough,
        ModalBody: Passthrough,
        ModalFooter: Passthrough,
    };
});
jest.mock('@expo/vector-icons', () => { const { View } = require('react-native'); return { MaterialIcons: (p: any) => <View {...p} /> }; });

// --- child components → light stubs ----------------------------------------
// MeraChatInvite pulls in the animated MeraLogo (reanimated + svg), which has
// no native side under jest — same stub as cards.test.tsx.
jest.mock('@/components/custom/MeraLogo', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: (p: any) => <View testID="mera-logo" {...p} /> };
});
jest.mock('@/components/custom/BlockedBanner', () => { const { Text } = require('react-native'); return { __esModule: true, default: () => <Text>blocked-banner</Text> }; });
jest.mock('@/components/custom/UsageWidget', () => {
    const { View, Text, Pressable } = require('react-native');
    return {
        __esModule: true,
        // `trialEndsAt` is DELIBERATELY still destructured and rendered here
        // even though UsageWidget no longer accepts it: it is what makes the
        // "never a trial" assertion meaningful. Drop it and that expectation
        // passes because the testID could never appear, not because the screen
        // stopped passing the prop.
        default: ({ used, limit, planLabel, trialEndsAt, onUpgrade, onInfoPress }: any) => (
            <View testID="usage-widget">
                <Text>{`usage:${used}/${limit ?? '-'}`}</Text>
                {planLabel ? <Text testID="usage-widget-plan-label">{planLabel}</Text> : null}
                {trialEndsAt ? <Text testID="usage-widget-trial-ends-at">{trialEndsAt}</Text> : null}
                {onUpgrade ? <Pressable accessibilityLabel="upgrade" onPress={onUpgrade} /> : null}
                {onInfoPress ? <Pressable accessibilityLabel="usage-info" onPress={onInfoPress} /> : null}
            </View>
        ),
    };
});
jest.mock('@/components/custom/profile-hub/HubRow', () => {
    const { Pressable, Text } = require('react-native');
    return { __esModule: true, default: ({ label, onPress }: any) => <Pressable accessibilityLabel={label} onPress={onPress}><Text>{label}</Text></Pressable> };
});
jest.mock('@/components/custom/for-you/TabExplainerButton', () => {
    const { View } = require('react-native');
    return { __esModule: true, default: ({ tab, testID }: any) => <View testID={testID} accessibilityLabel={`explainer:${tab}`} /> };
});
jest.mock('@/components/custom/facts/FactsList', () => {
    const { Text } = require('react-native');
    return {
        __esModule: true,
        default: ({ editing }: any) => <Text testID="facts-list-mode">{editing ? 'facts-list:editing' : 'facts-list'}</Text>,
    };
});

// --- services / stores ------------------------------------------------------
const mockGetFacts = jest.fn();
jest.mock('@/lib/database/services/fact-service', () => ({ getFacts: (...a: unknown[]) => mockGetFacts(...a) }));

const mockFetchUserBilling = jest.fn();
jest.mock('@/lib/billing-service', () => ({ fetchUserBilling: (...a: unknown[]) => mockFetchUserBilling(...a) }));

jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    getTotalArticleSuggestionCount: () => Promise.resolve(0),
}));

const mockPresentPaywall = jest.fn();
jest.mock('react-native-purchases-ui', () => ({ __esModule: true, default: { presentPaywall: (...a: unknown[]) => mockPresentPaywall(...a) } }));
// `getActiveTier` is missing here is why this whole suite used to fail to run
// ("getActiveTier is not a function") — ProfileScreen calls it on every render
// for the RevenueCat fallback tier.
jest.mock('@/lib/revenuecat', () => ({
    getOfferingSafe: () => Promise.resolve(null),
    getActiveTier: () => null,
}));

// Entitlement, switchable per test. MeraChatInvite reads `useAiAccess()`;
// ProfileScreen uses `useSubscriptionStore` BOTH as a selector hook
// (serverTier, customerInfo) and imperatively (`getState().setServerBilling`),
// so the mock has to be a callable carrying `getState` — a plain object breaks
// the render.
let mockAiAccess: 'unknown' | 'locked' | 'entitled' = 'unknown';
const mockSetServerBilling = jest.fn();
// `grantExpiresAt`/`isPremium` default to the "no trial" shape every existing
// test in this file assumes; the trial-label tests below override them.
let mockSubscriptionState: any = {
    serverTier: null,
    customerInfo: null,
    grantExpiresAt: null,
    isPremium: false,
};
jest.mock('@/lib/stores/subscription-store', () => {
    const useSubscriptionStore: any = (selector: any) => selector(mockSubscriptionState);
    useSubscriptionStore.getState = () => ({ setServerBilling: mockSetServerBilling });
    return {
        useAiAccess: () => mockAiAccess,
        useSubscriptionStore,
    };
});
jest.mock('@/lib/logger', () => ({ __esModule: true, default: { captureException: jest.fn() } }));

jest.mock('@/lib/haptics', () => ({ hapticMedium: jest.fn() }));

const mockExpand = jest.fn();
jest.mock('@/lib/stores/floating-chat-store', () => ({
    useFloatingChatFactMutationVersion: () => 0,
    useFloatingChatStore: { getState: () => ({ expand: mockExpand }) },
}));

const mockPresentFreeTierPaywall = jest.fn((..._a: unknown[]) => Promise.resolve());
jest.mock('@/lib/subscription/present-free-tier-paywall', () => ({
    presentFreeTierPaywall: (...a: unknown[]) => mockPresentFreeTierPaywall(...a),
}));

jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: () => ({ userPersona: { blockedByLlm: false }, fetchUserPersona: jest.fn() }),
}));

jest.mock('@/lib/visibility-tick', () => ({
    notifyScrollTick: jest.fn(),
    subscribeScrollTick: jest.fn(() => () => {}),
}));

import SettingsUsageCard from '../SettingsUsageCard';

beforeEach(() => {
    jest.clearAllMocks();
    mockFetchUserBilling.mockResolvedValue(null);
    mockSubscriptionState = { serverTier: null, customerInfo: null, grantExpiresAt: null, isPremium: false };
});

// The usage card moved from Profile to the top of Settings; these are the
// Profile card's own tests, carried over unchanged in substance.
describe('SettingsUsageCard', () => {
    it('usage-card info icon opens the article-count explainer modal', async () => {
        const { getByLabelText, getByText } = render(<SettingsUsageCard />);
        await waitFor(() => expect(getByLabelText('usage-info')).toBeTruthy());
        fireEvent.press(getByLabelText('usage-info'));
        expect(getByText('configPanel.articleAnalysisTitle')).toBeTruthy();
    });

    // ── The plan label for a granted vs a paying account ────────────────────
    // `subscriptionTier: 'starter'` is what BOTH report. Both cases hold it
    // fixed and flip only the store fields.
    //
    // REGRESSION GUARD. This first case used to assert "Free Trial" and a
    // countdown. The server still sends `grantExpiresAt` for an unpaid account
    // inside the promo window, so the app rendered a trial that no longer
    // exists — shipped to production before it was caught. The app now reads
    // that field nowhere, and an unpaid account reads as Starter.
    it('an unpaid account inside the grant window reads as Starter, never a trial', async () => {
        mockSubscriptionState = {
            serverTier: 'starter',
            customerInfo: null,
            grantExpiresAt: '2026-08-20T00:00:00.000Z',
            isPremium: false,
        };
        mockFetchUserBilling.mockResolvedValue({
            subscriptionTier: 'starter',
            articlesUsedToday: 1,
            dailyArticleLimit: 5,
            resetAt: '2026-08-11T00:00:00.000Z',
            entitlementExpiresAt: null,
            grantExpiresAt: '2026-08-20T00:00:00.000Z',
            hasEverSubscribed: true,
            showLapseInterstitial: false,
        });
        const { getByTestId, queryByTestId } = render(<SettingsUsageCard />);
        await waitFor(() =>
            expect(getByTestId('usage-widget-plan-label').props.children).toBe('configPanel.starterPlan'),
        );
        expect(queryByTestId('usage-widget-trial-ends-at')).toBeNull();
    });

    it('a paying subscriber shows the plain plan name', async () => {
        mockSubscriptionState = {
            serverTier: 'starter',
            customerInfo: null,
            // Server invariant: null once a paying subscription (not the grant)
            // is what's providing access. See subscription-store.ts's own doc.
            grantExpiresAt: null,
            isPremium: true,
        };
        mockFetchUserBilling.mockResolvedValue({
            subscriptionTier: 'starter',
            articlesUsedToday: 1,
            dailyArticleLimit: 5,
            resetAt: '2026-08-11T00:00:00.000Z',
            entitlementExpiresAt: '2026-09-11T00:00:00.000Z',
            grantExpiresAt: null,
            hasEverSubscribed: true,
            showLapseInterstitial: false,
        });
        const { getByTestId, queryByTestId } = render(<SettingsUsageCard />);
        await waitFor(() =>
            expect(getByTestId('usage-widget-plan-label').props.children).toBe('configPanel.starterPlan'),
        );
        expect(queryByTestId('usage-widget-trial-ends-at')).toBeNull();
    });

    // ── ux1 Profile ─────────────────────────────────────────────────────────
    it('its Manage plan button opens manage-subscription', async () => {
        const { getByLabelText } = render(<SettingsUsageCard />);
        await waitFor(() => expect(getByLabelText('upgrade')).toBeTruthy());
        fireEvent.press(getByLabelText('upgrade'));
        expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/preferences/manage-subscription');
    });
});
