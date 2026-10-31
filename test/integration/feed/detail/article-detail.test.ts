// useArticleDetailScreen: the server article, the local snapshot fallbacks, offline and
// reconnect, save and the visit a "Read" tap records. Real stores, in-memory DB, MSW; the only
// fakes are the native edges (expo-web-browser).
import { act, renderHook, waitFor } from '@testing-library/react-native';
import * as WebBrowser from 'expo-web-browser';
import { useArticleDetailScreen } from '@/components/custom/news-detail/useArticleDetailScreen';
import { getAllVisitedArticles, recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import {
    isSuggestionSaved,
    keepArticleForTrackedStory,
    saveSuggestion,
} from '@/lib/database/services/saved-article-suggestion-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { ARTICLE_IDS } from '@/test/mock-backend/fixtures/articles';
import { graphql, HttpResponse, initI18nEn, signInFixtureAccount, server } from '@/test/helpers';
import { seedSuggestion } from './seed';

const SERVER_ID = ARTICLE_IDS[0];
const UNAVAILABLE = 'This article is no longer available';

const mount = (articleId: string) => renderHook(() => useArticleDetailScreen({ articleId }));

/** Every GetArticleById id the server is asked for from now on. With `hold`, each answer waits
 *  for it, so a test can see the screen while the request is still open. */
function recordArticleRequests(hold?: Promise<void>): string[] {
    const asked: string[] = [];
    server.use(
        graphql.operation(async ({ operationName, variables }) => {
            if (operationName === 'GetArticleById') {
                asked.push(variables.id);
                await hold;
            }
            return undefined; // fall through to the default handler
        }),
    );
    return asked;
}

/** A promise the test resolves by hand. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
    let resolve!: () => void;
    const promise = new Promise<void>((r) => (resolve = r));
    return { promise, resolve };
}

const setConnected = (connected: boolean) => act(() => useNetworkStore.getState().setIsConnected(connected));

const saved = async (id: string, over: Record<string, unknown> = {}) =>
    saveSuggestion(await seedSuggestion({ _id: id, article_url: 'https://example.com/saved', ...over } as never));

beforeAll(initI18nEn);
beforeEach(async () => {
    await signInFixtureAccount();
    useNetworkStore.setState({ isConnected: true });
});

describe('online', () => {
    it('loads the article from the server', async () => {
        const answer = deferred();
        const asked = recordArticleRequests(answer.promise);
        const { result } = await mount(SERVER_ID);
        expect(result.current.isLoading).toBe(true);
        answer.resolve();
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.article?._id).toBe(SERVER_ID);
        expect(result.current.error).toBeNull();
        expect(result.current.snapshotSource).toBeNull();
        expect(asked).toEqual([SERVER_ID]);
    });

    describe('when the server no longer has it', () => {
        it('falls back to a saved row', async () => {
            await saved('gone-saved');
            const { result } = await mount('gone-saved');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.snapshotSource).toBe('saved');
            expect(result.current.article?.article_url).toBe('https://example.com/saved');
            expect(result.current.error).toBeNull();
        });

        it('falls back to a followed story retention row, labelled retained', async () => {
            await keepArticleForTrackedStory({
                articleId: 'gone-retained',
                suggestion: await seedSuggestion({ _id: 'gone-retained' }),
            });
            const { result } = await mount('gone-retained');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.snapshotSource).toBe('retained');
            expect(result.current.article?._id).toBe('gone-retained');
        });

        it('falls back to the read history', async () => {
            await recordPublicationVisit({
                articleId: 'gone-visit',
                articleUrl: 'https://zeit.de/visit',
                publicationName: 'Die Zeit',
                countryCode: 'DEU',
                titleEn: 'English headline',
                languageCode: 'de',
            });
            const { result } = await mount('gone-visit');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.snapshotSource).toBe('visit');
            expect(result.current.article?.article_url).toBe('https://zeit.de/visit');
        });

        it('prefers a saved row over a visit', async () => {
            await recordPublicationVisit({
                articleId: 'gone-both',
                articleUrl: 'https://zeit.de/visit',
                publicationName: 'Die Zeit',
                countryCode: 'DEU',
            });
            await saved('gone-both');
            const { result } = await mount('gone-both');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.snapshotSource).toBe('saved');
            expect(result.current.article?.article_url).toBe('https://example.com/saved');
        });

        it('sets the unavailable error when this device holds no snapshot', async () => {
            const { result } = await mount('gone-nothing');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.error).toBe(UNAVAILABLE);
            expect(result.current.article).toBeNull();
            expect(result.current.offlineUnavailable).toBe(false);
            expect(result.current.notFound).toBe(true);
        });

        it('does not report notFound while loading or for a network failure', async () => {
            server.use(
                graphql.query('GetArticleById', () => HttpResponse.json({ errors: [{ message: 'boom' }] })),
            );
            const { result } = await mount('net-fail');
            expect(result.current.notFound).toBe(false);
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            expect(result.current.error).not.toBeNull();
            expect(result.current.error).not.toBe(UNAVAILABLE);
            expect(result.current.notFound).toBe(false);
        });
    });
});

describe('offline', () => {
    beforeEach(() => useNetworkStore.setState({ isConnected: false }));

    it('renders a saved snapshot without asking the server', async () => {
        await saved('off-saved');
        const asked = recordArticleRequests();
        const { result } = await mount('off-saved');
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.snapshotSource).toBe('saved');
        expect(result.current.article?._id).toBe('off-saved');
        expect(asked).toEqual([]);
    });

    it('shows the offline empty state with no snapshot, and retries once on reconnect', async () => {
        const asked = recordArticleRequests();
        const { result } = await mount(SERVER_ID);
        await waitFor(() => expect(result.current.offlineUnavailable).toBe(true));
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeNull();
        expect(result.current.article).toBeNull();
        expect(asked).toEqual([]);

        await setConnected(true);
        await waitFor(() => expect(result.current.article?._id).toBe(SERVER_ID));
        expect(result.current.offlineUnavailable).toBe(false);
        expect(asked).toEqual([SERVER_ID]);
    });

    it('keeps a loaded article when connectivity drops and returns', async () => {
        useNetworkStore.setState({ isConnected: true });
        const asked = recordArticleRequests();
        const { result } = await mount(SERVER_ID);
        await waitFor(() => expect(result.current.article?._id).toBe(SERVER_ID));

        await setConnected(false);
        await setConnected(true);
        await act(async () => {
            await new Promise((res) => setTimeout(res, 100));
        });
        expect(result.current.article?._id).toBe(SERVER_ID);
        expect(asked).toEqual([SERVER_ID]);
    });
});

describe('actions', () => {
    it('handleToggleSave saves the article, then removes it', async () => {
        const { result } = await mount(SERVER_ID);
        await waitFor(() => expect(result.current.article?._id).toBe(SERVER_ID));
        expect(result.current.isSaved).toBe(false);

        await act(async () => {
            await result.current.handleToggleSave();
        });
        expect(await isSuggestionSaved(SERVER_ID)).toBe(true);
        await waitFor(() => expect(result.current.isSaved).toBe(true));

        await act(async () => {
            await result.current.handleToggleSave();
        });
        expect(await isSuggestionSaved(SERVER_ID)).toBe(false);
        await waitFor(() => expect(result.current.isSaved).toBe(false));
    });

    // Control for FD1: from the article screen the visit does carry the original title.
    it('handleArticleUrlPress records a visit carrying titleOriginal and opens the browser', async () => {
        const { result } = await mount(SERVER_ID);
        await waitFor(() => expect(result.current.article?._id).toBe(SERVER_ID));
        const article = result.current.article!;

        await act(async () => {
            await result.current.handleArticleUrlPress('https://example.com/story/1');
        });
        expect(WebBrowser.openBrowserAsync).toHaveBeenCalledTimes(1);
        await waitFor(async () => expect(await getAllVisitedArticles()).toHaveLength(1));
        const [visit] = await getAllVisitedArticles();
        expect(visit.articleId).toBe(SERVER_ID);
        expect(visit.articleUrl).toBe('https://example.com/story/1');
        expect(visit.titleOriginal).toBe(article.title);
        expect(visit.titleOriginal).toBeTruthy();
    });

    it('handleArticleUrlPress refuses an insecure URL: no visit, no browser', async () => {
        const { result } = await mount(SERVER_ID);
        await waitFor(() => expect(result.current.article?._id).toBe(SERVER_ID));
        await act(async () => {
            await result.current.handleArticleUrlPress('http://example.com/story/1');
        });
        expect(WebBrowser.openBrowserAsync).not.toHaveBeenCalled();
        expect(await getAllVisitedArticles()).toEqual([]);
    });
});
