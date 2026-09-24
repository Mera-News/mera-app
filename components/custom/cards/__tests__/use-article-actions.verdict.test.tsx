/* eslint-disable @typescript-eslint/no-require-imports */
// useArticleActions' verdict: like and "Not for me" are mutually exclusive,
// recording one removes the other, and the dislike has a state of its own that
// survives a remount (batch 12 fix 3).
import { act, renderHook, waitFor } from '@testing-library/react-native';

const mockRecordVerdict = jest.fn((..._a: any[]) => Promise.resolve());
const mockRecordArticle = jest.fn((..._a: any[]) => Promise.resolve());
const mockRemove = jest.fn((..._a: any[]) => Promise.resolve());
let mockStored: { verdict: 'like' | 'dislike' | null; path: string[]; committed?: boolean } = {
    verdict: null,
    path: [],
};
jest.mock('@/lib/database/services/article-feedback-service', () => ({
    recordVerdictFeedback: (...a: any[]) => mockRecordVerdict(...a),
    recordArticleFeedback: (...a: any[]) => mockRecordArticle(...a),
    removeArticleFeedback: (...a: any[]) => mockRemove(...a),
    getArticleVerdict: jest.fn(async () => mockStored),
    updateFeedbackContextPath: jest.fn(async () => {}),
    markFeedbackProcessedFor: jest.fn(async () => {}),
}));
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    saveSuggestion: jest.fn(async () => {}),
    saveStandaloneArticle: jest.fn(async () => {}),
    deleteSavedSuggestion: jest.fn(async () => true),
    isSuggestionSaved: jest.fn(async () => false),
}));
jest.mock('@/lib/haptics', () => ({ hapticLight: jest.fn(), hapticMedium: jest.fn(), hapticSuccess: jest.fn() }));
jest.mock('@/lib/hooks/useShareArticle', () => ({ useShareArticle: () => jest.fn() }));
jest.mock('@/lib/stores/floating-chat-store', () => ({ useFloatingChatStore: { getState: () => ({ expand: jest.fn() }) } }));
jest.mock('@/lib/saved-state', () => ({ useSavedOverride: () => undefined }));

import { useArticleActions } from '../use-article-actions';

const subject = { origin: 'article' as const, surface: 'explore' as const, articleId: 'art-1', title: 'T' };

beforeEach(() => {
    jest.clearAllMocks();
    mockStored = { verdict: null, path: [] };
});

describe('useArticleActions verdict', () => {
    it('records through the latest-wins writer, so a like removes a stored dislike', async () => {
        const { result } = renderHook(() => useArticleActions({ subject }));
        act(() => result.current.onLike());
        expect(mockRecordVerdict).toHaveBeenCalledWith(expect.objectContaining({ articleId: 'art-1', sentiment: 'like' }));
        expect(mockRecordArticle).not.toHaveBeenCalled();
    });

    it('a dislike after a like clears the like state and sets the dislike state', async () => {
        const { result } = renderHook(() => useArticleActions({ subject }));
        act(() => result.current.onLike());
        expect(result.current.likeState).toBe('provisional');
        act(() => result.current.onDislike());
        expect(result.current.likeState).toBe('none');
        expect(result.current.dislikeState).toBe('provisional');
        expect(mockRecordVerdict).toHaveBeenLastCalledWith(expect.objectContaining({ sentiment: 'dislike' }));
    });

    it('a second "Not for me" removes the dislike', async () => {
        const { result } = renderHook(() => useArticleActions({ subject }));
        act(() => result.current.onDislike());
        act(() => result.current.onDislike());
        expect(result.current.dislikeState).toBe('none');
        expect(mockRemove).toHaveBeenCalledWith('art-1', 'dislike');
    });

    it('restores a stored dislike on mount', async () => {
        mockStored = { verdict: 'dislike', path: [], committed: true };
        const { result } = renderHook(() => useArticleActions({ subject }));
        await waitFor(() => expect(result.current.dislikeState).toBe('committed'));
        expect(result.current.likeState).toBe('none');
    });

    it('a committed dislike leaf fills the dislike, not the like', async () => {
        const { result } = renderHook(() => useArticleActions({ subject }));
        act(() => result.current.onDislike());
        act(() => result.current.onLeafPicked('dislike', ['a'], 1, true));
        expect(result.current.dislikeState).toBe('committed');
        expect(result.current.likeState).toBe('none');
    });
});
