// useArticleSuggestionScreen: where the suggestion comes from (feed store, feed table, saved
// table), the confirmed-gone purge, and the visit a "Read" tap records. Real stores, in-memory
// DB, MSW.
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { useArticleSuggestionScreen } from '@/components/custom/news-detail/useArticleSuggestionScreen';
import { visitedToNewsArticle } from '@/components/custom/publication-page/visited-article';
import * as suggestions from '@/lib/database/services/article-suggestion-service';
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
        await suggestions.deleteSuggestionByServerId('in-store');
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
        await suggestions.deleteSuggestionByServerId('pruned');
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
        const deleteRow = jest.spyOn(suggestions, 'deleteSuggestionByServerId');
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

    it('does not purge when the read throws: a transient error proves nothing about the row', async () => {
        await seedSuggestion({ _id: 'kept' });
        const deleteRow = jest.spyOn(suggestions, 'deleteSuggestionByServerId');
        jest.spyOn(suggestions, 'getSuggestionByServerId').mockRejectedValueOnce(new Error('db busy'));
        const { result } = mount('kept');
        await waitFor(() => expect(result.current.isLoading).toBe(false));
        expect(result.current.error).toBe('Failed to load article');
        expect(deleteRow).not.toHaveBeenCalled();
        expect((await suggestions.loadSuggestions()).map((s) => s._id)).toContain('kept');
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

    test.failing('a visit opened from a suggestion keeps its original title', async () => {
        const { visit, shown } = await openFromSuggestion();
        expect(visit.titleOriginal).toBe('Nederlandse kop');
        expect(shown.title).toBe('Nederlandse kop');
    });

    test('today: a visit opened from a suggestion stores no original title, so History shows the English title as the original', async () => {
        const { visit, shown } = await openFromSuggestion();
        expect(visit.titleEn).toBe('English title');
        expect(visit.titleOriginal).toBeNull();
        expect(shown.title).toBe('English title');
    });
});
