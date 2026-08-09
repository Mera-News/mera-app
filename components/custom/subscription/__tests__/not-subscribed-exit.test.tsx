/* eslint-disable @typescript-eslint/no-require-imports */
// not-subscribed-exit.test.tsx — leaving the paywall must leave the
// subscription store AGREEING with the server.
//
// The trap, which `lib/subscription/present-free-tier-paywall.ts` already
// documents for the free-tier surfaces: `deriveAiAccess` consults `serverTier`
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
// The glass plate reaches expo-glass-effect (a native module) at import time.
jest.mock('@/components/custom/cards/CardGlassPlate', () => ({ CardGlassPlate: () => null }));
// RN's real ScrollView pulls in an untransformed Android spec file under this
// jest config; the screen imports it through the ui layer so one stub suffices.
jest.mock('@/components/ui/scroll-view', () => { const { View } = require('react-native'); return { ScrollView: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/box', () => { const { View } = require('react-native'); return { Box: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/vstack', () => { const { View } = require('react-native'); return { VStack: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/heading', () => { const { Text } = require('react-native'); return { Heading: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text: (p: any) => <Text {...p} /> }; });
jest.mock('@/components/ui/spinner', () => { const { View } = require('react-native'); return { Spinner: (p: any) => <View {...p} /> }; });
jest.mock('@/components/ui/button', () => {
    const { Pressable, Text, View } = require('react-native');
    return {
        Button: (p: any) => <Pressable {...p} />,
        ButtonText: (p: any) => <Text {...p} />,
        ButtonIcon: (p: any) => <View {...p} />,
    };
});
jest.mock('@/components/ui/icon', () => {
    const { View } = require('react-native');
    return {
        RepeatIcon: (p: any) => <View {...p} />,
        HelpCircleIcon: (p: any) => <View {...p} />,
    };
});
jest.mock('react-native-safe-area-context', () => {
    const { View } = require('react-native');
    return { SafeAreaView: (p: any) => <View {...p} /> };
});
jest.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));

const mockReplace = jest.fn();
const mockPush = jest.fn();
jest.mock('expo-router', () => ({
    useRouter: () => ({
        replace: (...a: any[]) => mockReplace(...a),
        push: (...a: any[]) => mockPush(...a),
    }),
}));

const mockSessionRef = { current: { user: { id: 'u1' } } as { user: { id: string } } | null };
jest.mock('@/lib/auth-client', () => ({
    authClient: { useSession: () => ({ data: mockSessionRef.current, isPending: false }) },
}));

// Identity is LOCAL-first here (see the screen). Selector-shaped mock, which
// also keeps the real user-store's WatermelonDB adapter out of this suite.
const mockLocalUserIdRef = { current: 'u1' as string | null };
jest.mock('@/lib/stores/user-store', () => ({
    useUserStore: (selector?: (s: unknown) => unknown) => {
        const state = { userId: mockLocalUserIdRef.current };
        return selector ? selector(state) : state;
    },
}));


// RevenueCat's configured-ness is togglable per test: the exit-path tests leave
// it off, and the "no auto-present" test turns it ON — which is the only state
// in which the removed effect could ever have fired.
const mockRcState = { configured: false };
const mockTrialAvailability = { current: 'ineligible' as string };
const mockCustomerInfo = { current: null as unknown };
jest.mock('@/lib/revenuecat', () => ({
    getCustomerInfoSafe: jest.fn(async () => mockCustomerInfo.current),
    getOfferingSafe: jest.fn(async () => null),
    isRevenueCatConfigured: () => mockRcState.configured,
    logRevenueCatDiagnostics: jest.fn(async () => {}),
    getTrialAvailability: jest.fn(async () => mockTrialAvailability.current),
}));
const mockPresentPaywall = jest.fn(async () => 'CANCELLED');
jest.mock('react-native-purchases-ui', () => ({
    __esModule: true,
    default: { presentPaywall: (...a: any[]) => mockPresentPaywall(...(a as [])) },
    PAYWALL_RESULT: { PURCHASED: 'PURCHASED', RESTORED: 'RESTORED' },
}));

const mockSetServerBilling = jest.fn();
jest.mock('@/lib/stores/subscription-store', () => ({
    useSubscriptionStore: {
        getState: () => ({
            setCustomerInfo: jest.fn(),
            setServerBilling: mockSetServerBilling,
            serverTier: 'none',
        }),
    },
}));
jest.mock('@/lib/database/services/setting-service', () => ({ setSetting: jest.fn(async () => {}) }));

const mockRefreshAfterPurchase = jest.fn();
const mockFetchUserBilling = jest.fn();
jest.mock('@/lib/billing-service', () => ({
    refreshUserBillingAfterPurchase: (...a: any[]) => mockRefreshAfterPurchase(...(a as [])),
    fetchUserBilling: (...a: any[]) => mockFetchUserBilling(...(a as [])),
}));

const mockShowActivatedToast = jest.fn();
jest.mock('@/lib/subscription/activation-toast', () => ({
    showSubscriptionActivatedToast: (...a: any[]) => mockShowActivatedToast(...a),
}));

const order: string[] = [];
const mockSyncEntitlement = jest.fn(async () => { order.push('sync'); });
jest.mock('@/lib/subscription/entitlement-sync', () => ({
    syncEntitlement: (...a: any[]) => mockSyncEntitlement(...(a as [])),
}));

import NotSubscribedScreen from '@/components/custom/auth/NotSubscribedScreen';

beforeEach(() => {
    jest.clearAllMocks();
    order.length = 0;
    mockSessionRef.current = { user: { id: 'u1' } };
    mockLocalUserIdRef.current = 'u1';
    mockRcState.configured = false;
    mockPresentPaywall.mockResolvedValue('CANCELLED');
    mockReplace.mockImplementation((...a: any[]) => { order.push(`replace:${a[0]}`); });
    // Default: the webhook HAS landed and the server reports a paid tier.
    mockFetchUserBilling.mockResolvedValue({ subscriptionTier: 'starter' });
    mockRefreshAfterPurchase.mockResolvedValue({ billing: null, confirmed: false });
    mockTrialAvailability.current = 'ineligible';
});

// Only `mera_news_individual_monthly` on the App Store carries an introductory
// offer (verified against the RevenueCat catalogue: every other product,
// including all four Play Store products and Starter, has a null
// trial_duration). So the trial wording is a claim about THIS store account on
// THIS platform, and getting it wrong means the payment sheet contradicts the
// page that sent the user to it.
describe('the trial is only promised when the store will honour it', () => {
    it('offers the trial when the account is eligible', async () => {
        mockTrialAvailability.current = 'eligible';
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(getByText('subscription.startFreeTrial')).toBeTruthy();
        expect(getByText('subscription.para3Trial')).toBeTruthy();
    });

    it('does not, once the account has already used it', async () => {
        mockTrialAvailability.current = 'ineligible';
        const { getByText, queryByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(getByText('subscription.subscribeNow')).toBeTruthy();
        expect(queryByText('subscription.para3Trial')).toBeNull();
        expect(getByText('subscription.para3NoTrial')).toBeTruthy();
    });

    // The asymmetry is the point: an unknown answer must fall to the version
    // that promises less. Showing "Start your free trial" and then retracting it
    // is worse than never having offered it.
    it('treats an unknown answer as no trial', async () => {
        mockTrialAvailability.current = 'unknown';
        const { getByText, queryByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(getByText('subscription.subscribeNow')).toBeTruthy();
        expect(queryByText('subscription.startFreeTrial')).toBeNull();
    });

    // The lapsed path has its own copy and its own CTA, and never mentions a
    // trial -- a returning subscriber is by definition ineligible.
    it('never shows trial copy on the lapsed entry, even when eligible', async () => {
        mockTrialAvailability.current = 'eligible';
        const { getByText, queryByText } = render(<NotSubscribedScreen reason="lapsed" />);

        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(getByText('subscription.turnMeraBackOn')).toBeTruthy();
        expect(queryByText('subscription.startFreeTrial')).toBeNull();
        expect(queryByText('subscription.para3Trial')).toBeNull();
    });
});

// The screen used to open the RevenueCat sheet on mount for every non-`lapsed`
// entry. That was a deliberate choice (the first-open case was called "the
// primary conversion moment") and it has been deliberately REVERSED: the screen
// carries its own visible plans CTA, so a modal stacked on top of it fires
// before the user can read the page meant to convince them.
describe('the purchase sheet opens only on an explicit tap', () => {
    it('does not auto-present on mount, even with RevenueCat configured', async () => {
        mockRcState.configured = true;

        render(<NotSubscribedScreen />);
        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockPresentPaywall).not.toHaveBeenCalled();
    });

    it('presents when the primary CTA is tapped', async () => {
        mockRcState.configured = true;
        const { getByTestId } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-plans'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockPresentPaywall).toHaveBeenCalledTimes(1);
    });

    it('does not auto-present on the lapsed entry either', async () => {
        mockRcState.configured = true;

        render(<NotSubscribedScreen reason="lapsed" />);
        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockPresentPaywall).not.toHaveBeenCalled();
    });
});

describe('leaving the paywall for /logged-in', () => {
    it('forces an entitlement sync BEFORE handing back to the router gate', async () => {
        const { getByTestId } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockSyncEntitlement).toHaveBeenCalledWith({ force: true });
        // Ordering is the whole point: replacing first would hand /logged-in a
        // store that still says 'none'.
        expect(order).toEqual(['sync', 'replace:/logged-in']);
    });


    // Offline / keychain-locked wake / 401 blip. Refresh is one of only two ways
    // off this screen, and with the id read off the session `checkServerSubscribed`
    // short-circuited to false WITHOUT asking the server at all — so a user who
    // had genuinely just paid tapped Refresh and nothing happened. The query is
    // authorised by the auth cookie, not by the session object.
    it('Refresh still asks the server, off the LOCAL id, when the session cannot be fetched', async () => {
        mockSessionRef.current = null;
        const { getByTestId } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockFetchUserBilling).toHaveBeenCalled();
        expect(mockReplace).toHaveBeenCalledWith('/logged-in');
    });

    it('does not sync or leave while the server still refuses', async () => {
        mockFetchUserBilling.mockResolvedValue(null);
        const { getByTestId } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockSyncEntitlement).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    // THE REGRESSION. `checkServerSubscribed` used to call `getUserPersona()`
    // and return true whenever it did not throw — but `userPersonaByUserId`
    // carries no SubscriptionGuard, is `nullable: true`, and the client returns
    // `null` instead of throwing when no persona exists. So the predicate was
    // true for everyone, including a brand-new user whose webhook had not landed.
    //
    // The screen therefore left immediately, /logged-in re-read `aiAccess`, saw
    // a still-'locked' tier, and routed straight back here: purchase → paywall,
    // observed on a real device. Leaving must require a PAID TIER, not merely a
    // reachable server.
    it('does not leave on a reachable server that still reports no tier', async () => {
        mockFetchUserBilling.mockResolvedValue({ subscriptionTier: 'none' });
        const { getByTestId } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        expect(mockSyncEntitlement).not.toHaveBeenCalled();
        expect(mockReplace).not.toHaveBeenCalled();
    });

    it('"Continue without a plan" records the dismissal and drops onto Mera News Free', async () => {
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByText('freeTier.continueWithoutPlan'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        const { setSetting } = require('@/lib/database/services/setting-service');
        // The flag the pre-onboarding gate reads to decide 'free-tier' rather
        // than looping back to this screen.
        expect(setSetting).toHaveBeenCalledWith('free_tier_first_open_dismissed', 'true');
        expect(mockReplace).toHaveBeenCalledWith('/logged-in/app_container/feed');
    });

    // The tutorials link. The PATH is the whole assertion: it is written as
    // `'/tutorials' as any` (typedRoutes cannot see through the cast), so a
    // typo here would compile, lint and ship — and the one place it must never
    // point is back under `/logged-in`, since this screen is reachable by a
    // reader with no plan and, on the first-open path, barely a session.
    //
    // `push`, not `replace`: closing the tutorials must return the reader to
    // this screen with the CTA still in front of them, not strand them.
    it('"Learn how Mera works" opens the top-level tutorials route', () => {
        const { getByText } = render(<NotSubscribedScreen />);

        fireEvent.press(getByText('tutorials.learnAboutMera'));

        expect(mockPush).toHaveBeenCalledWith('/tutorials');
        expect(mockReplace).not.toHaveBeenCalled();
    });

    // It sits between Refresh and "Continue without a plan": the solid CTA keeps
    // its monopoly on visual weight, and of the two ways out, the soft one
    // ("show me what this is") is offered before the hard one.
    it('sits between Refresh and "Continue without a plan"', () => {
        const { getByTestId, UNSAFE_root } = render(<NotSubscribedScreen />);

        const order = [
            'not-subscribed-plans',
            'not-subscribed-refresh',
            'not-subscribed-learn',
            'not-subscribed-continue',
        ].map((id) => getByTestId(id));

        const rendered = UNSAFE_root.findAll((n: unknown) => order.includes(n as never));
        expect(rendered).toEqual(order);
    });

    // Never disabled, for the same reason "Continue without a plan" is not: a
    // ~25s activation poll the reader did not ask for must not strand the
    // secondary actions behind it.
    it('stays tappable while the screen is busy', async () => {
        mockRcState.configured = true;
        // A purchase sheet that never resolves — `busy` holds for the whole test.
        mockPresentPaywall.mockImplementation(() => new Promise(() => {}));
        const { getByText } = render(<NotSubscribedScreen />);

        await act(async () => {
            fireEvent.press(getByText('subscription.subscribeNow'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });

        fireEvent.press(getByText('tutorials.learnAboutMera'));

        expect(mockPush).toHaveBeenCalledWith('/tutorials');
    });
});

export {};

/**
 * The report this exists for: StoreKit shows "You are currently subscribed to
 * this … [Environment: Sandbox]" while Mera shows "Free isn't free".
 *
 * Both are correct. The gate is server-authoritative on purpose, and RevenueCat
 * routes sandbox receipts to the STAGING webhook, so a production build's
 * UserBilling row is never written. What was missing is saying so — and saying
 * it WITHOUT a purchase happening in this session, because a tester who bought
 * on a previous launch never passes through the purchase path at all.
 */
describe('a sandbox entitlement on a production build explains itself', () => {
    const sandboxCustomer = {
        entitlements: { all: { 'mera-news-individual-plan': { isSandbox: true } } },
    };
    const productionCustomer = {
        entitlements: { all: { 'mera-news-individual-plan': { isSandbox: false } } },
    };

    beforeEach(() => {
        mockRcState.configured = true;
        mockFetchUserBilling.mockResolvedValue(null);
        process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'https://auth.mera.news';
    });
    afterEach(() => {
        mockCustomerInfo.current = null;
        mockRcState.configured = false;
    });

    it('explains itself ON MOUNT, with no purchase in this session', async () => {
        mockCustomerInfo.current = sandboxCustomer;
        const { queryByText } = render(<NotSubscribedScreen />);
        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(queryByText('subscription.sandboxOnProduction')).toBeTruthy();
        // and it must NOT have opened the purchase sheet to find that out
        expect(mockPresentPaywall).not.toHaveBeenCalled();
    });

    it('says nothing for a real production entitlement', async () => {
        mockCustomerInfo.current = productionCustomer;
        const { queryByText } = render(<NotSubscribedScreen />);
        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(queryByText('subscription.sandboxOnProduction')).toBeNull();
    });

    it('says nothing when the build is pointed at staging — the supported test path', async () => {
        process.env.EXPO_PUBLIC_AUTH_ENDPOINT = 'https://auth.staging.mera.news';
        mockCustomerInfo.current = sandboxCustomer;
        const { queryByText } = render(<NotSubscribedScreen />);
        await act(async () => {
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(queryByText('subscription.sandboxOnProduction')).toBeNull();
    });

    // Refresh used to fail silently, which is indistinguishable from "still
    // working" — the reader had no way to tell a slow webhook from an
    // impossible one.
    it('Refresh no longer fails silently when the server still refuses', async () => {
        mockCustomerInfo.current = null;
        const { getByTestId, queryByText } = render(<NotSubscribedScreen />);
        await act(async () => {
            fireEvent.press(getByTestId('not-subscribed-refresh'));
            for (let i = 0; i < 8; i++) await Promise.resolve();
        });
        expect(queryByText('subscription.activationDelayed')).toBeTruthy();
    });
});
