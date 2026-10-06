/* eslint-disable @typescript-eslint/no-require-imports */
import { fireEvent, render, waitFor } from '@testing-library/react-native';
import React from 'react';

jest.mock('react-native-css-interop/jsx-runtime', () => {
    const R = require('react/jsx-runtime');
    return { jsx: R.jsx, jsxs: R.jsxs, Fragment: R.Fragment };
});
jest.mock('react-native-css-interop/jsx-dev-runtime', () => {
    const R = require('react/jsx-dev-runtime');
    return { jsxDEV: R.jsxDEV, Fragment: R.Fragment };
});
jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (k: string, o?: Record<string, unknown>) => (o ? `${k}${JSON.stringify(o)}` : k),
        i18n: { language: 'en-GB' },
    }),
}));
const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: unknown[]) => mockRouterPush(...a) },
    useFocusEffect: (cb: () => void) => { const React2 = require('react'); React2.useEffect(cb, []); },
}));
jest.mock('@/components/ui/pressable', () => { const { Pressable } = require('react-native'); return { Pressable }; });
jest.mock('@/components/ui/text', () => { const { Text } = require('react-native'); return { Text }; });

const mockFetchUserBilling = jest.fn();
jest.mock('@/lib/billing-service', () => ({ fetchUserBilling: (...a: unknown[]) => mockFetchUserBilling(...a) }));
jest.mock('@/lib/revenuecat', () => ({ getActiveTier: () => null }));
const mockSetServerBilling = jest.fn();
let mockSubscriptionState: any = { serverTier: null, customerInfo: null };
jest.mock('@/lib/stores/subscription-store', () => {
    const useSubscriptionStore: any = (selector: any) => selector(mockSubscriptionState);
    useSubscriptionStore.getState = () => ({ setServerBilling: mockSetServerBilling });
    return { useSubscriptionStore };
});

import SettingsUsageCard, { formatResetTime } from '../SettingsUsageCard';

const BILLING = {
    subscriptionTier: 'starter',
    articlesUsedToday: 112,
    dailyArticleLimit: 250,
    resetAt: '2026-08-11T00:00:00.000Z',
    entitlementExpiresAt: null,
    grantExpiresAt: '2026-08-20T00:00:00.000Z',
    hasEverSubscribed: true,
    showLapseInterstitial: false,
};

beforeEach(() => {
    jest.clearAllMocks();
    mockSubscriptionState = { serverTier: null, customerInfo: null };
});

describe('SettingsUsageCard', () => {
    it('says articles today, with the limit and the local reset time, never "analysed"', async () => {
        mockFetchUserBilling.mockResolvedValue(BILLING);
        const { getByTestId } = render(<SettingsUsageCard />);
        const reset = formatResetTime(BILLING.resetAt, 'en-GB');
        await waitFor(() =>
            expect(getByTestId('settings-usage-line').props.children).toBe(
                `you.settings.usage{"count":112,"limit":250} · you.settings.resetsAt{"time":"${reset}"}`,
            ),
        );
    });

    it('drops "of" when there is no limit', async () => {
        mockFetchUserBilling.mockResolvedValue({ ...BILLING, dailyArticleLimit: null, resetAt: null });
        const { getByTestId } = render(<SettingsUsageCard />);
        await waitFor(() =>
            expect(getByTestId('settings-usage-line').props.children).toBe('you.settings.usageNoLimit{"count":112}'),
        );
    });

    it('shows no figure offline (the old fallback was an all-time count)', async () => {
        mockFetchUserBilling.mockRejectedValue(new Error('offline'));
        const { getByTestId } = render(<SettingsUsageCard />);
        await waitFor(() => expect(getByTestId('settings-usage-line').props.children).toBe('you.settings.usageOffline'));
    });

    // REGRESSION GUARD: the server sends `grantExpiresAt` for an unpaid account
    // inside the promo window; it once rendered a trial that does not exist.
    it('an unpaid account inside the grant window reads as Starter, never a trial', async () => {
        mockSubscriptionState = { serverTier: 'starter', customerInfo: null };
        mockFetchUserBilling.mockResolvedValue(BILLING);
        const { getByTestId, queryByText } = render(<SettingsUsageCard />);
        await waitFor(() => expect(getByTestId('settings-plan-name').props.children).toBe('configPanel.starterPlan'));
        expect(queryByText(/trial/i)).toBeNull();
    });

    it('Manage plan opens manage-subscription', async () => {
        mockFetchUserBilling.mockResolvedValue(BILLING);
        const { getByTestId } = render(<SettingsUsageCard />);
        fireEvent.press(getByTestId('settings-manage-plan'));
        expect(mockRouterPush).toHaveBeenCalledWith('/logged-in/preferences/manage-subscription');
    });
});

describe('formatResetTime', () => {
    it('is null for a missing or invalid time', () => {
        expect(formatResetTime(null)).toBeNull();
        expect(formatResetTime('not a date')).toBeNull();
    });
});
