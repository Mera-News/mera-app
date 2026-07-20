// triage-store — deck eligibility, per-verdict resolve/advance + side effects,
// session-only skip, opened-exclusion on re-init, behind-current chunk folding,
// and listener teardown. DB-service / pipeline / router seams are mocked (they
// touch the native WatermelonDB singleton or expo internals at import) — same
// pattern as for-you-store.test.ts / SwipeDeckRow.test.tsx.

const mockLoadSuggestions = jest.fn((): Promise<any[]> => Promise.resolve([]));
const mockGetSuggestionByServerId = jest.fn((_id: string): Promise<any> => Promise.resolve(null));
jest.mock('@/lib/database/services/article-suggestion-service', () => ({
    loadSuggestions: (...a: any[]) => mockLoadSuggestions(...(a as [])),
    getSuggestionByServerId: (id: string) => mockGetSuggestionByServerId(id),
}));

const mockGetOpenedSeenSet = jest.fn((): Promise<Set<string>> => Promise.resolve(new Set()));
const mockRecordOpen = jest.fn((..._a: any[]) => Promise.resolve());
const mockRecordImpression = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/story-impression-service', () => ({
    getOpenedSeenSet: () => mockGetOpenedSeenSet(),
    recordOpen: (...a: any[]) => mockRecordOpen(...a),
    recordImpression: (...a: any[]) => mockRecordImpression(...a),
}));

const mockRecordArticleFeedback = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/article-feedback-service', () => ({
    recordArticleFeedback: (...a: any[]) => mockRecordArticleFeedback(...a),
}));

const mockSaveSuggestion = jest.fn((..._a: any[]) => Promise.resolve());
jest.mock('@/lib/database/services/saved-article-suggestion-service', () => ({
    saveSuggestion: (...a: any[]) => mockSaveSuggestion(...a),
}));

const mockApplyPersonaAction = jest.fn((..._a: any[]) => Promise.resolve({ applied: true, summary: '' }));
jest.mock('@/lib/database/services/persona-action-executor', () => ({
    applyPersonaAction: (...a: any[]) => mockApplyPersonaAction(...a),
}));

const mockRegister = jest.fn();
const mockUnsub = jest.fn();
const mockReleaseHolder: { cb: ((ids: string[]) => void) | null } = { cb: null };
jest.mock('@/lib/services/scoring-pipeline', () => ({
    registerChunkReleaseListener: (cb: any) => {
        mockReleaseHolder.cb = cb;
        mockRegister(cb);
        return mockUnsub;
    },
}));

const mockRouterPush = jest.fn();
jest.mock('expo-router', () => ({
    router: { push: (...a: any[]) => mockRouterPush(...a) },
}));

jest.mock('@/lib/logger', () => ({
    __esModule: true,
    default: {
        captureException: jest.fn(),
        warn: jest.fn(),
        error: jest.fn(),
        debug: jest.fn(),
        info: jest.fn(),
    },
}));

// eslint-disable-next-line import/first
import { useTriageStore } from '../triage-store';
// eslint-disable-next-line import/first
import type { ForYouSuggestion, MatchedTopicRef } from '../for-you-store';
// eslint-disable-next-line import/first
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';

function makeSuggestion(overrides: Partial<ForYouSuggestion> = {}): ForYouSuggestion {
    return {
        _id: 's1',
        articleId: 'a1',
        clusters: [],
        relevance: 0.6, // MEDIUM (scored)
        reason: '',
        status: ArticleSuggestionStatus.Complete,
        country_code: 'US',
        language_code: 'en',
        publication_name: 'Test Pub',
        title_en: 'Title 1',
        title_original: 'Title 1',
        description_en: '',
        article_url: 'https://example.com/1',
        image_url: null,
        userTopicIds: [],
        createdAt: new Date().toISOString(),
        firstPubDate: new Date().toISOString(),
        rawScore: 0.6,
        eventType: null,
        headlineScope: null,
        matchedTopics: [],
        ...overrides,
    };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

beforeEach(() => {
    // Clear the module-scoped listener so each initDeck re-registers + re-captures.
    useTriageStore.getState().teardown();
    useTriageStore.setState({
        deck: [],
        suggestionsById: new Map(),
        currentIndex: 0,
        handledIds: new Set<string>(),
        initialized: false,
        status: 'uninitialized',
    });
    jest.clearAllMocks();
    mockReleaseHolder.cb = null;
    mockLoadSuggestions.mockResolvedValue([]);
    mockGetOpenedSeenSet.mockResolvedValue(new Set());
    mockGetSuggestionByServerId.mockResolvedValue(null);
});

describe('triage-store eligibility', () => {
    it('excludes UNSCORED rows and opened rows from the deck', async () => {
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'scored', articleId: 'a-scored', relevance: 0.8 }),
            makeSuggestion({ _id: 'unscored', articleId: 'a-unscored', relevance: -1 }),
            makeSuggestion({ _id: 'opened', articleId: 'a-opened', relevance: 0.8 }),
        ]);
        mockGetOpenedSeenSet.mockResolvedValue(new Set(['a-opened']));

        await useTriageStore.getState().initDeck();

        const ids = useTriageStore.getState().deck.map((c) => c.id);
        expect(ids).toEqual(['scored']);
        expect(useTriageStore.getState().status).toBe('active');
    });

    it('goes to the empty state when nothing is eligible', async () => {
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'u', relevance: -1 }),
        ]);
        await useTriageStore.getState().initDeck();
        expect(useTriageStore.getState().status).toBe('empty');
        expect(useTriageStore.getState().deck).toHaveLength(0);
    });
});

