// useTrialOffer claims the free Individual trial only on the store's proof; anything else is null
// ("See plans"). Faked at the edge: the RevenueCat SDK (setup mock), driven per test.
import Purchases from 'react-native-purchases';
import { Platform } from 'react-native';
import { renderHook, waitFor } from '@testing-library/react-native';
import { configureRevenueCat } from '@/lib/revenuecat';
import { __resetTrialOfferForTests, resolveTrialOffer, useTrialOffer } from '@/lib/subscription/trial-offer';

const getOfferings = (Purchases as unknown as { getOfferings: jest.Mock }).getOfferings;
const checkEligibility = (Purchases as unknown as { checkTrialOrIntroductoryPriceEligibility: jest.Mock })
    .checkTrialOrIntroductoryPriceEligibility;
const originalOS = Platform.OS;
const setOS = (os: 'ios' | 'android') => Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });

const IOS_ID = 'mera_news_individual_monthly';
const PLAY_ID = 'mera_news_subscriptions:mera-news-individual-monthly';
const freeWeek = { price: 0, priceString: '0', cycles: 1, period: 'P1W', periodUnit: 'WEEK', periodNumberOfUnits: 1 };
const offeringWith = (product: Record<string, unknown>) => {
    const offering = {
        identifier: 'mera-news-subscription',
        availablePackages: [
            { identifier: 'professional', product: { identifier: 'mera_news_professional_monthly', introPrice: freeWeek } },
            { identifier: 'individual', product },
        ],
    };
    return { current: offering, all: { 'mera-news-subscription': offering } };
};
const eligibility = (status: number) => ({ [IOS_ID]: { status, description: '' } });

beforeAll(() => configureRevenueCat());
beforeEach(() => {
    __resetTrialOfferForTests();
    setOS('ios');
});
afterEach(() => {
    getOfferings.mockReset();
    getOfferings.mockImplementation(() => Promise.resolve({ current: null, all: {} }));
    checkEligibility.mockReset();
    checkEligibility.mockImplementation(() => Promise.resolve({}));
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS, writable: true });
});

describe('iOS', () => {
    beforeEach(() => getOfferings.mockResolvedValue(offeringWith({ identifier: IOS_ID, introPrice: freeWeek })));

    it('is the trial length when the Individual product is ELIGIBLE', async () => {
        checkEligibility.mockResolvedValue(eligibility(2));
        expect(await resolveTrialOffer()).toEqual({ trialDays: 7 });
        expect(checkEligibility).toHaveBeenCalledWith([IOS_ID]);
    });

    it.each([
        ['unknown', 0],
        ['ineligible', 1],
        ['no intro offer', 3],
    ])('is null when the store answers %s', async (_label, status) => {
        checkEligibility.mockResolvedValue(eligibility(status));
        expect(await resolveTrialOffer()).toBeNull();
    });

    it('is null when the check fails', async () => {
        checkEligibility.mockRejectedValue(new Error('no group'));
        expect(await resolveTrialOffer()).toBeNull();
    });

    it('is null for a paid intro offer, even when eligible', async () => {
        getOfferings.mockResolvedValue(offeringWith({ identifier: IOS_ID, introPrice: { ...freeWeek, price: 0.99 } }));
        checkEligibility.mockResolvedValue(eligibility(2));
        expect(await resolveTrialOffer()).toBeNull();
    });
});

describe('Android', () => {
    beforeEach(() => setOS('android'));

    it('is the free phase on the default option', async () => {
        getOfferings.mockResolvedValue(
            offeringWith({
                identifier: PLAY_ID,
                defaultOption: { freePhase: { billingPeriod: { unit: 'DAY', value: 7, iso8601: 'P7D' }, billingCycleCount: 1 } },
            }),
        );
        expect(await resolveTrialOffer()).toEqual({ trialDays: 7 });
    });

    it('is null without a free phase', async () => {
        getOfferings.mockResolvedValue(offeringWith({ identifier: PLAY_ID, defaultOption: { freePhase: null } }));
        expect(await resolveTrialOffer()).toBeNull();
    });
});

describe('useTrialOffer', () => {
    it('is null when the offerings cannot be read, and asks the store again on the next mount', async () => {
        getOfferings.mockRejectedValue(new Error('offline'));
        const first = renderHook(() => useTrialOffer());
        await waitFor(() => expect(getOfferings).toHaveBeenCalledTimes(1));
        expect(first.result.current).toBeNull();
        renderHook(() => useTrialOffer());
        await waitFor(() => expect(getOfferings).toHaveBeenCalledTimes(2));
    });

    it('caches a yes for the process', async () => {
        setOS('android');
        getOfferings.mockResolvedValue(
            offeringWith({
                identifier: PLAY_ID,
                defaultOption: { freePhase: { billingPeriod: { unit: 'DAY', value: 7, iso8601: 'P7D' }, billingCycleCount: 1 } },
            }),
        );
        const first = renderHook(() => useTrialOffer());
        await waitFor(() => expect(first.result.current).toEqual({ trialDays: 7 }));
        const second = renderHook(() => useTrialOffer());
        await waitFor(() => expect(second.result.current).toEqual({ trialDays: 7 }));
        expect(getOfferings).toHaveBeenCalledTimes(1);
    });
});
