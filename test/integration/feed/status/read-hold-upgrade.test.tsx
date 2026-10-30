// The read hold's ONE upgrade button (ReadHoldUpgradeButton, level 1 of the counts card, the
// not-read tail block, the Settings usage card) and the level-2 actions left under the chevron.
// Real stores and read hold; faked at the edges: the RevenueCat SDK (setup mock), the paywall
// chokepoint (its own suite covers it) and the on-device requirements probe.
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import React from 'react';
import ReadHoldUpgradeButton from '@/components/custom/for-you/ReadHoldUpgradeButton';
import { FeedStatusActions } from '@/components/custom/for-you/FeedStatusDetails';
import { resetFeedViewPrefs, setFeedShow, setFeedView } from '@/components/custom/feed/feed-view-prefs';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { configureRevenueCat } from '@/lib/revenuecat';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { presentFreeTierPaywall } from '@/lib/subscription/present-free-tier-paywall';
import { resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { __resetTrialOfferForTests } from '@/lib/subscription/trial-offer';
import { initI18nEn } from '@/test/helpers';

jest.mock('react-native-reanimated', () => {
    const { View, Text } = require('react-native');
    return {
        __esModule: true,
        default: { View, Text },
        Easing: require('react-native').Easing,
        FadeInDown: {},
        FadeOutUp: {},
        useReducedMotion: () => true,
    };
});
jest.mock('@/lib/subscription/present-free-tier-paywall', () => ({ presentFreeTierPaywall: jest.fn(() => Promise.resolve()) }));
jest.mock('@/lib/mera-protocol-toolkit/core/systemRequirements', () => ({
    checkRequirements: jest.fn(() => Promise.resolve({ supported: false })),
}));

jest.setTimeout(60_000);

const getOfferings = (Purchases as unknown as { getOfferings: jest.Mock }).getOfferings;
const checkEligibility = (Purchases as unknown as { checkTrialOrIntroductoryPriceEligibility: jest.Mock })
    .checkTrialOrIntroductoryPriceEligibility;
const originalOS = Platform.OS;
const INDIVIDUAL = 'mera_news_individual_monthly';
const freeWeek = { price: 0, priceString: '0', cycles: 1, period: 'P1W', periodUnit: 'WEEK', periodNumberOfUnits: 1 };

beforeAll(async () => {
    await initI18nEn();
    configureRevenueCat();
});

beforeEach(async () => {
    __resetTrialOfferForTests();
    resetFeedViewPrefs();
    useSubscriptionStore.getState().reset();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => 'ios' });
    await setReadHold({ resetAt: Date.now() + 2 * 3_600_000 });
});

afterEach(() => {
    resetReadHold();
    getOfferings.mockReset();
    getOfferings.mockImplementation(() => Promise.resolve({ current: null, all: {} }));
    checkEligibility.mockReset();
    checkEligibility.mockImplementation(() => Promise.resolve({}));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS, writable: true });
});

describe('the upgrade button', () => {
    it('shows See plans while held on Starter and opens the store paywall', async () => {
        useSubscriptionStore.setState({ serverTier: 'starter' });
        const view = render(<ReadHoldUpgradeButton testID="feed-status-upgrade" />);
        const button = await view.findByTestId('feed-status-upgrade');
        expect(view.getByText('See plans')).toBeTruthy();
        fireEvent.press(button);
        expect(presentFreeTierPaywall).toHaveBeenCalledWith('feed-read-hold');
    });

    it('offers the Individual trial only when the store says this reader is eligible', async () => {
        useSubscriptionStore.setState({ serverTier: 'starter' });
        const offering = {
            identifier: 'mera-news-subscription',
            availablePackages: [{ identifier: 'individual', product: { identifier: INDIVIDUAL, introPrice: freeWeek } }],
        };
        getOfferings.mockResolvedValue({ current: offering, all: { 'mera-news-subscription': offering } });
        checkEligibility.mockResolvedValue({ [INDIVIDUAL]: { status: 2, description: 'eligible' } });
        const view = render(<ReadHoldUpgradeButton testID="feed-status-upgrade" />);
        await waitFor(() => expect(view.getByText('Try Individual free for 7 days')).toBeTruthy());
        expect(checkEligibility).toHaveBeenCalledWith([INDIVIDUAL]);
    });

    it('is not shown to Professional', () => {
        useSubscriptionStore.setState({ serverTier: 'professional' });
        const view = render(<ReadHoldUpgradeButton testID="feed-status-upgrade" />);
        expect(view.queryByTestId('feed-status-upgrade')).toBeNull();
    });

    it('is not shown on this phone, which is never held', () => {
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        const view = render(<ReadHoldUpgradeButton testID="feed-status-upgrade" />);
        expect(view.queryByTestId('feed-status-upgrade')).toBeNull();
    });

    it('is not shown before the hold', () => {
        resetReadHold();
        const view = render(<ReadHoldUpgradeButton testID="feed-status-upgrade" />);
        expect(view.queryByTestId('feed-status-upgrade')).toBeNull();
    });
});

describe('the level-2 actions at the hold', () => {
    it('no longer carry See plans (level 1 owns the upgrade)', () => {
        const view = render(<FeedStatusActions mode="limited" />);
        expect(view.queryByTestId('feed-status-see-plans')).toBeNull();
    });

    it('offer Show all articles under Mera\'s picks, Discarded and the Sectioned view, not under All', () => {
        const view = render(<FeedStatusActions mode="limited" />);
        expect(view.queryByTestId('feed-status-show-all')).toBeNull();
        for (const apply of [() => setFeedShow('picks'), () => setFeedShow('discarded')]) {
            resetFeedViewPrefs();
            apply();
            view.rerender(<FeedStatusActions mode="limited" />);
            expect(view.getByTestId('feed-status-show-all')).toBeTruthy();
        }
        resetFeedViewPrefs();
        setFeedView('sectioned');
        view.rerender(<FeedStatusActions mode="limited" />);
        expect(view.getByTestId('feed-status-show-all')).toBeTruthy();
    });
});
