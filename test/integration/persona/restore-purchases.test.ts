/* eslint-disable import/first, @typescript-eslint/no-require-imports -- the Intercom env must be set before the app modules load */
// Settings > Restore purchases (the hook), and Intercom's login payload. Edges faked: the RevenueCat and
// Intercom SDKs (setup mocks). Real: stores, toast queue, restart holds, Apollo over MSW.
process.env.EXPO_PUBLIC_INTERCOM_APP_ID = 'test_intercom_app';
process.env.EXPO_PUBLIC_INTERCOM_IOS_KEY = 'test_intercom_ios_key';

import Purchases from 'react-native-purchases';
import { act, renderHook } from '@testing-library/react-native';
import { Platform } from 'react-native';
import { useRestorePurchases } from '@/components/custom/config-mera/useRestorePurchases';
import { __resetAppRestartForTests, activeHolds } from '@/lib/app-restart';
import { useSubscriptionStore } from '@/lib/stores/subscription-store';
import { resetEntitlementSyncState } from '@/lib/subscription/entitlement-sync';
import { toastManager } from '@/lib/toast-manager';
import { resetToastQueue, toastApi, useToastQueue } from '@/lib/toast/toast-queue';
import { initI18nEn, useFakeClock } from '@/test/helpers';

const restorePurchases = (Purchases as unknown as { restorePurchases: jest.Mock }).restorePurchases;
const originalOS = Platform.OS;

const textOf = (node: unknown): string[] => {
    if (node == null || typeof node === 'boolean') return [];
    if (typeof node === 'string' || typeof node === 'number') return [String(node)];
    if (Array.isArray(node)) return node.flatMap(textOf);
    return textOf((node as { props?: { children?: unknown } }).props?.children);
};
const toastTitles = () => useToastQueue.getState().entries.map((e) => textOf(e.render({ id: e.id }))[0]);
const setOS = (os: 'ios' | 'android') => {
    Object.defineProperty(Platform, 'OS', { configurable: true, get: () => os });
};
const run = async () => {
    const hook = renderHook(() => useRestorePurchases());
    await act(async () => {
        await hook.result.current.restore();
    });
    return hook;
};

beforeAll(async () => {
    await initI18nEn();
    toastManager.setToastInstance(toastApi);
    require('@/components/ui/toast');
}, 60_000);

beforeEach(() => {
    // The purchase hold arms a five-minute ceiling timer and toasts arm their own: on a real
    // clock they keep the worker alive after the run ("Jest did not exit").
    useFakeClock(Date.now(), { advanceTimers: true });
    __resetAppRestartForTests();
    resetEntitlementSyncState();
    useSubscriptionStore.getState().reset();
    resetToastQueue();
});

afterEach(() => {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: originalOS, writable: true });
});

describe('restore purchases', () => {
    it('a restored paid plan refreshes the entitlement and says the plan is back', async () => {
        const info = { entitlements: { active: { 'mera-news-individual-plan': { isActive: true } } } };
        restorePurchases.mockResolvedValueOnce(info);

        const hook = await run();

        expect(useSubscriptionStore.getState().customerInfo).toEqual(info);
        expect(toastTitles()).toEqual(['Your plan is back.']);
        expect(hook.result.current.restoring).toBe(false);
        // The Apple Account sheet is a departure: the restart hold is taken for the call.
        expect(activeHolds()).toContain('purchase');
    });

    it.each([
        ['ios', 'No plan found on this Apple Account.'],
        ['android', 'No plan found on this Google Account.'],
    ] as const)('finding nothing on %s names the store account', async (os, title) => {
        setOS(os);
        restorePurchases.mockResolvedValueOnce({ entitlements: { active: {} } });
        await run();
        expect(toastTitles()).toEqual([title]);
    });

    it.each([
        ['ios', "Couldn't reach the App Store. Try again."],
        ['android', "Couldn't reach Google Play. Try again."],
    ] as const)('a failure on %s names the store', async (os, title) => {
        setOS(os);
        restorePurchases.mockRejectedValueOnce(new Error('network'));
        const hook = await run();
        expect(toastTitles()).toEqual([title]);
        expect(hook.result.current.restoring).toBe(false);
    });
});

describe('Intercom login', () => {
    it('sends the user id and never an email', async () => {
        // Fresh registry: the Intercom keys are read when lib/config/endpoints first loads.
        jest.resetModules();
        const { useUserStore: freshUserStore } = require('@/lib/stores/user-store') as typeof import('@/lib/stores/user-store');
        freshUserStore.setState({ userId: 'user-1', userEmail: 'someone@example.com' });
        const intercom = require('@/lib/intercom') as typeof import('@/lib/intercom');
        expect(intercom.isIntercomEnabled()).toBe(true);

        expect(await intercom.presentIntercomMessenger()).toBe(true);

        const Intercom = require('@intercom/intercom-react-native').default as typeof import('@intercom/intercom-react-native').default;
        const login = Intercom.loginUserWithUserAttributes as jest.Mock;
        expect(login).toHaveBeenCalledTimes(1);
        expect(login.mock.calls[0][0]).toMatchObject({ userId: 'user-1' });
        expect(login.mock.calls[0][0]).not.toHaveProperty('email');
    });
});
