// useArticleSuggestionScreen: where the suggestion comes from (feed store, feed table, saved
// table), the confirmed-gone purge, and the visit a "Read" tap records. Real stores, in-memory
// DB, MSW.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useArticleSuggestionScreen } from '@/components/custom/news-detail/useArticleSuggestionScreen';
import { visitedToNewsArticle } from '@/components/custom/publication-page/visited-article';
import database from '@/lib/database';
import * as suggestions from '@/lib/database/services/article-suggestion-reads';
import * as lifecycle from '@/lib/database/services/article-suggestion-lifecycle';
import { getAllVisitedArticles } from '@/lib/database/services/publication-visit-service';
import { isSuggestionSaved, saveSuggestion } from '@/lib/database/services/saved-article-suggestion-service';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { initI18nEn, signInFixtureAccount } from '@/test/helpers';
import { quietLogger, resetForYouStore } from '../../core/sync/seed';
import { putInStore, seedSuggestion } from './seed';

const DUTCH = {
    title: 'Nederlandse kop',
    title_en: 'English title',
    language_code: 'nl',
    country_code: 'NLD',
    publication_name: 'De Volkskrant',
};

const mount = (articleSuggestionId: string) => renderHook(() => useArticleSuggestionScreen({ articleSuggestionId }));

beforeAll(initI18nEn);
beforeEach(async () => {
    await signInFixtureAccount();
    resetForYouStore();
});

describe('where the suggestion comes from', () => {
    it('renders from the feed store without touching the DB', async () => {
        const s = await seedSuggestion({ _id: 'in-store' });
        // The DB can no longer supply it, so only the store can have.
        await lifecycle.deleteSuggestionByServerId('in-store');
        putInStore(s);
        const { result } = mount('in-store');
        expect(result.current.isLoading).toBe(false);
        expect(result.current.suggestion?._id).toBe('in-store');
        expect(result.current.error).toBeNull();
    });

    it('loads from article_suggestions on a deep link before the store hydrates', async () => {
        await seedSuggestion({ _id: 'deep-link' });
        const { result } = mount('deep-link');
        expect(result.current.isLoading).toBe(true);
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.suggestion?._id).toBe('deep-link');
        expect(result.current.suggestion?.title_en).toBe('English headline');
    });

    it('falls back to the saved table when the feed row is pruned', async () => {
        const s = await seedSuggestion({ _id: 'pruned', title_en: 'Saved copy' });
        await saveSuggestion(s);
        await lifecycle.deleteSuggestionByServerId('pruned');
        const { result } = mount('pruned');
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.suggestion?._id).toBe('pruned');
        expect(result.current.suggestion?.title_en).toBe('Saved copy');
        expect(result.current.error).toBeNull();
    });
});

describe('a story neither table holds', () => {
    let log: ReturnType<typeof quietLogger>;
    beforeEach(() => {
        log = quietLogger();
    });
    afterEach(() => {
        log.restore();
        jest.restoreAllMocks();
    });

    it('sets the error and purges the feed row from the DB and the store once', async () => {
        const deleteRow = jest.spyOn(lifecycle, 'deleteSuggestionByServerId');
        const removeFromStore = jest.spyOn(useForYouStore.getState(), 'removeSuggestion');
        const { result } = mount('gone');
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('This story is no longer available');
        expect(result.current.suggestion).toBeNull();
        expect(deleteRow).toHaveBeenCalledTimes(1);
        expect(deleteRow).toHaveBeenCalledWith('gone');
        expect(removeFromStore).toHaveBeenCalledTimes(1);
        expect(removeFromStore).toHaveBeenCalledWith('gone');

        // A store change re-renders the hook; it must not purge again.
        act(() => useForYouStore.setState({ articleCount: 7 }));
        expect(deleteRow).toHaveBeenCalledTimes(1);
    });

    // FD7. getSuggestionByServerId swallows every error and returns null, and the saved-table
    // lookup does the same, so the hook cannot tell "the read failed" from "the row is gone" and
    // purges the card on one transient DB error. The `.catch` that is meant to protect the row
    // never runs. components/custom/news-detail/useArticleSuggestionScreen.tsx, the load effect.
    async function openWhileTheReadFails() {
        await seedSuggestion({ _id: 'kept' });
        const deleteRow = jest.spyOn(lifecycle, 'deleteSuggestionByServerId');
        // One level below the services: the collection method their reads go through.
        const collection = database.get('article_suggestions');
        const fail = jest.spyOn(collection, 'find').mockRejectedValueOnce(new Error('db busy'));
        try {
            const { result } = mount('kept');
            await waitFor(() => expect(result.current.isLoading).toBe(false));
            return { result, deleteRow, rows: await suggestions.loadSuggestions() };
        } finally {
            fail.mockRestore();
        }
    }

    test('a transient read error on an existing row never deletes the card', async () => {
        const { result, deleteRow, rows } = await openWhileTheReadFails();
        expect(deleteRow).not.toHaveBeenCalled();
        expect(rows.map((s) => s._id)).toContain('kept');
        expect(result.current.error).toBe('Failed to load article');
    });
});

describe('actions', () => {
    it('handleToggleSave saves the suggestion, then removes it', async () => {
        putInStore(await seedSuggestion({ _id: 'to-save' }));
        const { result } = mount('to-save');
        await waitFor(() => expect(result.current.isSaved).toBe(false));

        await act(async () => {
            await result.current.handleToggleSave();
        });
        expect(await isSuggestionSaved('to-save')).toBe(true);
        await waitFor(() => expect(result.current.isSaved).toBe(true));

        await act(async () => {
            await result.current.handleToggleSave();
        });
        expect(await isSuggestionSaved('to-save')).toBe(false);
    });
});

// FD1. The suggestion route's recordPublicationVisit call omits titleOriginal (the article route
// passes it), so a visit opened from here keeps no original title and History falls back to the
// English one. components/custom/news-detail/useArticleSuggestionScreen.tsx, handleArticleUrlPress.
describe('a visit opened from a suggestion', () => {
    async function openFromSuggestion() {
        putInStore(await seedSuggestion({ _id: 'dutch', ...DUTCH }));
        const { result } = mount('dutch');
        await waitFor(() => expect(result.current.suggestion?._id).toBe('dutch'));
        await act(async () => {
            await result.current.handleArticleUrlPress('https://example.com/a');
        });
        await waitFor(async () => expect(await getAllVisitedArticles()).toHaveLength(1));
        const [visit] = await getAllVisitedArticles();
        return { visit, shown: visitedToNewsArticle(visit) };
    }

    test('a visit opened from a suggestion keeps its original title', async () => {
        const { visit, shown } = await openFromSuggestion();
        expect(visit.titleOriginal).toBe('Nederlandse kop');
        expect(shown.title).toBe('Nederlandse kop');
    });
});
