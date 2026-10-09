// The onboarding gate (useOnboardingGate) and the onboarding_done row under it, at their seams:
// real stores, in-memory DB, real settings and fact services, real RevenueCat wrapper over its SDK
// mock, and the mock backend for the entitlement warmup.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react-native';
import Purchases from 'react-native-purchases';
import { __resetLegalConsentLatchForTests } from '@/components/custom/auth/legal-consent';
import { __resetLoggedInGateForTests } from '@/components/custom/auth/useLoggedInGate';
import { useOnboardingGate } from '@/components/custom/onboarding/useOnboardingGate';
import {
    ONBOARDING_DONE_SETTING_KEY,
    isOnboardingDone,
    markOnboardingDone,
} from '@/components/custom/onboarding/onboarding-done';
import database from '@/lib/database';
import { addFact, hasAnyFacts } from '@/lib/database/services/fact-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { configureRevenueCat } from '@/lib/revenuecat';
import { __resetLocalWipeForTests } from '@/lib/security/local-wipe';
import {
    IDENTITY_FAULT_KEY,
    __resetIdentityStateForTests,
    readPendingAuthUserId,
    recordAuthenticatedUser,
} from '@/lib/security/identity-gate';
import { useNetworkStore } from '@/lib/stores/network-store';
import { usePinStore } from '@/lib/stores/pin-store';
import { useUserStore } from '@/lib/stores/user-store';
import { FIXTURE_ACCOUNT, server } from '@/test/helpers';

const ME = FIXTURE_ACCOUNT.userId;
const FOREIGN = '66e2e0000000000000000002';

let inFlight = 0;
const onStart = () => {
    inFlight += 1;
};
const onEnd = () => {
    inFlight -= 1;
};
/** Waits until no request is in flight for three consecutive ticks (bounded). */
async function drain(): Promise<void> {
    for (let quiet = 0, spent = 0; quiet < 3 && spent < 3000; spent += 25) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        quiet = inFlight === 0 ? quiet + 1 : 0;
    }
}

/** Names of the GraphQL operations the app sends from now on. */
const stopRecording: (() => void)[] = [];
function recordOps(): string[] {
    const ops: string[] = [];
    const listener = ({ request }: { request: Request }) => {
        if (!request.url.endsWith('/graphql')) return;
        void request
            .clone()
            .json()
            .then((b: { operationName?: string }) => {
                if (b.operationName) ops.push(b.operationName);
            });
    };
    server.events.on('request:start', listener);
    stopRecording.push(() => server.events.removeListener('request:start', listener));
    return ops;
}

const spies: jest.SpyInstance[] = [];

beforeAll(() => {
    server.events.on('request:start', onStart);
    server.events.on('request:end', onEnd);
    configureRevenueCat();
});

afterAll(() => {
    server.events.removeListener('request:start', onStart);
    server.events.removeListener('request:end', onEnd);
});

beforeEach(() => {
    inFlight = 0;
    __resetIdentityStateForTests();
    __resetLoggedInGateForTests();
    __resetLocalWipeForTests();
    __resetLegalConsentLatchForTests();
    usePinStore.setState({ pinSet: false, lockEnabled: false, locked: false, lastBackgroundedAt: null, initialized: false });
    useUserStore.setState({
        userId: null,
        userEmail: null,
        userPersona: null,
        isLoading: false,
        lastFetchedAt: null,
        needsReauth: false,
    });
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
});

afterEach(async () => {
    cleanup();
    jest.useRealTimers();
    await drain();
    while (stopRecording.length) stopRecording.pop()?.();
    while (spies.length) spies.pop()?.mockRestore();
});

function mountGate(over: Partial<Parameters<typeof useOnboardingGate>[0]> = {}) {
    const onLoginRedirect = jest.fn();
    const onComplete = jest.fn();
    const hook = renderHook(() =>
        useOnboardingGate({ userId: ME, sessionUserId: ME, onLoginRedirect, onComplete, ...over }),
    );
    return { ...hook, onLoginRedirect, onComplete };
}

