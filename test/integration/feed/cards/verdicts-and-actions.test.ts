// The card action hooks: the shared verdict plumbing (useFeedbackSheet), the origin-aware inline
// actions (useArticleActions) and the ••• menu's "Fewer from" / follow state (useArticleMenu).
// Real stores, in-memory DB, real services; the only fakes are native edges and the toast
// queue the undo toast is shown on (the real show/close ToastInitializer installs).
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
import { getArticleVerdict, recordVerdictFeedback } from '@/lib/database/services/article-feedback-service';
import { wireSwipeCallbacks } from '@/lib/services/swipe-feedback';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { useOpenedStoriesStore } from '@/lib/stores/opened-stories-store';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { setSourcePrefFromUi } from '@/lib/database/services/publication-pref-ui-actions';
import { __clearPublisherSourceNames, rememberPublisherSourceNames } from '@/lib/database/services/publisher-source-names';
import { isSuggestionSaved } from '@/lib/database/services/saved-article-suggestion-service';
import { trackStory } from '@/lib/database/services/tracked-story-service';
import { __resetSavedStateForTests } from '@/lib/saved-state';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { useFeedOrderStore } from '@/lib/stores/feed-order-store';
import { toastManager } from '@/lib/toast-manager';
import { closeAll, useToastQueue } from '@/lib/toast/toast-queue';
import { useToast } from '@/components/ui/toast';
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
    it('records a dislike: one verdict row, kept under the key', async () => {
        const s = await seedSuggestion({ _id: 'fs-dislike' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));

        act(() => result.current.onVerdict(s, 'dislike'));
        expect(record('fs-dislike')).toMatchObject({ verdict: 'dislike', path: [] });
        await waitFor(async () => expect(await verdictOf('fs-dislike')).toBe('dislike'));

        // The verdict is not a toggle: a second call changes nothing.
        act(() => result.current.onVerdict(s, 'dislike'));
        expect(record('fs-dislike')).toMatchObject({ verdict: 'dislike', path: [] });
        expect(await verdictOf('fs-dislike')).toBe('dislike');
    });

    it('the sheet recording a verdict fills the card and marks it read', async () => {
        const s = await seedSuggestion({ _id: 'fs-recorded' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        act(() => result.current.feedbackHandlers.onVerdictRecorded(s));
        expect(record('fs-recorded')).toMatchObject({ verdict: 'dislike', committed: true });
        expect(useOpenedStoriesStore.getState().articleIds.has(s.articleId)).toBe(true);
    });

    it('a verdict on a card with no key records nothing', async () => {
        const s = await seedSuggestion({ _id: 'fs-nokey' });
        const { result } = renderHook(() => useFeedbackSheet({ ...feedAdapter, keyFor: () => null }));
        act(() => result.current.onVerdict(s, 'dislike'));
        // Nothing to wait for: give a write the chance to land, then look.
        await act(async () => {});
        expect(await verdictOf('fs-nokey')).toBeNull();
    });

    it('Tell Mera hands every answer to the feedback chat', async () => {
        const s = await seedSuggestion({ _id: 'fs-tell' });
        const { result } = renderHook(() => useFeedbackSheet(feedAdapter));
        wireSwipeCallbacks();
        const answers = {
            answers: [{ cause: 'source' as const, question: 'Problem with NOS', answer: 'Paywalled' }],
            screen: 'About NOS',
        };
        act(() => result.current.feedbackHandlers.onInvokeMera(s, ['publication_issue', 'paywall'], answers));
        await waitFor(() =>
            expect(useFloatingChatStore.getState().context).toMatchObject({ verdict: 'dislike', feedbackAnswers: answers }),
        );
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

    it('answered comes back from a stored dislike, never from an old like', async () => {
        const disliked = await seedSuggestion({ _id: 'aa-disliked' });
        await recordVerdictFeedback({ articleId: disliked.articleId, sentiment: 'dislike', title: 't' });
        const a = mountSeeded(disliked);
        await waitFor(() => expect(a.result.current.answered).toBe(true));

        const liked = await seedSuggestion({ _id: 'aa-liked' });
        await recordVerdictFeedback({ articleId: liked.articleId, sentiment: 'like', title: 't' });
        const b = mountSeeded(liked);
        await act(async () => {});
        expect(b.result.current.answered).toBe(false);
    });

    it('the sheet recording a verdict marks the row answered', async () => {
        const { result } = await mount('aa-recorded');
        expect(result.current.answered).toBe(false);
        act(() => result.current.onVerdictRecorded());
        expect(result.current.answered).toBe(true);
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
    const toastCount = () => useToastQueue.getState().entries.length;
    beforeEach(() => {
        __clearPublisherSourceNames();
        closeAll();
        // What ToastInitializer installs.
        const { result } = renderHook(() => useToast());
        toastManager.setToastInstance(result.current);
    });
    // The queue arms a real 6s timer for the front card; drop it so none outlives the test.
    afterEach(closeAll);

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
        const toast = useToastQueue.getState().entries[0];
        await act(async () => {
            (toast.render({ id: toast.id }) as React.ReactElement<{ onUndo: () => void }>).props.onUndo();
        });
    };

    it('Fewer from writes a preference for every name the publication is known by', async () => {
        rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'Hindu Business Line']);
        const { run } = await mount('menu-fewer');
        await run('fewer-from');
        // The toast is shown after the last name is written.
        await waitFor(() => expect(toastCount()).toBe(1));
        expect(await getPreferenceKind('The Hindu')).toBe('deprioritize');
        expect(await getPreferenceKind('Hindu Business Line')).toBe('deprioritize');
    });

    it('Fewer from for a publication with one known name writes that one row', async () => {
        const { run } = await mount('menu-fewer-one', 'De Volkskrant');
        await run('fewer-from');
        await waitFor(() => expect(toastCount()).toBe(1));
        expect(await getPreferenceKind('De Volkskrant')).toBe('deprioritize');
    });

    it('Undo reverts every row the press wrote', async () => {
        rememberPublisherSourceNames('pub-hindu', ['The Hindu', 'Hindu Business Line']);
        const { run } = await mount('menu-undo');
        await run('fewer-from');
        await waitFor(() => expect(toastCount()).toBe(1));
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
        await waitFor(() => expect(toastCount()).toBe(1));
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
