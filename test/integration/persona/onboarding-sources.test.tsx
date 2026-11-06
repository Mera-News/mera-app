// The onboarding sources step at its seam: the real wizard, the real search and row writers on the in-memory
// database, the server faked at GraphQL. The chat step is stubbed out; it has its own tests.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';
import { StyleSheet } from 'react-native';

import OnboardingWizard from '@/components/custom/onboarding/OnboardingWizard';
import PublicationFeedControl from '@/components/custom/publication-page/PublicationFeedControl';
import { usePublicationPage } from '@/components/custom/publication-page/usePublicationPage';
import { AccountService } from '@/lib/account-service';
import { addFact } from '@/lib/database/services/fact-service';
import { getPreferenceKind, setPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getActive, upsertSubscription } from '@/lib/database/services/user-publication-subscription-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useOnboardingStore } from '@/lib/stores/onboarding-store';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';
import { articleFixtures } from '@/test/mock-backend/fixtures/articles';

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
/** The page's Subscribed button on the page's own hook. The page itself needs a route, which no test here has. */
const PageSubscribed: React.FC<{ publisherId: string }> = ({ publisherId }) => {
    const page = usePublicationPage({ publisherId, order: 'NEWEST', focused: true });
    return (
        <PublicationFeedControl
            current={page.pref.level}
            muted={page.pref.muted}
            subscribed={page.subscribed}
            canSubscribe={!!page.subscribeTarget}
            subscribeBusy={page.subscribeBusy}
            onToggleSubscribed={page.toggleSubscribed}
            onChange={() => undefined}
        />
    );
};

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

    it('rows are star and hide with no subscribe footer, and a name opens the publication page', async () => {
        await mountAtSources();
        await search();
        expect(screen.queryByText('I subscribe')).toBeNull();
        expect(screen.queryByTestId('sources-subscribe-pub-1')).toBeNull();
        expect(screen.getByTestId('sources-hit-pub-1-hide')).toBeTruthy();
        jest.mocked(router.push).mockClear();
        await press(screen.getByTestId('sources-hit-pub-1'));
        expect(router.push).toHaveBeenCalledWith(
            expect.objectContaining({ pathname: '/logged-in/publication', params: expect.objectContaining({ publisherId: 'pub-1' }) }),
        );
    });

    // Only the press is here: a remount on a real Back needs a real navigator, so that half is a device check.
    it('opening a name leaves the step, its search and its results as they were', async () => {
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1'));
        expect(screen.getByTestId('onboarding-sources-step')).toBeTruthy();
        expect(screen.getByTestId('sources-search').props.value).toBe('spiegel');
        expect(screen.getByTestId('sources-search-panel')).toBeTruthy();
    });

    it('marking Subscribed on the real page shows under Your sources and turns Skip into Next', async () => {
        const [pub] = articleFixtures.publications;
        await addFact('Lives in Berlin');
        await render(
            <>
                <OnboardingWizard userId="u1" onComplete={() => undefined} />
                <PageSubscribed publisherId={pub.publisherId} />
            </>,
        );
        await waitFor(() => expect(screen.getByTestId('onboarding-facts-count').props.children).toMatch(/1/), { timeout: 6000 });
        await press(screen.getByTestId('onboarding-next'));
        await waitFor(() => screen.getByTestId('onboarding-sources-step'));
        expect(screen.getByText('Skip')).toBeTruthy();

        await waitFor(() => expect(screen.getByTestId('publication-pref-subscribed').props.accessibilityState).toMatchObject({ disabled: false }), { timeout: 6000 });
        await press(screen.getByTestId('publication-pref-subscribed'));

        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
        expect(screen.getByTestId(`onboarding-pick-subscription:${pub.publisherId}`)).toBeTruthy();
    });

    it('results float in a panel that stays open on a star, and the pick shows under Your sources once the search is cleared', async () => {
        await mountAtSources();
        await search();
        expect(screen.getByTestId('sources-search-panel')).toBeTruthy();
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
        expect(screen.getByTestId('sources-search-panel')).toBeTruthy();
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        expect(screen.getByTestId('sources-search-panel')).toBeTruthy();
        await act(async () => {
            fireEvent.changeText(screen.getByTestId('sources-search'), '');
        });
        expect(screen.queryByTestId('sources-search-panel')).toBeNull();
        expect(screen.getByText('Your sources')).toBeTruthy();
        expect(screen.getByTestId('onboarding-pick-publisher:pub-1')).toBeTruthy();
    });

    it('a tap outside closes the panel but keeps the query, and typing opens it again', async () => {
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-search-backdrop'));
        expect(screen.queryByTestId('sources-search-panel')).toBeNull();
        expect(screen.getByTestId('sources-search').props.value).toBe('spiegel');
        await act(async () => {
            fireEvent.changeText(screen.getByTestId('sources-search'), 'spiegel ');
        });
        expect(screen.getByTestId('sources-search-panel')).toBeTruthy();
    });

    it('the panel sits under the field, so a tap on the field never lands on the backdrop', async () => {
        await mountAtSources();
        await search();
        await act(async () => {
            fireEvent(screen.getByTestId('sources-search'), 'layout', { nativeEvent: { layout: { x: 0, y: 0, width: 300, height: 54 } } });
        });
        const top = (id: string) => (StyleSheet.flatten(screen.getByTestId(id).props.style) as { top: number }).top;
        expect(top('sources-search-panel')).toBe(54);
        expect(top('sources-search-backdrop')).toBe(54);
    });

    it('the clear button empties the field and closes the panel, and shows only with a query', async () => {
        await mountAtSources();
        expect(screen.queryByTestId('sources-search-clear')).toBeNull();
        await search();
        expect(screen.getByTestId('sources-search-clear').props.accessibilityLabel).toBe('Close');
        await press(screen.getByTestId('sources-search-clear'));
        expect(screen.getByTestId('sources-search').props.value).toBe('');
        expect(screen.queryByTestId('sources-search-panel')).toBeNull();
        expect(screen.queryByTestId('sources-search-clear')).toBeNull();
    });

    it('picks under the open panel are out of the accessibility tree, and come back when it closes', async () => {
        await upsertSubscription({ publisherId: 'pub-2', publisherName: 'Die Zeit', countryCode: 'DEU', subscriptionUri: null, sourceNames: ['Die Zeit'] });
        await mountAtSources();
        expect(screen.getByTestId('onboarding-pick-subscription:pub-2-star')).toBeTruthy();
        await search();
        expect(screen.queryByTestId('onboarding-pick-subscription:pub-2-star')).toBeNull();
        expect(screen.getByTestId('onboarding-pick-subscription:pub-2-star', { includeHiddenElements: true })).toBeTruthy();
        await press(screen.getByTestId('sources-search-clear'));
        expect(screen.getByTestId('onboarding-pick-subscription:pub-2-star')).toBeTruthy();
    });

    it('a pick with no known publisher can still be changed, under the name it was stored by', async () => {
        server.use(
            mockGql('PublicationSourcesForNewsPublisher', {
                publicationSourcesForNewsPublisher: { __typename: 'PublicationSourcesForPublisherResponse', publicationSources: [] },
            }),
        );
        await setPreferenceKind('Axel Springer', 'boost');
        await mountAtSources();
        await press(screen.getByTestId('onboarding-pick-name:axel springer-star'));
        await waitFor(async () => expect(await getPreferenceKind('Axel Springer')).toBe('none'));
        expect(toastManager.showInfo).not.toHaveBeenCalled();
    });

    it('a pick can be changed right in Your sources', async () => {
        await upsertSubscription({ publisherId: 'pub-1', publisherName: 'Der Spiegel', countryCode: 'DEU', subscriptionUri: null, sourceNames: ['Der Spiegel'] });
        await mountAtSources();
        await press(screen.getByTestId('onboarding-pick-subscription:pub-1-star'));
        await waitFor(async () => expect(await getPreferenceKind('Der Spiegel')).toBe('boost'));
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

    it('a hide is a pick', async () => {
        await mountAtSources();
        await search();
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        await waitFor(() => expect(screen.getByText('Next')).toBeTruthy());
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        await waitFor(() => expect(screen.getByText('Skip')).toBeTruthy());
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
