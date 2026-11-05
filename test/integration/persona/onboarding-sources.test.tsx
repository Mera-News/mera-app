// The onboarding sources step at its seam: the real wizard, the real search and row writers on the in-memory
// database, the server faked at GraphQL. The chat step is stubbed out; it has its own tests.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import React from 'react';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import { AccountService } from '@/lib/account-service';
import { addFact } from '@/lib/database/services/fact-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getActive, upsertSubscription } from '@/lib/database/services/user-publication-subscription-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useOnboardingStore } from '@/lib/stores/onboarding-store';
import { toastManager } from '@/lib/toast-manager';
import * as subscribeFlow from '@/lib/subscriptions/subscribe-flow';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

jest.mock('@/components/custom/onboarding/PersonaUpdateChatStep', () => ({ __esModule: true, default: () => null }));
jest.mock('@/components/custom/MeraLogo', () => ({ __esModule: true, default: () => null }));
jest.mock('react-native-keyboard-controller', () => ({
    useReanimatedKeyboardAnimation: () => ({ height: { value: 0 }, progress: { value: 0 } }),
}));
jest.mock('react-native/Libraries/Modal/Modal', () => {
    const { View } = jest.requireActual('react-native');
    return { __esModule: true, default: ({ visible, children }: { visible: boolean; children: unknown }) => (visible ? <View>{children}</View> : null) };
});

const hit = {
    __typename: 'PublisherSearchHit',
    _id: 'pub-1',
    name: 'Der Spiegel',
    website_url: 'https://spiegel.de',
    country_code: 'DEU',
    country_name: 'Germany',
    subscription_uri: 'https://spiegel.de/abo',
    matchingSources: [],
};
const useBackend = () =>
    server.use(
        mockGql('SearchPublishers', {
            searchPublishers: {
                __typename: 'PublisherSearchResponse',
                publishers: [hit],
                pageInfo: { __typename: 'PageInfo', endCursor: null, hasNextPage: false, pageSize: 20 },
            },
        }),
        mockGql('PublicationSourcesForNewsPublisher', {
            publicationSourcesForNewsPublisher: {
                __typename: 'PublicationSourcesForPublisherResponse',
                publicationSources: [{ __typename: 'PublicationSource', _id: 's1', publication_name: 'Der Spiegel' }],
            },
        }),
    );

const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
    await act(async () => {
        await fireEvent.press(el);
    });
    await settleWrites();
};
const mountAtSources = async () => {
    await addFact('Lives in Berlin');
    await render(<OnboardingWizard userId="u1" onComplete={() => undefined} />);
    await waitFor(() => screen.getByTestId('onboarding-facts-count'), { timeout: 6000 });
    await waitFor(() => expect(screen.getByTestId('onboarding-facts-count').props.children).toMatch(/1/));
    await press(screen.getByTestId('onboarding-next'));
    await waitFor(() => screen.getByTestId('onboarding-sources-step'));
};
const search = async () => {
    await act(async () => {
        fireEvent.changeText(screen.getByTestId('sources-search'), 'spiegel');
    });
    await waitFor(() => screen.getByTestId('sources-hit-pub-1-star'), { timeout: 4000 });
};
const nextLabel = () => screen.getByTestId('onboarding-next');

jest.setTimeout(30000);
let logs: ReturnType<typeof quietLogger>;
let advance: jest.SpyInstance;
beforeAll(initI18nEn);
beforeEach(() => {
    logs = quietLogger();
    resetPublisherSourceNames();
    useOnboardingStore.getState().resetOnboarding();
    useNetworkStore.setState({ isConnected: true, serverReachable: true, serverSlow: false, internetReachable: true });
    advance = jest.spyOn(AccountService, 'advanceOnboardingStage').mockResolvedValue(undefined as never);
    jest.spyOn(toastManager, 'showInfo').mockImplementation(() => undefined);
    jest.spyOn(toastManager, 'showUndoToast').mockImplementation(() => undefined);
    useBackend();
});
afterEach(async () => {
    cleanup();
    await settleWrites();
    jest.restoreAllMocks();
    logs.restore();
});

