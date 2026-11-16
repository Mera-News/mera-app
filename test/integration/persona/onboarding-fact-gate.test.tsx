// Step 1's fact gate at the wizard seam: Next waits for one fact, the home chip or the picker supplies it,
// finishing is local-first, and the wizard opens without waiting for the network.
import { fireEvent, render, screen, waitFor, act } from '@testing-library/react-native';
import { getLocales } from 'expo-localization';
import React from 'react';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import { ONBOARDING_DONE_SETTING_KEY } from '@/components/custom/onboarding/onboarding-done';
import {
    PENDING_HOURS_SETTING_KEY,
} from '@/components/custom/onboarding/pending-notification-hours';
import { AccountService } from '@/lib/account-service';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { getAll as getLocations } from '@/lib/database/services/location-service';
import { getSetting } from '@/lib/database/services/setting-service';
import * as notificationService from '@/lib/notification-service';
import { CANONICAL_LOCATION_KEY } from '@/lib/mera-harness/core/combined-fact';
import { useCloudChatStore } from '@/lib/stores/cloud-chat-store';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useOnboardingStore } from '@/lib/stores/onboarding-store';
import { useUserStore } from '@/lib/stores/user-store';
import * as chatCloud from '@/lib/llm/chat-cloud';
import { initI18nEn, signInFixtureAccount } from '@/test/helpers';
import { settleWrites } from '@/test/integration/data/services/persona/support';

