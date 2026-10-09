// The card action hooks: the shared verdict plumbing (useFeedbackSheet), the origin-aware inline
// actions (useArticleActions) and the ••• menu's "Fewer from" / follow state (useArticleMenu).
// Real stores, in-memory DB, real services; the only fakes are native edges and the toast
// instance the undo toast is shown on.
// A native module (the sheet's gesture layer); the hook never renders the sheet here.
jest.mock('react-native-gesture-handler', () => ({
    Gesture: {},
    GestureDetector: ({ children }: { children: unknown }) => children,
    GestureHandlerRootView: ({ children }: { children: unknown }) => children,
}));

import { act, renderHook, waitFor } from '@testing-library/react-native';
import type React from 'react';
import { Share } from 'react-native';
import { feedbackSubjectFromSuggestion } from '@/components/custom/cards/feedback-subject';
import { useArticleActions } from '@/components/custom/cards/use-article-actions';
import { useArticleMenu } from '@/components/custom/cards/use-article-menu';
import { useFeedbackSheet, type VerdictStoreAdapter } from '@/components/custom/feed/use-feedback-sheet';
import { getArticleVerdict, hasLiked } from '@/lib/database/services/article-feedback-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { __clearPublisherSourceNames, rememberPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { isSuggestionSaved } from '@/lib/database/services/saved-article-suggestion-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { __resetSavedStateForTests } from '@/lib/saved-state';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { toastManager } from '@/lib/toast-manager';
import { initI18nEn, signInFixtureAccount } from '@/test/helpers';
import { seedSuggestion } from '../detail/seed';

const verdictOf = async (articleId: string) => (await getArticleVerdict(articleId)).verdict;

beforeAll(initI18nEn);
beforeEach(async () => {
    await signInFixtureAccount();
    useFeedOrderStore.setState({ verdicts: {} });
    __resetSavedStateForTests();
});

// The Feed's adapter (useFeedScreen's feedAdapter) with the list-item id replaced by the
// suggestion id: verdicts live in the persisted feed-order store.
const feedAdapter: VerdictStoreAdapter = {
    keyFor: (s) => s._id,
    getVerdict: (key) => useFeedOrderStore.getState().verdicts[key]?.verdict ?? null,
    setVerdict: (key, v) => {
        const store = useFeedOrderStore.getState();
        if (v == null) store.clearVerdict(key);
        else store.setVerdict(key, v);
    },
    getPath: (key) => useFeedOrderStore.getState().verdicts[key]?.path,
    setPath: (key, path) => useFeedOrderStore.getState().setPath(key, path),
    getCommitted: (key) => !!useFeedOrderStore.getState().verdicts[key]?.committed,
    setCommitted: (key, committed) => useFeedOrderStore.getState().setCommitted(key, committed),
};
const record = (id: string) => useFeedOrderStore.getState().verdicts[id];

