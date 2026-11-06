/** A plan that rises while a meter is on screen shows "Your new plan applies now." at once. */
import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import ReadingMeter from '@/components/custom/config-mera/ReadingMeter';
import { noteBillingTier, resetPlanRiseForTests } from '@/lib/subscription/plan-rise';
import { resetReadHold } from '@/lib/subscription/read-hold';
import { initI18nEn } from '@/test/helpers';

jest.mock('expo-router', () => ({ useFocusEffect: () => {} }));

beforeAll(initI18nEn);
beforeEach(() => {
    resetReadHold();
    resetPlanRiseForTests();
});

it('shows the new-plan line on meters already mounted, not only after a remount', async () => {
    noteBillingTier('starter');
    await render(
        <>
            <ReadingMeter used={0.4} online size="card" />
            <ReadingMeter used={0.4} online size="screen" />
        </>,
    );
    expect(screen.queryByText('Your new plan applies now.')).toBeNull();

    await act(async () => {
        noteBillingTier('individual');
        await new Promise((r) => setTimeout(r, 25));
    });

    expect(screen.getAllByText('Your new plan applies now.')).toHaveLength(2);
});
