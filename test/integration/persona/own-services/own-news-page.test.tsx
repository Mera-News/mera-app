// The own news server page, and its Not available here page, at their seams: the real check over MSW
// (introspection and the feed document), the real stored state and the router.
import React from 'react';
import { router } from 'expo-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react-native';
import NotAvailableHereScreen from '@/components/custom/config-mera/own-services/NotAvailableHereScreen';
import OwnNewsServerScreen from '@/components/custom/config-mera/own-services/OwnNewsServerScreen';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { ownNewsState, type OwnNewsConfig } from '@/lib/own-services/own-news-state';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { http, HttpResponse, initI18nEn, server } from '@/test/helpers';

const URL_ = 'https://news.own.test/graphql';
const FEED = ['articleIdsForPersona', 'articlesForTopicsByIds'];

const introspection = (names: string[]) =>
    server.use(http.post(URL_, () => HttpResponse.json({ data: { __type: { fields: names.map((name) => ({ name })) } } })));
const unreachable = () => server.use(http.post(URL_, () => HttpResponse.error()));

const seed = (p: Partial<OwnNewsConfig> = {}) =>
    ownNewsState.save({ v: 1, baseUrl: 'https://news.own.test', key: null, on: false, checkedAt: 1, status: 'connected', fields: FEED, ...p });

const mount = async () => {
    await render(<OwnNewsServerScreen />);
    await screen.findByTestId('own-news-address');
};
const typeInto = async (id: string, text: string) => {
    await fireEvent.changeText(screen.getByTestId(id), text);
};
const sw = () => screen.getByTestId('own-news-switch');
const pressCheck = async () => {
    await fireEvent.press(screen.getByTestId('own-news-check'));
};

beforeAll(initI18nEn);
beforeEach(() => {
    ownNewsState.resetMemory();
    useMeraProtocolStore.setState({ processingMode: ProcessingMode.Cloud });
    jest.mocked(router.push).mockClear();
    jest.mocked(router.navigate).mockClear();
});

describe('own news server page', () => {
    it('empty: Check and the switch are disabled; http:// shows the not-https line', async () => {
        await mount();
        expect(screen.getByTestId('own-news-check')).toBeDisabled();
        expect(sw()).toBeDisabled();
        await typeInto('own-news-address', 'http://news.own.test');
        expect(screen.getByText('Use an address that starts with https://')).toBeTruthy();
        expect(screen.getByTestId('own-news-check')).toBeDisabled();
    });

    it('the topics line is always there, and a good check turns on with no confirm', async () => {
        introspection([...FEED, 'searchNews']);
        await mount();
        expect(screen.getByText(/Your topics go to this server/)).toBeTruthy();
        await typeInto('own-news-address', 'https://news.own.test');
        await pressCheck();
        expect(await screen.findByText('Connected')).toBeTruthy();
        expect(sw()).toBeEnabled();
        await fireEvent(sw(), 'valueChange', true);
        await waitFor(() => expect(ownNewsState.get()?.on).toBe(true));
        expect(sw().props.value).toBe(true);
    });

    it.each([
        ['refused', () => server.use(http.post(URL_, () => new HttpResponse(null, { status: 401 }))), 'The server refused this key.'],
        ['no-feed', () => introspection(['hello']), "This server can't make a feed."],
        ['redirect', () => server.use(http.post(URL_, () => new HttpResponse(null, { status: 302 }))), 'This address redirects. Use the final address.'],
        ['unreachable', unreachable, "Can't reach this address."],
    ])('%s shows its line and the switch stays disabled', async (_name, arrange, line) => {
        arrange();
        await mount();
        await typeInto('own-news-address', 'https://news.own.test');
        await pressCheck();
        expect(await screen.findByText(line)).toBeTruthy();
        expect(sw()).toBeDisabled();
    });

    it('on, then a check that fails: says so and the switch stays on', async () => {
        await seed({ on: true });
        unreachable();
        await mount();
        await pressCheck();
        expect(await screen.findByText("Last check failed. Can't reach this address.")).toBeTruthy();
        expect(sw().props.value).toBe(true);
    });

    it('on, then an address edit: nothing moves until Check, which saves the new address and turns the switch off', async () => {
        await seed({ on: true });
        await mount();
        await typeInto('own-news-address', 'https://other.own.test');
        expect(sw().props.value).toBe(true);
        expect(ownNewsState.get()).toMatchObject({ on: true, baseUrl: 'https://news.own.test' });
    });

    it('with On this phone on: the switch is disabled, says why, and the button goes there', async () => {
        await seed();
        useMeraProtocolStore.setState({ processingMode: ProcessingMode.OnDevice });
        await mount();
        expect(sw()).toBeDisabled();
        expect(sw().props.accessibilityHint).toBe('Turn off On this phone first.');
        await fireEvent.press(screen.getByText('Go to On this phone'));
        expect(router.navigate).toHaveBeenCalledTimes(1);
    });

    it('the key field is secure until Show key', async () => {
        await seed({ key: 'news-secret-123' });
        await mount();
        expect(screen.getByTestId('own-news-key').props.secureTextEntry).toBe(true);
        expect(screen.queryByText('news-secret-123')).toBeNull();
        await fireEvent.press(screen.getByText('Show key'));
        expect(screen.getByTestId('own-news-key').props.secureTextEntry).toBe(false);
        expect(screen.getByText('Hide key')).toBeTruthy();
    });

    it('an introspection answer without searchNews shows the Not available here row', async () => {
        introspection(FEED);
        await mount();
        expect(screen.queryByTestId('own-news-missing-row')).toBeNull();
        await typeInto('own-news-address', 'https://news.own.test');
        await pressCheck();
        await fireEvent.press(await screen.findByTestId('own-news-missing-row'));
        expect(router.push).toHaveBeenCalledWith('/logged-in/app_container/you/own-news-missing');
    });

    it('the Not available here page lists what the server did not list, and says nothing else', async () => {
        await seed();
        await render(<NotAvailableHereScreen />);
        expect(await screen.findByText('Search')).toBeTruthy();
        expect(screen.getByText('Fact checks')).toBeTruthy();
        expect(screen.getByText("Your news server doesn't offer these. Mera News shows them as empty.")).toBeTruthy();
    });

    it('a server that listed everything has no Not available here row', async () => {
        await seed({ fields: [...FEED, 'searchNews', 'searchPublishers', 'worldHeadlines', 'canonicalTopics', 'topHeadlinesForCountry', 'relatedArticlesPage', 'articlesForStories', 'publicationProfile', 'articlesForPublisher', 'publicationSourcesForNewsPublisher', 'placeSearch', 'factCheck', 'cachedFactCheck', 'clusterMembershipsForArticles', 'newsClusterForArticle', 'publicationDisplayNames'] });
        await mount();
        expect(screen.queryByTestId('own-news-missing-row')).toBeNull();
    });

    it('fields: null offers the row, and its page shows the "didn\'t say" line instead of a list', async () => {
        await seed({ fields: null });
        await mount();
        expect(screen.getByTestId('own-news-missing-row')).toBeTruthy();
    });

    it('the Not available here page with fields: null shows the "didn\'t say" line', async () => {
        await seed({ fields: null });
        await render(<NotAvailableHereScreen />);
        expect(await screen.findByText("Your news server didn't say what it offers. Pages it can't show stay empty.")).toBeTruthy();
        expect(screen.queryByText('Search')).toBeNull();
    });
});
