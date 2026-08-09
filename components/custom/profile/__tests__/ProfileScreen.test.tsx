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

jest.mock('expo-router', () => ({
    router: { push: jest.fn() },
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
        default: ({ used, limit, onUpgrade, onInfoPress }: any) => (
            <View testID="usage-widget">
                <Text>{`usage:${used}/${limit ?? '-'}`}</Text>
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
jest.mock('@/components/custom/facts/FactsList', () => {
    const { Text } = require('react-native');
    return { __esModule: true, default: () => <Text>facts-list</Text> };
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
jest.mock('@/lib/stores/subscription-store', () => {
    const useSubscriptionStore: any = (selector: any) =>
        selector({ serverTier: null, customerInfo: null });
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

import ProfileScreen from '../ProfileScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockFetchUserBilling.mockResolvedValue(null);
    mockAiAccess = 'unknown';
});

describe('ProfileScreen', () => {
    it('renders the usage card at the top and the Advanced row', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId, getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('usage-widget')).toBeTruthy());
        expect(getByText('Advanced')).toBeTruthy();
    });

    it('renders the "Profile" screen heading (reusing tabs.profile)', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('tabs.profile')).toBeTruthy());
    });

    it('empty persona → shows the Mera chat invite and no About-you section', async () => {
        mockGetFacts.mockResolvedValue([]);
        const { getByText, queryByText, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('profile.meraInvite')).toBeTruthy());
        expect(queryByText('ABOUT YOU')).toBeNull();
        expect(queryByText('facts-list')).toBeNull();
        // Usage card + Advanced row still present.
        expect(getByTestId('usage-widget')).toBeTruthy();
        expect(getByText('Advanced')).toBeTruthy();
    });

    it('with facts → renders the About-you heading and the real facts list (FactsList)', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('ABOUT YOU')).toBeTruthy());
        expect(getByText('facts-list')).toBeTruthy();
    });

    it('Mera chat invite opens the persona chat', async () => {
        mockGetFacts.mockResolvedValue([]);
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('profile.meraInvite')).toBeTruthy());
        fireEvent.press(getByText('profile.meraInvite'));
        expect(mockExpand).toHaveBeenCalledWith({ kind: 'persona' });
    });

    // ── Mera News Free ────────────────────────────────────────────────────
    // The row must stay the SAME row an entitled user sees — same speech
    // bubble, same logo — with Mera speaking the free-tier script instead of
    // the invite, and nothing to tap.
    it('locked → Mera speaks the free-tier paragraph (invite copy gone)', async () => {
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { queryByText, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('mera-chat-invite-locked')).toBeTruthy());

        // One static paragraph in the bubble, not the former cycling script.
        expect(getByTestId('mera-chat-invite-bubble-locked')).toBeTruthy();
        expect(queryByText('freeTier.chatBubble')).toBeTruthy();

        expect(queryByText('profile.meraInvite')).toBeNull();
        // Same presentation, not a substitute card: the logo is still there.
        expect(getByTestId('mera-logo')).toBeTruthy();
    });

    it('locked → tapping the Mera row opens the paywall, never the chat', async () => {
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId, queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('mera-chat-invite-locked')).toBeTruthy());
        // The entitled testID must NOT be present — the two states have to stay
        // distinguishable now that both are pressable.
        expect(queryByTestId('mera-chat-invite')).toBeNull();

        fireEvent.press(getByTestId('mera-chat-invite-locked'));
        expect(mockPresentFreeTierPaywall).toHaveBeenCalledWith('MeraChatInvite');
        // `FloatingChatHost` renders nothing while locked, so a morph here would
        // target an unmounted popover.
        expect(mockExpand).not.toHaveBeenCalled();
    });

    it('locked → the About-you facts heading and list still render', async () => {
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('ABOUT YOU')).toBeTruthy());
        expect(getByText('facts-list')).toBeTruthy();
    });

    it('entitled → the invite copy and its press target come back', async () => {
        mockAiAccess = 'entitled';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByText, getByTestId, queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('profile.meraInvite')).toBeTruthy());
        expect(queryByTestId('mera-chat-invite-locked')).toBeNull();
        fireEvent.press(getByTestId('mera-chat-invite'));
        expect(mockExpand).toHaveBeenCalledWith({ kind: 'persona' });
    });

    it('usage-card info icon opens the article-count explainer modal', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByLabelText, getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByLabelText('usage-info')).toBeTruthy());
        fireEvent.press(getByLabelText('usage-info'));
        expect(getByText('configPanel.articleAnalysisTitle')).toBeTruthy();
    });
});
