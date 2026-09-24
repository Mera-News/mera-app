/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
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

import ProfileScreen from '../ProfileScreen';

beforeEach(() => {
    jest.clearAllMocks();
    mockFetchUserBilling.mockResolvedValue(null);
    mockAiAccess = 'unknown';
    mockSubscriptionState = {
        serverTier: null,
        customerInfo: null,
        grantExpiresAt: null,
        isPremium: false,
    };
});

describe('ProfileScreen', () => {
    it('renders the header Advanced button and NO usage card (it lives at the top of Settings)', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { queryByTestId, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('profile-advanced-open')).toBeTruthy());
        expect(queryByTestId('usage-widget')).toBeNull();
    });

    it('renders the "Profile" screen heading (reusing tabs.profile)', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('tabs.profile')).toBeTruthy());
    });

    it('empty persona → shows the Mera chat invite and no About-you section', async () => {
        mockGetFacts.mockResolvedValue([]);
        const { getByText, queryByText, getByTestId, queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('profile.meraInvite')).toBeTruthy());
        expect(queryByText('ABOUT YOU')).toBeNull();
        expect(queryByTestId('facts-list-mode')).toBeNull();
        expect(getByTestId('profile-advanced-open')).toBeTruthy();
    });

    it('with facts → renders the About-you heading and the real facts list (FactsList)', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        const { getByText, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('ABOUT YOU')).toBeTruthy());
        expect(getByTestId('facts-list-mode')).toBeTruthy();
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
    it('speaks the ordinary invite copy, with no free-tier variant', async () => {
        // Was "locked -> Mera speaks the free-tier paragraph". There is no
        // free-tier paragraph any more: `freeTier.chatBubble` claimed chat
        // needed a plan, which is false now that Starter is free, so the
        // branch was deleted rather than given a third value.
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { queryByText, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('mera-chat-invite')).toBeTruthy());

        // Facts exist, so Mera invites something NEW rather than greeting a
        // first-time user.
        await waitFor(() => expect(queryByText('profile.meraInviteReturning')).toBeTruthy());
        expect(queryByText('freeTier.chatBubble')).toBeNull();
        // Same presentation as before: the logo is still there.
        expect(getByTestId('mera-logo')).toBeTruthy();
    });

    it('tapping the Mera row opens the chat, with no tier variant at all', async () => {
        // THIRD state for this assertion, and the simplest. It asserted the
        // paywall, then the chat-when-locked. Starter is now free for everyone,
        // so there is no locked row, no `mera-chat-invite-locked` testID and no
        // second copy string: one row, one destination, whatever the tier.
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId, queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('mera-chat-invite')).toBeTruthy());
        expect(queryByTestId('mera-chat-invite-locked')).toBeNull();

        fireEvent.press(getByTestId('mera-chat-invite'));
        expect(mockExpand).toHaveBeenCalledWith({ kind: 'persona' });
        expect(mockPresentFreeTierPaywall).not.toHaveBeenCalled();
    });

    it('locked → the About-you facts heading and list still render', async () => {
        mockAiAccess = 'locked';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'Lives in Pune' }]);
        const { getByText, getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('ABOUT YOU')).toBeTruthy());
        expect(getByTestId('facts-list-mode')).toBeTruthy();
    });

    it('entitled → the invite copy and its press target come back', async () => {
        mockAiAccess = 'entitled';
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByText, getByTestId, queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('profile.meraInviteReturning')).toBeTruthy());
        expect(queryByTestId('mera-chat-invite-locked')).toBeNull();
        fireEvent.press(getByTestId('mera-chat-invite'));
        expect(mockExpand).toHaveBeenCalledWith({ kind: 'persona' });
    });

    it('M10: no "Learn how Mera works" button competes with the title', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { queryByTestId, getByText } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByText('tabs.profile')).toBeTruthy());
        expect(queryByTestId('profile-learn-about-mera')).toBeNull();
    });

    it('F46: Edit turns the facts list into edit mode and Done turns it back', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('profile-edit-facts')).toBeTruthy());
        expect(getByTestId('facts-list-mode').props.children).toBe('facts-list');
        const editStyle = getByTestId('profile-edit-facts').props.style;
        expect(editStyle.minHeight).toBeGreaterThanOrEqual(44);
        fireEvent.press(getByTestId('profile-edit-facts'));
        expect(getByTestId('facts-list-mode').props.children).toBe('facts-list:editing');
        fireEvent.press(getByTestId('profile-edit-facts'));
        expect(getByTestId('facts-list-mode').props.children).toBe('facts-list');
    });

    it('N4: the header carries the Profile explainer button', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('profile-explainer-open')).toBeTruthy());
        expect(getByTestId('profile-explainer-open').props.accessibilityLabel).toBe('explainer:profile');
    });

    // ── ux1 P2: Advanced moved into the header, icon-only ───────────────────
    it('the header carries an icon-only Advanced button with the Advanced a11y label', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('profile-advanced-open')).toBeTruthy());
        expect(getByTestId('profile-advanced-open').props.accessibilityLabel).toBe('Advanced');
        expect(getByTestId('profile-advanced-open').props.accessibilityRole).toBe('button');
    });

    it('pressing the header Advanced button navigates to the Advanced route', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { getByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(getByTestId('profile-advanced-open')).toBeTruthy());
        fireEvent.press(getByTestId('profile-advanced-open'));
        expect(router.push).toHaveBeenCalledWith('/logged-in/profile-advanced');
    });

    it('no bottom Advanced button remains on the page', async () => {
        mockGetFacts.mockResolvedValue([{ id: 'f1', statement: 'x' }]);
        const { queryByTestId } = render(<ProfileScreen userId="u1" />);
        await waitFor(() => expect(queryByTestId('profile-advanced-open')).toBeTruthy());
        expect(queryByTestId('profile-row-advanced')).toBeNull();
    });
});
