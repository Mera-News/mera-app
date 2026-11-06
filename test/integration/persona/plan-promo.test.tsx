// A server-switched promo: its line on the Settings plan card, one Inbox row, and the card's one
// plans button. Real stores, database and Apollo client; the server is faked at the network.
import { act, render, screen } from '@testing-library/react-native';
import React from 'react';
import { router } from 'expo-router';
import SettingsUsageCard from '@/components/custom/config-mera/SettingsUsageCard';
import { ReadHoldFooter } from '@/components/custom/for-you/FeedStatusDetails';
import { runNotificationAction } from '@/components/custom/notifications/notification-actions';
import database from '@/lib/database';
import type NotificationModel from '@/lib/database/models/Notification';
import { deleteByTypes } from '@/lib/database/services/notification-service';
import { deleteSetting } from '@/lib/database/services/setting-service';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { PLAN_PROMO_NOTICE, PLAN_PROMO_SETTING, __resetPlanPromoForTests, syncPlanPromo } from '@/lib/subscription/plan-promo';
import { __setReadingPlansForTests } from '@/lib/subscription/reading-plans';
import { resetReadHold, setReadHold } from '@/lib/subscription/read-hold';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';

jest.mock('expo-router', () => ({
    useFocusEffect: () => undefined,
    router: { push: jest.fn() },
}));

const promoIs = (planPromo: string | null) =>
    server.use(mockGql('GetPlanPromo', { userBilling: { __typename: 'UserBillingInfo', planPromo } }));
const rows = () => database.get<NotificationModel>('notifications').query().fetch();
const promoRows = async () => (await rows()).filter((n) => n.type === PLAN_PROMO_NOTICE);
const LINE = 'Free extra usage for Web Summit';

beforeAll(initI18nEn);
beforeEach(async () => {
    __resetPlanPromoForTests();
    await deleteByTypes([PLAN_PROMO_NOTICE]);
    await deleteSetting(PLAN_PROMO_SETTING);
    useSubscriptionStore.getState().reset();
    jest.mocked(router.push).mockClear();
});
afterEach(() => {
    resetReadHold();
    __setReadingPlansForTests(null);
});

describe('the plan card', () => {
    it('shows the line while the server names a promo, and goes back when it stops', async () => {
        promoIs('web_summit');
        await syncPlanPromo();
        await render(<SettingsUsageCard />);
        expect(screen.getByText(LINE)).toBeTruthy();
        expect(screen.queryByText('Your plan')).toBeNull();

        promoIs(null);
        await act(async () => {
            await syncPlanPromo();
        });
        expect(screen.queryByText(LINE)).toBeNull();
        expect(screen.getByText('Your plan')).toBeTruthy();
    });

    it('shows nothing for a promo this build has no copy for', async () => {
        promoIs('some_later_promo');
        await syncPlanPromo();
        await render(<SettingsUsageCard />);
        expect(screen.getByText('Your plan')).toBeTruthy();
        expect(await promoRows()).toHaveLength(0);
    });

    it('has one See plans button, at the limit too, and no Manage plan', async () => {
        useSubscriptionStore.setState({ serverTier: 'starter' });
        await setReadHold({ resetAt: Date.now() + 3_600_000 });
        await render(<SettingsUsageCard />);
        expect(screen.getAllByText('See plans')).toHaveLength(1);
        expect(screen.queryByText('Manage plan')).toBeNull();
        expect(screen.getByTestId('settings-manage-plan')).toBeTruthy();
    });
});

describe('the Inbox row', () => {
    it('is written once, and a deleted row stays gone', async () => {
        promoIs('web_summit');
        await syncPlanPromo();
        await syncPlanPromo();
        expect(await promoRows()).toHaveLength(1);

        await deleteByTypes([PLAN_PROMO_NOTICE]);
        await syncPlanPromo();
        expect(await promoRows()).toHaveLength(0);
    });

    it('goes when the promo ends, and a failed read changes nothing', async () => {
        promoIs('web_summit');
        await syncPlanPromo();

        server.use(mockGqlError('GetPlanPromo', 'INTERNAL_SERVER_ERROR'));
        await syncPlanPromo();
        expect(await promoRows()).toHaveLength(1);

        promoIs(null);
        await syncPlanPromo();
        expect(await promoRows()).toHaveLength(0);
    });

    it('opens the plan screen', async () => {
        promoIs('web_summit');
        await syncPlanPromo();
        const [row] = await promoRows();
        await runNotificationAction(row, { id: 'open-plans' });
        expect(router.push).toHaveBeenCalledWith('/logged-in/preferences/manage-subscription');
    });
});

describe('the read-again line while Starter equals Individual', () => {
    const line = () => screen.getByTestId('feed-status-reads-again', { includeHiddenElements: true });
    beforeEach(async () => {
        useSubscriptionStore.setState({ serverTier: 'starter' });
        await setReadHold({ resetAt: Date.now() + 3_600_000 });
    });

    it('offers Individual while it is a step up', async () => {
        __setReadingPlansForTests({ starter: 4_000_000, individual: 20_000_000, professional: 100_000_000 });
        await render(<ReadHoldFooter />);
        expect(line()).toHaveTextContent(/or now with Individual/);
    });

    it('drops the offer when the plans are equal', async () => {
        __setReadingPlansForTests({ starter: 20_000_000, individual: 20_000_000, professional: 100_000_000 });
        await render(<ReadHoldFooter />);
        expect(line()).not.toHaveTextContent(/Individual/);
    });
});