describe('triage-store resolve → advance + side effects', () => {
    async function initTwo() {
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 }),
            makeSuggestion({ _id: 'B', articleId: 'aB', relevance: 0.6 }),
        ]);
        await useTriageStore.getState().initDeck();
    }

    it('good: records like + nudges matched topics + recordOpen, then advances', async () => {
        const topics: MatchedTopicRef[] = [
            { topicId: 't1', text: 'one' },
            { topicId: null, text: 'synthetic' },
            { topicId: 't2', text: 'two' },
        ];
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8, matchedTopics: topics }),
            makeSuggestion({ _id: 'B', articleId: 'aB', relevance: 0.6 }),
        ]);
        await useTriageStore.getState().initDeck();

        useTriageStore.getState().resolve('A', 'good');

        expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ articleId: 'aA', sentiment: 'like', origin: 'suggestion', surface: 'triage' }),
        );
        // Only the two non-null topicIds nudge (null is skipped, feedback still recorded).
        expect(mockApplyPersonaAction).toHaveBeenCalledTimes(2);
        expect(mockApplyPersonaAction).toHaveBeenCalledWith(
            expect.objectContaining({ action_type: 'set_topic_weight', topicId: 't1', delta: 0.04 }),
            'feedback',
        );
        expect(mockRecordOpen).toHaveBeenCalledWith(expect.objectContaining({ articleId: 'aA', surface: 'triage' }));

        const st = useTriageStore.getState();
        expect(st.currentIndex).toBe(1);
        expect(st.handledIds.has('A')).toBe(true);
        expect(st.status).toBe('active');
    });

    it('bad: records dislike + negative nudge + recordOpen', async () => {
        await initTwo();
        useTriageStore.setState((s) => {
            const next = new Map(s.suggestionsById);
            next.set('A', makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8, matchedTopics: [{ topicId: 't1', text: 'x' }] }));
            return { suggestionsById: next };
        });

        useTriageStore.getState().resolve('A', 'bad');

        expect(mockRecordArticleFeedback).toHaveBeenCalledWith(
            expect.objectContaining({ sentiment: 'dislike', origin: 'suggestion', surface: 'triage' }),
        );
        expect(mockApplyPersonaAction).toHaveBeenCalledWith(
            expect.objectContaining({ topicId: 't1', delta: -0.06 }),
            'feedback',
        );
    });

    it('bad with skipPersonaNudge: records dislike but no nudge', async () => {
        await initTwo();
        useTriageStore.setState((s) => {
            const next = new Map(s.suggestionsById);
            next.set('A', makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8, matchedTopics: [{ topicId: 't1', text: 'x' }] }));
            return { suggestionsById: next };
        });

        useTriageStore.getState().resolve('A', 'bad', { skipPersonaNudge: true });

        expect(mockRecordArticleFeedback).toHaveBeenCalledWith(expect.objectContaining({ sentiment: 'dislike' }));
        expect(mockApplyPersonaAction).not.toHaveBeenCalled();
    });

    it('read: recordOpen + router.push the suggestion detail, then advances', async () => {
        await initTwo();
        useTriageStore.getState().resolve('A', 'read');
        expect(mockRecordOpen).toHaveBeenCalledWith(expect.objectContaining({ articleId: 'aA', surface: 'triage' }));
        expect(mockRouterPush).toHaveBeenCalledWith(
            expect.objectContaining({ pathname: '/logged-in/suggestion-detail', params: { articleSuggestionId: 'A' } }),
        );
        expect(useTriageStore.getState().currentIndex).toBe(1);
    });

    it('save: saveSuggestion + recordOpen', async () => {
        await initTwo();
        useTriageStore.getState().resolve('A', 'save');
        expect(mockSaveSuggestion).toHaveBeenCalledWith(expect.objectContaining({ _id: 'A' }));
        expect(mockRecordOpen).toHaveBeenCalled();
    });

    it('empties the deck once the last card is resolved', async () => {
        mockLoadSuggestions.mockResolvedValue([makeSuggestion({ _id: 'only', articleId: 'aOnly', relevance: 0.8 })]);
        await useTriageStore.getState().initDeck();
        useTriageStore.getState().resolve('only', 'good');
        expect(useTriageStore.getState().status).toBe('empty');
    });
});