jest.mock('react-native-keyboard-controller', () => ({
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
// Counts mounts: the real step opens a fresh conversation on every mount, so a remount loses the thread.
const mockChatMounts = { mounted: 0, unmounted: 0 };
jest.mock('@/components/custom/onboarding/PersonaUpdateChatStep', () => {
    const R = jest.requireActual('react');
    return {
        __esModule: true,
        default: () => {
            R.useEffect(() => {
                mockChatMounts.mounted += 1;
                return () => {
                    mockChatMounts.unmounted += 1;
                };
            }, []);
            return null;
        },
    };
});
jest.mock('@/components/custom/config-mera/NotificationSettingsScreen', () => ({ __esModule: true, default: () => null }));
// The picker's place search is a network edge.
jest.mock('@/lib/place-service', () => ({
    ...jest.requireActual('@/lib/place-service'),
    searchPlaces: async () => ({
        ok: true,
        places: [{ _id: 'p1', displayName: 'Amsterdam, Netherlands', city: 'Amsterdam', region: 'North Holland', countryCode: 'NL' }],
    }),
}));

const region = (regionCode: string | null) =>
    jest.mocked(getLocales).mockReturnValue([{ languageCode: 'en', regionCode, languageTag: 'en' }] as never);
const open = async (onComplete = jest.fn()) => {
    await render(<OnboardingWizard userId="user-1" onComplete={onComplete} />);
    await screen.findByTestId('onboarding-next');
    return onComplete;
};
const nextDisabled = () => !!screen.getByTestId('onboarding-next').props.accessibilityState?.disabled;
const toLastStep = async () => {
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-sources-step');
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await screen.findByTestId('onboarding-remind');
};
const finish = async () => {
    await fireEvent.press(screen.getByTestId('onboarding-next'));
    await fireEvent.press(await screen.findByTestId('onboarding-guard-notifications-secondary'));
};

jest.setTimeout(30_000);
let advance: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(() => {
    mockChatMounts.mounted = 0;
    mockChatMounts.unmounted = 0;
    region('NL');
    useOnboardingStore.getState().resetOnboarding();
    useCloudChatStore.getState().reset();
    useNetworkStore.setState({ isConnected: true });
    advance = jest.spyOn(AccountService, 'advanceOnboardingStage').mockResolvedValue(undefined as never);
    jest.spyOn(notificationService, 'ensurePushTokenRegistered').mockResolvedValue(undefined as never);
});
afterEach(async () => {
    jest.restoreAllMocks();
    useNetworkStore.setState({ isConnected: true });
    await settleWrites();
});

describe('the fact gate', () => {
    it('Next is disabled with zero facts, hints why, and enables at the first fact', async () => {
        await open();
        expect(nextDisabled()).toBe(true);
        expect(screen.getByTestId('onboarding-next').props.accessibilityHint).toBe('Tell Mera one thing so your feed is yours.');
        await fireEvent.press(screen.getByTestId('onboarding-next'));
        expect(screen.queryByTestId('onboarding-sources-step')).toBeNull();

        await act(async () => {
            await addFact('I follow Formula 1 racing');
        });
        await waitFor(() => expect(nextDisabled()).toBe(false));
        expect(screen.getByTestId('onboarding-next').props.accessibilityHint).toBeUndefined();
    });

    it('the block shows the hint, chip and privacy line at zero facts, and the chip saves the home fact with no chat turn', async () => {
        await open();
        expect(screen.getByText('Tell Mera one thing so your feed is yours.')).toBeTruthy();
        expect(screen.getByText('What you tell Mera stays on this phone. Mera uses it to read the news for you.')).toBeTruthy();

        await fireEvent.press(await screen.findByTestId('home-country-chip'));

        await waitFor(() => expect(nextDisabled()).toBe(false));
        const facts = await getFacts();
        expect(facts).toHaveLength(1);
        expect(facts[0].questionnaireAttribute).toBe(CANONICAL_LOCATION_KEY);
        expect(useCloudChatStore.getState().messages).toEqual([]);
        expect(screen.queryByTestId('onboarding-zero-block')).toBeNull();
    });

    it('a reader with a fact sees no block', async () => {
        await addFact('I follow Formula 1 racing');
        await open();
        await waitFor(() => expect(nextDisabled()).toBe(false));
        expect(screen.queryByTestId('onboarding-zero-block')).toBeNull();
    });
});

describe('the picker fallback', () => {
    it('shows no picker for a healthy chat', async () => {
        await open();
        expect(screen.queryByTestId('onboarding-home-picker')).toBeNull();
    });

    it('a chat error shows the picker, and saving from it writes the home location and the fact', async () => {
        await open();
        await act(async () => useCloudChatStore.setState({ error: 'boom' }));
        await screen.findByTestId('onboarding-home-picker');
        expect(mockChatMounts.unmounted).toBe(0);
        expect(screen.getByText('Mera is taking a while. Pick where you live instead.')).toBeTruthy();

        await fireEvent.changeText(screen.getByPlaceholderText('Search for a city'), 'amsterdam');
        await fireEvent.press(await screen.findByText('Amsterdam, Netherlands', undefined, { timeout: 4000 }));
        expect(screen.queryByText('What is this place to you?')).toBeNull(); // fixed to home
        await fireEvent.press(screen.getByTestId('locations-save'));

        await waitFor(() => expect(nextDisabled()).toBe(false));
        const locs = await getLocations();
        expect(locs).toHaveLength(1);
        expect(locs[0].role).toBe('home');
        const facts = await getFacts();
        expect(facts.map((f) => f.statement)).toEqual(['Lives in Amsterdam, Netherlands']);
        expect(facts[0].questionnaireAttribute).toBe(CANONICAL_LOCATION_KEY);
    });

    it('a turn active for 8 seconds shows the picker, and it goes when the turn settles', async () => {
        await open();
        jest.useFakeTimers();
        try {
            await act(async () => useCloudChatStore.setState({ status: 'streaming' }));
            await act(async () => void jest.advanceTimersByTime(7_000));
            expect(screen.queryByTestId('onboarding-home-picker')).toBeNull();
            await act(async () => void jest.advanceTimersByTime(1_500));
            expect(screen.getByTestId('onboarding-home-picker')).toBeTruthy();
            await act(async () => useCloudChatStore.setState({ status: 'idle' }));
            expect(screen.queryByTestId('onboarding-home-picker')).toBeNull();
            // The chat step was never unmounted, so its conversation and any fact card survive the picker.
            expect(mockChatMounts).toEqual({ mounted: 1, unmounted: 0 });
        } finally {
            jest.useRealTimers();
        }
    });

    it('on-device chat with no phone region still shows the picker at once, and saving enables Next', async () => {
        region(null);
        jest.spyOn(chatCloud, 'useChatRunsInCloud').mockReturnValue(false);
        await open();
        expect(screen.queryByTestId('home-country-chip')).toBeNull();
        await screen.findByTestId('onboarding-home-picker');
        await fireEvent.changeText(screen.getByPlaceholderText('Search for a city'), 'amsterdam');
        await fireEvent.press(await screen.findByText('Amsterdam, Netherlands', undefined, { timeout: 4000 }));
        await fireEvent.press(screen.getByTestId('locations-save'));
        await waitFor(() => expect(nextDisabled()).toBe(false));
    });

    it('a blocked chat shows the picker at once', async () => {
        await open();
        await act(async () => useCloudChatStore.setState({ isBlocked: true }));
        await screen.findByTestId('onboarding-home-picker');
    });
});

describe('finishing is local-first', () => {
    beforeEach(async () => {
        await addFact('I follow Formula 1 racing');
    });

    it('offline: marks done, completes, shows no dialog, and keeps the chosen hours to resend', async () => {
        const onComplete = await open();
        await waitFor(() => expect(nextDisabled()).toBe(false));
        await toLastStep();
        await act(async () => useOnboardingStore.getState().updatePreferences('notificationHours', [8, 20]));
        useNetworkStore.setState({ isConnected: false });
        const update = jest.spyOn(AccountService, 'updateNotificationPreferences').mockResolvedValue(undefined as never);

        await finish();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBe('true');
        await settleWrites();
        expect(update).not.toHaveBeenCalled();
        expect(await getSetting(PENDING_HOURS_SETTING_KEY)).not.toBeNull();

        // The launch gate sends them once online (launch-gate.test.ts).
    });

    it('a server failure on the background calls never blocks completion or shows a dialog', async () => {
        advance.mockRejectedValue(new Error('down'));
        jest.spyOn(AccountService, 'updateNotificationPreferences').mockRejectedValue(new Error('down'));
        const onComplete = await open();
        await waitFor(() => expect(nextDisabled()).toBe(false));
        await toLastStep();

        await finish();

        await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
    });
});

describe('start-up never waits on the network', () => {
    it('a hung persona fetch still shows the step at once', async () => {
        await signInFixtureAccount();
        const persona = jest.spyOn(AccountService, 'getUserPersona').mockReturnValue(new Promise(() => {}) as never);
        useUserStore.setState({ userPersona: null } as never);
        await render(<OnboardingWizard userId="user-1" onComplete={jest.fn()} />);
        expect(await screen.findByTestId('onboarding-next', undefined, { timeout: 1000 })).toBeTruthy();
        await waitFor(() => expect(persona).toHaveBeenCalled());
    });

    it('opening the wizard marks it in progress, so a relaunch with the chip fact returns here', async () => {
        await open();
        expect(await getSetting(ONBOARDING_DONE_SETTING_KEY)).toBe('false');
    });
});