describe('useFeedbackSheet: the verdict on a Feed card', () => {
    it('records a like, then a dislike flips it: one verdict row, latest wins', async () => {
        const s = await seedSuggestion({ _id: 'fs-flip' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));

        act(() => result.current.onVerdict(s, 'like'));
        expect(record('fs-flip')?.verdict).toBe('like');
        await waitFor(async () => expect(await verdictOf('fs-flip')).toBe('like'));

        act(() => result.current.onVerdict(s, 'dislike'));
        expect(record('fs-flip')).toMatchObject({ verdict: 'dislike', path: [] });
        await waitFor(async () => expect(await verdictOf('fs-flip')).toBe('dislike'));
        // A like row left behind would win the read (getArticleVerdict prefers like).
        expect(await hasLiked('fs-flip')).toBe(false);
    });

    it('a flip clears the old verdict’s committed flag', async () => {
        const s = await seedSuggestion({ _id: 'fs-flip-committed' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        act(() => result.current.onVerdict(s, 'like'));
        await waitFor(async () => expect(await verdictOf('fs-flip-committed')).toBe('like'));
        act(() => result.current.feedbackHandlers.onLeafPicked(s, 'like', ['more'], 1, true));
        expect(record('fs-flip-committed')?.committed).toBe(true);
        await waitFor(async () => expect((await getArticleVerdict('fs-flip-committed')).committed).toBe(true));

        act(() => result.current.onVerdict(s, 'dislike'));
        expect(record('fs-flip-committed')?.committed).toBeUndefined();
        await waitFor(async () => expect(await verdictOf('fs-flip-committed')).toBe('dislike'));
        expect((await getArticleVerdict('fs-flip-committed')).committed).toBe(false);
    });

    it('the same thumb again removes the verdict and its row', async () => {
        const s = await seedSuggestion({ _id: 'fs-unvote' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        act(() => result.current.onVerdict(s, 'dislike'));
        await waitFor(async () => expect(await verdictOf('fs-unvote')).toBe('dislike'));

        act(() => result.current.onVerdict(s, 'dislike'));
        expect(record('fs-unvote')).toBeUndefined();
        await waitFor(async () => expect(await verdictOf('fs-unvote')).toBeNull());
    });

    it('a verdict on a card with no key records nothing', async () => {
        const s = await seedSuggestion({ _id: 'fs-nokey' });
        const { result } = renderHook(() => useFeedbackSheet({ ...feedAdapter, keyFor: () => null }));
        act(() => result.current.onVerdict(s, 'like'));
        // Nothing to wait for: give a write the chance to land, then look.
        await act(async () => {});
        expect(await verdictOf('fs-nokey')).toBeNull();
    });

    it('a leaf that is not committed stores the path and does not commit', async () => {
        const s = await seedSuggestion({ _id: 'fs-leaf-open' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        act(() => result.current.onVerdict(s, 'dislike'));
        await waitFor(async () => expect(await verdictOf('fs-leaf-open')).toBe('dislike'));

        act(() => result.current.feedbackHandlers.onLeafPicked(s, 'dislike', ['less', 'topic'], 0, false));
        expect(record('fs-leaf-open')).toMatchObject({ verdict: 'dislike', path: ['less', 'topic'] });
        expect(record('fs-leaf-open')?.committed).toBeUndefined();
        await waitFor(async () => expect((await getArticleVerdict('fs-leaf-open')).path).toEqual(['less', 'topic']));
        expect((await getArticleVerdict('fs-leaf-open')).committed).toBe(false);
    });

    it('a committed leaf commits the verdict, in the store and on the row', async () => {
        const s = await seedSuggestion({ _id: 'fs-leaf-done' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        act(() => result.current.onVerdict(s, 'like'));
        await waitFor(async () => expect(await verdictOf('fs-leaf-done')).toBe('like'));

        act(() => result.current.feedbackHandlers.onLeafPicked(s, 'like', ['more', 'topic'], 1, true));
        expect(record('fs-leaf-done')).toMatchObject({ path: ['more', 'topic'], committed: true });
        await waitFor(async () => expect((await getArticleVerdict('fs-leaf-done')).committed).toBe(true));
    });

    it('browse related opens the suggestion through the host callback', async () => {
        const s = await seedSuggestion({ _id: 'fs-browse' });
        const onOpenSuggestion = jest.fn();
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter, { onOpenSuggestion }));
        act(() => result.current.feedbackHandlers.onBrowseRelated(s));
        expect(onOpenSuggestion).toHaveBeenCalledWith(s);
    });
});

describe('useArticleActions: the inline actions of a standalone card', () => {
    const mount = async (id: string, opts: { share?: Parameters<typeof useArticleActions>[0]['share'] } = {}) =>
        mountSeeded(await seedSuggestion({ _id: id }), opts);
    const mountSeeded = (
        suggestion: ForYouSuggestion,
        opts: { share?: Parameters<typeof useArticleActions>[0]['share'] } = {},
    ) => {
        const subject = feedbackSubjectFromSuggestion(suggestion, 'for_you');
        return renderHook(() => useArticleActions({ subject, suggestion, share: opts.share }));
    };

    it('like then dislike: the thumbs are exclusive and the row follows', async () => {
        const { result } = await mount('aa-excl');
        act(() => result.current.onLike());
        expect(result.current).toMatchObject({ likeState: 'provisional', dislikeState: 'none' });
        await waitFor(async () => expect(await verdictOf('aa-excl')).toBe('like'));

        act(() => result.current.onDislike());
        expect(result.current).toMatchObject({ likeState: 'none', dislikeState: 'provisional' });
        await waitFor(async () => expect(await verdictOf('aa-excl')).toBe('dislike'));
        expect(await hasLiked('aa-excl')).toBe(false);
    });

    it('the same thumb again removes the verdict row', async () => {
        const { result } = await mount('aa-toggle');
        act(() => result.current.onLike());
        await waitFor(async () => expect(await verdictOf('aa-toggle')).toBe('like'));
        act(() => result.current.onLike());
        expect(result.current.likeState).toBe('none');
        await waitFor(async () => expect(await verdictOf('aa-toggle')).toBeNull());
    });

    it('a committed leaf fills the thumb, and the state survives a remount', async () => {
        const suggestion = await seedSuggestion({ _id: 'aa-commit' });
        const first = mountSeeded(suggestion);
        act(() => first.result.current.onDislike());
        await waitFor(async () => expect(await verdictOf('aa-commit')).toBe('dislike'));
        act(() => first.result.current.onLeafPicked('dislike', ['less', 'x'], 0, true));
        expect(first.result.current.dislikeState).toBe('committed');
        await waitFor(async () => expect((await getArticleVerdict('aa-commit')).committed).toBe(true));
        first.unmount();

        const second = mountSeeded(suggestion);
        await waitFor(() => expect(second.result.current.dislikeState).toBe('committed'));
        expect(second.result.current.likeState).toBe('none');
    });

    it('a leaf that is not committed leaves the thumb as recorded', async () => {
        const { result } = await mount('aa-open');
        act(() => result.current.onLike());
        await waitFor(async () => expect(await verdictOf('aa-open')).toBe('like'));
        act(() => result.current.onLeafPicked('like', ['more'], 0, false));
        expect(result.current.likeState).toBe('provisional');
        await waitFor(async () => expect((await getArticleVerdict('aa-open')).path).toEqual(['more']));
        expect((await getArticleVerdict('aa-open')).committed).toBe(false);
    });

    it('save and unsave write the saved row and flip the state', async () => {
        const { result } = await mount('aa-save');
        await waitFor(() => expect(result.current.saved).toBe(false));

        act(() => result.current.onToggleSave());
        await waitFor(() => expect(result.current.saved).toBe(true));
        expect(await isSuggestionSaved('aa-save')).toBe(true);

        act(() => result.current.onToggleSave());
        await waitFor(() => expect(result.current.saved).toBe(false));
        expect(await isSuggestionSaved('aa-save')).toBe(false);
    });

    it('share exists only with a url, and shares the title and link', async () => {
        const noUrl = await mount('aa-share-none');
        expect(noUrl.result.current.onShare).toBeUndefined();

        const share = jest.spyOn(Share, 'share').mockResolvedValue({ action: 'sharedAction' });
        try {
            const { result } = await mount('aa-share', {
                share: { url: 'https://example.com/story', titleEnglish: 'English headline' },
            });
            expect(result.current.onShare).toBeDefined();
            await act(async () => result.current.onShare?.());
            expect(share).toHaveBeenCalledTimes(1);
            const { message } = share.mock.calls[0][0] as { message: string };
            expect(message).toContain('English headline');
            expect(message).toContain('https://example.com/story');
        } finally {
            share.mockRestore();
        }
    });
});

/** The sheet's current level key; the element is never mounted, only read. */
const levelKey = (element: React.ReactNode) => (element as React.ReactElement<{ levelKey: string }>).props.levelKey;

describe('useArticleMenu', () => {
    const show = jest.fn();
    beforeEach(() => {
        __clearPublisherSourceNames();
        show.mockReset();
        toastManager.setToastInstance({ show, close: jest.fn() } as never);
    });

    const mount = async (id: string, publicationName = 'The Hindu') => {
        const suggestion = await seedSuggestion({ _id: id, publication_name: publicationName });
        const subject = feedbackSubjectFromSuggestion(suggestion, 'for_you');
        const hook = renderHook(() => useArticleMenu({ subject }));
        const run = (actionName: string) =>
            act(async () => {
                hook.result.current.onAccessibilityAction({ nativeEvent: { actionName } } as never);
            });
        return { ...hook, run };
    };
    /** The Undo button's handler on the toast "Fewer from" showed. */
    const pressUndo = async () => {
        const toast = show.mock.calls[0][0];
        await act(async () => {
            toast.render({ id: 'toast-1' }).props.onUndo();
        });
    };

    it('Fewer from writes a preference for every name the publication is known by', async () => {
        rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'Hindu Business Line']);
        const { run } = await mount('menu-fewer');
        await run('fewer-from');
        // The toast is shown after the last name is written.
        await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
        expect(await getPreferenceKind('The Hindu')).toBe('deprioritize');
        expect(await getPreferenceKind('Hindu Business Line')).toBe('deprioritize');
    });

    it('Fewer from for a publication with one known name writes that one row', async () => {
        const { run } = await mount('menu-fewer-one', 'De Volkskrant');
        await run('fewer-from');
        await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
        expect(await getPreferenceKind('De Volkskrant')).toBe('deprioritize');
    });

    it('Undo reverts every row the press wrote', async () => {
        rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'Hindu Business Line']);
        const { run } = await mount('menu-undo');
        await run('fewer-from');
        await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
        expect(await getPreferenceKind('The Hindu')).toBe('deprioritize');
        expect(await getPreferenceKind('Hindu Business Line')).toBe('deprioritize');

        await pressUndo();
        await waitFor(async () => expect(await getPreferenceKind('The Hindu')).toBe('none'));
        expect(await getPreferenceKind('Hindu Business Line')).toBe('none');
    });

    it('Undo leaves alone a name a newer change owns (compare-and-set)', async () => {
        rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'Hindu Business Line']);
        const { run } = await mount('menu-cas');
        await run('fewer-from');
        await waitFor(() => expect(show).toHaveBeenCalledTimes(1));
        expect(await getPreferenceKind('The Hindu')).toBe('deprioritize');
        // A later "More from" on one of the two names.
        await setSourcePrefFromUi({ kind: 'publisher', names: ['Hindu Business Line'] }, 'prioritised');
        expect(await getPreferenceKind('Hindu Business Line')).toBe('boost');

        await pressUndo();
        await waitFor(async () => expect(await getPreferenceKind('The Hindu')).toBe('none'));
        expect(await getPreferenceKind('Hindu Business Line')).toBe('boost');
    });

    it('Follow opens the already-following level for a tracked story, once the menu is engaged', async () => {
        const suggestion = await seedSuggestion({ _id: 'menu-follow' });
        await trackStory({ articleId: 'menu-follow', title: 'English headline', originSurface: 'for_you' });
        const subject = feedbackSubjectFromSuggestion(suggestion, 'for_you');
        const { result } = renderHook(() => useArticleMenu({ subject }));
        // The follow state is read only after the menu is engaged (no DB read per mounted card).
        expect(result.current.tracked).toBe(false);
        act(() => result.current.open());
        await waitFor(() => expect(result.current.tracked).toBe(true));

        act(() => result.current.openFollow());
        expect(levelKey(result.current.element)).toMatch(/:follow-tracked$/);
    });

    it('Follow stays untracked for a story nobody follows', async () => {
        const { result } = await mount('menu-nofollow');
        act(() => result.current.open());
        await act(async () => {});
        expect(result.current.tracked).toBe(false);
    });
});
