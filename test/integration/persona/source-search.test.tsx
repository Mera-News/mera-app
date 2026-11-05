// Sources search at its seam: real hook and writer on the in-memory database, the server faked at GraphQL.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import { router } from 'expo-router';
import React from 'react';

import SourceSearch from '@/components/custom/publication-preferences/SourceSearch';
import { resetPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { useAppLanguageStore } from '@/lib/stores/app-language-store';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, mockGql, mockGqlError, server } from '@/test/helpers';
import { quietLogger, settleWrites } from '@/test/integration/data/services/persona/support';

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
    subscription_uri: null,
    matchingSources: [],
};
const answer = (publishers: unknown[]) =>
    mockGql('SearchPublishers', {
        searchPublishers: {
            __typename: 'PublisherSearchResponse',
            publishers,
            pageInfo: { __typename: 'PageInfo', endCursor: null, hasNextPage: false, pageSize: 20 },
        },
    });
const catalogue = () =>
    server.use(
        mockGql('PublicationSourcesForNewsPublisher', {
            publicationSourcesForNewsPublisher: {
                __typename: 'PublicationSourcesForPublisherResponse',
                publicationSources: [{ __typename: 'PublicationSource', _id: 's1', publication_name: 'Der Spiegel' }],
            },
        }),
    );

const type = async (text: string) => {
    await act(async () => {
        fireEvent.changeText(screen.getByTestId('sources-search'), text);
    });
};
const press = async (el: Parameters<typeof fireEvent.press>[0]) => {
    await act(async () => {
        await fireEvent.press(el);
    });
    await settleWrites();
};
const NO_RESULTS = "We don't have this publisher yet";
const SLOW = { timeout: 4000 };

let logs: ReturnType<typeof quietLogger>;
beforeAll(initI18nEn);
beforeEach(() => {
    logs = quietLogger();
    resetPublisherSourceNames();
    useAppLanguageStore.setState({ appLanguage: 'en' });
    jest.mocked(router.push).mockClear();
    jest.spyOn(toastManager, 'showUndoToast').mockImplementation(() => undefined);
});
afterEach(async () => {
    await settleWrites();
    jest.restoreAllMocks();
    logs.restore();
});

describe('Sources search', () => {
    it('finds a country by its German name and opens its page with the alpha-3', async () => {
        useAppLanguageStore.setState({ appLanguage: 'de' });
        server.use(answer([]));
        await render(<SourceSearch />);
        await type('Deutschland');
        const row = await screen.findByTestId('sources-country-DEU', {}, SLOW);
        await press(row);
        expect(router.push).toHaveBeenCalledWith({
            pathname: '/logged-in/sources-publishers',
            params: { countryCode: 'DEU', countryName: 'Deutschland' },
        });
    });

    it('stars and hides a publication straight from a hit', async () => {
        catalogue();
        server.use(answer([hit]));
        await render(<SourceSearch />);
        await type('spiegel');
        await screen.findByTestId('sources-hit-pub-1', {}, SLOW);
        await press(screen.getByTestId('sources-hit-pub-1-star'));
        await waitFor(async () => expect(await getPreferenceKind('Der Spiegel')).toBe('boost'));
        await press(screen.getByTestId('sources-hit-pub-1-hide'));
        await waitFor(async () => expect(await getPreferenceKind('Der Spiegel')).toBe('mute'));
    });

    it('does not say "no results" while a country matches', async () => {
        server.use(answer([]));
        await render(<SourceSearch />);
        await type('france');
        await screen.findByTestId('sources-country-FRA', {}, SLOW);
        await act(async () => {
            await new Promise((r) => setTimeout(r, 200));
        });
        expect(screen.queryByText(NO_RESULTS)).toBeNull();
    });

    it('says so when neither list has a match', async () => {
        server.use(answer([]));
        await render(<SourceSearch />);
        await type('zzqq');
        await screen.findByText(NO_RESULTS, {}, SLOW);
    });

    it('onboarding rows have no body button', async () => {
        catalogue();
        server.use(answer([hit]));
        await render(<SourceSearch onboarding />);
        await type('spiegel');
        await screen.findByTestId('sources-hit-pub-1-body', {}, SLOW);
        expect(screen.queryByTestId('sources-hit-pub-1')).toBeNull();
    });

    it('onboarding Try again reruns the query', async () => {
        server.use(mockGqlError('SearchPublishers', 'down'));
        await render(<SourceSearch onboarding />);
        await type('spiegel');
        const retry = await screen.findByTestId('sources-search-retry', {}, SLOW);
        expect(screen.getByText("Couldn't load sources.")).toBeTruthy();
        server.use(answer([hit]));
        await press(retry);
        await screen.findByTestId('sources-hit-pub-1-body', {}, SLOW);
    });
});