describe('onboarding sources step', () => {
    it('Skip with no picks reaches notifications with no stage write', async () => {
        await mountAtSources();
        advance.mockClear();
        expect(screen.getByText('Skip')).toBeTruthy();
        await press(nextLabel());
        await waitFor(() => screen.getByTestId('onboarding-remind'));
        expect(advance).not.toHaveBeenCalled();
    });

    it('a star flips Skip to Next, and clearing it returns Skip', async () => {
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(() => expect(screen.getByText('Skip')).toBeTruthy());
    });

    it('I subscribe writes a subscription without opening the browser, and off removes it', async () => {
        const open = jest.spyOn(subscribeFlow, 'openSubscribePage');
        await mountAtSources();
        await search();
        const toggle = screen.getByTestId('sources-subscribe-pub-1');
        expect(toggle.props.accessibilityRole).toBe('switch');
        await press(toggle);
        await waitFor(async () => expect((await getActive()).map((r) => r.publisherId)).toEqual(['pub-1']));
        expect(open).not.toHaveBeenCalled();
        await waitFor(() => expect(screen.getByTestId('sources-subscribe-pub-1').props.accessibilityState).toMatchObject({ checked: true }));
        await press(screen.getByTestId('sources-subscribe-pub-1'));
        await waitFor(async () => expect(await getActive()).toHaveLength(0));
    });

    it('reopening starts at the chat and the picks survive', async () => {
        await upsertSubscription({ publisherId: 'pub-1', publisherName: 'Der Spiegel', countryCode: 'DEU', subscriptionUri: null, sourceNames: ['Der Spiegel'] });
        await render(<OnboardingWizard userId="u1" onComplete={() => undefined} />);
        await waitFor(() => screen.getByTestId('onboarding-facts-count'), { timeout: 6000 });
        expect(screen.queryByTestId('onboarding-sources-step')).toBeNull();
        expect(await getActive()).toHaveLength(1);
    });

    it('a star on an empty name cache writes every name, though the hit showed one', async () => {
        server.use(
            mockGql('PublicationSourcesForNewsPublisher', {
                publicationSourcesForNewsPublisher: {
                    __typename: 'PublicationSourcesForPublisherResponse',
                    publicationSources: ['Der Spiegel', 'Spiegel Wirtschaft'].map((publication_name, i) => ({ __typename: 'PublicationSource', _id: `s${i}`, publication_name })),
                },
            }),
        );
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(async () => expect(await getPreferenceKind('Spiegel Wirtschaft')).toBe('boost'));
        expect(await getPreferenceKind('Der Spiegel')).toBe('boost');
    });

    it('a refused write says so, leaves the row unset and keeps Skip', async () => {
        server.use(mockGqlError('PublicationSourcesForNewsPublisher', 'down'));
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(() => expect(toastManager.showInfo).toHaveBeenCalledWith("Couldn't save that. Try again."));
        expect(await getPreferenceKind('Der Spiegel')).toBe('none');
        expect(screen.getByTestId('sources-hit-pub-1-star').props.accessibilityState).toMatchObject({ selected: false });
        expect(screen.getByText('Skip')).toBeTruthy();
    });

    it('a hide is a pick, and so is a subscription', async () => {
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        await waitFor(() => expect(screen.getByText('Skip')).toBeTruthy());
        await press(screen.getByTestId('sources-subscribe-pub-1'));
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
    });

    it('a reopened wizard reaches the sources step showing Next for the picks it kept', async () => {
        await upsertSubscription({ publisherId: 'pub-1', publisherName: 'Der Spiegel', countryCode: 'DEU', subscriptionUri: null, sourceNames: ['Der Spiegel'] });
        await mountAtSources();
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
    });

    it('Skip works offline', async () => {
        await mountAtSources();
        act(() => useNetworkStore.setState({ isConnected: false }));
        await waitFor(() => screen.getByText("You're offline. You can add sources later in Sources."));
        advance.mockClear();
        await press(nextLabel());
        await waitFor(() => screen.getByTestId('onboarding-remind'));
        expect(screen.queryByTestId('onboarding-server-error')).toBeNull();
        expect(advance).not.toHaveBeenCalled();
    });
});