describe('useOnboardingGate', () => {
    it('not done: shows the wizard and fires the entitlement warmup (RevenueCat login and a billing sync)', async () => {
        const ops = recordOps();
        await setSetting('cached_user_id', ME);

        const { result, onComplete, onLoginRedirect } = mountGate();
        await waitFor(() => expect(result.current.showOnboarding).toBe(true), { timeout: 8000 });
        await drain();

        expect(result.current.isCheckingOnboarding).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
        expect(onLoginRedirect).not.toHaveBeenCalled();
        // Without the RevenueCat login a later purchase attaches to the anonymous customer.
        expect(Purchases.logIn).toHaveBeenCalledWith(ME);
        expect(ops).toContain('GetUserBilling');
    });

    it('done: completes once and never shows the wizard or warms the entitlement', async () => {
        const ops = recordOps();
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();

        const { result, onComplete } = mountGate();
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 8000 });
        await drain();

        expect(onComplete).toHaveBeenCalledTimes(1);
        expect(result.current.showOnboarding).toBe(false);
        // The spinner stays mounted: onComplete replaces the route, a blank frame would flash.
        expect(result.current.isCheckingOnboarding).toBe(true);
        expect(Purchases.logIn).not.toHaveBeenCalled();
        expect(ops).not.toContain('GetUserBilling');
    });

    it('a device with facts but no onboarding_done row is done, and the row is written', async () => {
        await setSetting('cached_user_id', ME);
        await addFact('I follow Formula 1 racing');
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBeNull();

        const { onComplete, result } = mountGate();
        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), { timeout: 8000 });

        expect(result.current.showOnboarding).toBe(false);
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBe('true');
    });

    it('an identity fault, online, hands the person to sign-in and neither completes nor shows the wizard', async () => {
        await setSetting('cached_user_id', ME);
        await setSetting(IDENTITY_FAULT_KEY, '1');

        const { result, onLoginRedirect, onComplete } = mountGate();
        await waitFor(() => expect(onLoginRedirect).toHaveBeenCalledTimes(1), { timeout: 8000 });
        await drain();

        expect(onComplete).not.toHaveBeenCalled();
        expect(result.current.showOnboarding).toBe(false);
        expect(result.current.isCheckingOnboarding).toBe(true);
    });

    it('a foreign cached id with the incoming session wipes the previous account first, then adopts the new id', async () => {
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        // The previous owner is "done": the new account must not inherit that.
        await markOnboardingDone();

        const { result, onComplete } = mountGate();
        await waitFor(() => expect(result.current.showOnboarding).toBe(true), { timeout: 8000 });
        await drain();

        expect(await hasAnyFacts()).toBe(false);
        expect(useUserStore.getState().userId).toBe(ME);
        await waitFor(async () => expect(await getSetting('cached_user_id')).toBe(ME));
        expect(onComplete).not.toHaveBeenCalled();
        expect(Purchases.logOut).toHaveBeenCalled();
    });

    it('a recorded sign-in is consumed once the id it proved is the one stamped', async () => {
        recordAuthenticatedUser(ME);

        const { result } = mountGate({ sessionUserId: undefined });
        await waitFor(() => expect(result.current.showOnboarding).toBe(true), { timeout: 8000 });

        expect(readPendingAuthUserId()).toBeNull();
        expect(useUserStore.getState().userId).toBe(ME);
    });

    it('a wipe that throws fails closed: no wizard, no completion, the previous owner stays; Try again recovers', async () => {
        await setSetting('cached_user_id', FOREIGN);
        await addFact('I follow cricket');
        await markOnboardingDone();
        spies.push(jest.spyOn(database, 'unsafeResetDatabase').mockRejectedValueOnce(new Error('db busy')));

        const { result, onComplete } = mountGate();
        await waitFor(() => expect(result.current.wipeFailed).toBe(true), { timeout: 8000 });
        await drain();

        // The done row and the facts are device-global: reading them here would complete onboarding
        // for somebody who never did it.
        expect(onComplete).not.toHaveBeenCalled();
        expect(result.current.showOnboarding).toBe(false);
        expect(await getSetting('cached_user_id')).toBe(FOREIGN);
        expect(await hasAnyFacts()).toBe(true);

        act(() => result.current.handleRetry());
        await waitFor(() => expect(result.current.showOnboarding).toBe(true), { timeout: 8000 });

        expect(result.current.wipeFailed).toBe(false);
        expect(await hasAnyFacts()).toBe(false);
        expect(onComplete).not.toHaveBeenCalled();
    });

    it('re-rendering with new handler identities does not restart the gate, and the LATEST handler is the one called', async () => {
        await setSetting('cached_user_id', ME);
        await markOnboardingDone();
        const first = jest.fn();
        const second = jest.fn();
        const { rerender } = renderHook(
            ({ onComplete }: { onComplete: () => void }) =>
                useOnboardingGate({ userId: ME, sessionUserId: ME, onLoginRedirect: jest.fn(), onComplete }),
            { initialProps: { onComplete: first } },
        );

        rerender({ onComplete: second });
        await waitFor(() => expect(second).toHaveBeenCalledTimes(1), { timeout: 8000 });
        await drain();

        expect(first).not.toHaveBeenCalled();
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('finishing the wizard hides it and completes', async () => {
        await setSetting('cached_user_id', ME);
        const { result, onComplete } = mountGate();
        await waitFor(() => expect(result.current.showOnboarding).toBe(true), { timeout: 8000 });

        act(() => result.current.handleOnboardingComplete());

        expect(result.current.showOnboarding).toBe(false);
        expect(onComplete).toHaveBeenCalledTimes(1);
    });
});

// The row behind the gate. A new device is not done; a finished wizard is done even with zero facts;
// a device that already has facts migrates to done and the row is written then.
describe('onboarding_done', () => {
    it('a new device with no row and no facts is not done', async () => {
        await expect(isOnboardingDone()).resolves.toBe(false);
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBeNull();
    });

    it('a finished wizard is done, even with zero facts', async () => {
        await markOnboardingDone();
        await expect(isOnboardingDone()).resolves.toBe(true);
        expect(await hasAnyFacts()).toBe(false);
    });

    it('migrates a device that already has facts and writes the row', async () => {
        await addFact('I follow Formula 1 racing');
        await expect(isOnboardingDone()).resolves.toBe(true);
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBe('true');
    });
});