describe('triage-store skip (session-only)', () => {
    it('advances without recordOpen and is not added to handledIds', async () => {
        mockLoadSuggestions.mockResolvedValue([makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 })]);
        await useTriageStore.getState().initDeck();

        useTriageStore.getState().resolve('A', 'skip');

        expect(mockRecordOpen).not.toHaveBeenCalled();
        expect(mockRecordArticleFeedback).not.toHaveBeenCalled();
        expect(useTriageStore.getState().handledIds.has('A')).toBe(false);
        expect(useTriageStore.getState().status).toBe('empty');
    });

    it('reappears on the next initDeck (skip left no opened row)', async () => {
        mockLoadSuggestions.mockResolvedValue([makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 })]);
        await useTriageStore.getState().initDeck();
        useTriageStore.getState().resolve('A', 'skip');

        // Re-init: skip recorded no open, so the seen set is still empty.
        await useTriageStore.getState().initDeck();
        expect(useTriageStore.getState().deck.map((c) => c.id)).toEqual(['A']);
    });
});

describe('triage-store re-init excludes handled (opened) cards', () => {
    it('drops a card once it is in the opened seen set', async () => {
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 }),
            makeSuggestion({ _id: 'B', articleId: 'aB', relevance: 0.6 }),
        ]);
        await useTriageStore.getState().initDeck();
        useTriageStore.getState().resolve('A', 'good');

        // Simulate the recordOpen having landed: A is now opened.
        mockGetOpenedSeenSet.mockResolvedValue(new Set(['aA']));
        await useTriageStore.getState().initDeck();

        expect(useTriageStore.getState().deck.map((c) => c.id)).toEqual(['B']);
    });
});

describe('triage-store chunk release', () => {
    it('folds a higher-bucket newcomer BEHIND the current card', async () => {
        mockLoadSuggestions.mockResolvedValue([
            makeSuggestion({ _id: 'cur', articleId: 'aCur', relevance: 0.6 }), // MEDIUM
        ]);
        await useTriageStore.getState().initDeck();
        expect(mockReleaseHolder.cb).toBeTruthy();

        // A fresh EMERGENCY card is released.
        mockGetSuggestionByServerId.mockResolvedValue(
            makeSuggestion({ _id: 'emg', articleId: 'aEmg', relevance: 1.1, rawScore: 1.1 }),
        );
        mockReleaseHolder.cb!(['emg']);
        await flush();

        const deck = useTriageStore.getState().deck;
        // The higher-bucket newcomer must NOT jump above the frozen current card.
        expect(deck.map((c) => c.id)).toEqual(['cur', 'emg']);
        expect(deck[0].state).toBe('current');
        expect(deck[1].state).toBe('unread');
        expect(useTriageStore.getState().currentIndex).toBe(0);
    });

    it('revives from the empty state when a chunk arrives after the deck drained', async () => {
        mockLoadSuggestions.mockResolvedValue([makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 })]);
        await useTriageStore.getState().initDeck();
        useTriageStore.getState().resolve('A', 'good');
        expect(useTriageStore.getState().status).toBe('empty');

        mockGetSuggestionByServerId.mockResolvedValue(
            makeSuggestion({ _id: 'fresh', articleId: 'aFresh', relevance: 0.8 }),
        );
        mockReleaseHolder.cb!(['fresh']);
        await flush();

        const st = useTriageStore.getState();
        expect(st.status).toBe('active');
        expect(st.deck[st.currentIndex].id).toBe('fresh');
        expect(st.deck[st.currentIndex].state).toBe('current');
    });
});

describe('triage-store teardown', () => {
    it('unregisters the chunk-release listener', async () => {
        mockLoadSuggestions.mockResolvedValue([makeSuggestion({ _id: 'A', articleId: 'aA', relevance: 0.8 })]);
        await useTriageStore.getState().initDeck();
        expect(mockRegister).toHaveBeenCalledTimes(1);
        useTriageStore.getState().teardown();
        expect(mockUnsub).toHaveBeenCalledTimes(1);
    });
});
