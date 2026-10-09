// useTrackedSubject: the track button's state. It holds real logic beyond subscribing: the live
// subscription follows the story's identity keys and its `active` gate, and startTracking opens the
// floating chat on the article-feedback context (with the origin snapshot the proposeTrack tool
// follows against) only when the story is NOT already followed. Real hook over the real tracked-story
// service on the in-memory DB, the real floating-chat store and the real English dictionary.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));

import { act, renderHook } from '@testing-library/react-native';

import { untrackStory } from '@/lib/database/services/tracked-story-service';
import { useFloatingChatStore } from '@/lib/stores/floating-chat-store';
import { trackStoryWithProposal } from '@/lib/tracking/track-actions';
import { useTrackedSubject } from '@/lib/tracking/use-tracked-subject';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { initI18nEn } from '@/test/helpers';
import { freshId, restoreFaults, waitFor } from './support';

beforeEach(async () => {
  await initI18nEn();
  useFloatingChatStore.getState().reset();
});
afterEach(restoreFaults);

const subject = (articleId: string, over: Partial<FeedbackSubject> = {}): FeedbackSubject => ({
  origin: 'suggestion',
  surface: 'for_you',
  articleId,
  suggestionId: `sugg-${articleId}`,
  title: `Seed ${articleId}`,
  pubDate: '2026-10-09T06:00:00.000Z',
  publicationName: 'Seed Pub',
  stableClusterId: 'clu-1',
  ...over,
});

const follow = (s: FeedbackSubject) => trackStoryWithProposal(s, { label: 'Label', searchText: `story ${s.articleId}` });

describe('useTrackedSubject', () => {
  it('starts untracked, and flips live when a story is followed later in the floating chat, then back when it is removed', async () => {
    const s = subject(freshId());
    const { result } = renderHook(() => useTrackedSubject(s));
    await waitFor(() => result.current.tracked === false);
    expect(result.current).toMatchObject({ tracked: false, trackedStoryId: null });

    await act(async () => {
      await follow(s);
    });
    await waitFor(() => result.current.tracked);
    expect(result.current.tracked).toBe(true);
    expect(result.current.trackedStoryId).toEqual(expect.any(String));

    const id = result.current.trackedStoryId!;
    await act(async () => {
      await untrackStory(id);
    });
    await waitFor(() => !result.current.tracked);
    expect(result.current).toMatchObject({ tracked: false, trackedStoryId: null });
  });

  it('is already tracked on mount when the subject\'s story exists, found by article id or by stable cluster id', async () => {
    const s = subject(freshId());
    await follow(s);

    const byArticle = renderHook(() => useTrackedSubject(s));
    const byCluster = renderHook(() => useTrackedSubject(subject(freshId(), { stableClusterId: 'clu-1' })));

    await waitFor(() => byArticle.result.current.tracked && byCluster.result.current.tracked);
    expect(byArticle.result.current.tracked).toBe(true);
    expect(byCluster.result.current.tracked).toBe(true);
    expect(byCluster.result.current.trackedStoryId).toBe(byArticle.result.current.trackedStoryId);
  });

  it('does not read the table at all while it is not active, and starts once it becomes active', async () => {
    const s = subject(freshId());
    await follow(s);
    const { result, rerender } = renderHook((props: { active: boolean }) => useTrackedSubject(s, props.active), {
      initialProps: { active: false },
    });
    await waitFor(() => result.current.tracked, 200);
    expect(result.current.tracked).toBe(false);

    rerender({ active: true });

    await waitFor(() => result.current.tracked);
    expect(result.current.tracked).toBe(true);
  });

  it('startTracking opens the article-feedback chat on the subject, seeded with the follow message', async () => {
    const s = subject(freshId(), { pubDate: '2026-10-09T06:00:00.000Z' });
    const { result } = renderHook(() => useTrackedSubject(s));
    await waitFor(() => result.current.tracked === false);

    act(() => result.current.startTracking());

    const chat = useFloatingChatStore.getState();
    expect(chat.isExpanded).toBe(true);
    expect(chat.pendingInitialMessage).toBe('I want to follow this story.');
    expect(chat.context).toEqual({
      kind: 'article-suggestion',
      articleId: s.articleId,
      suggestionId: s.suggestionId,
      articleTitle: s.title,
      trackSubject: {
        origin: 'suggestion',
        surface: 'for_you',
        articleId: s.articleId,
        title: s.title,
        pubDate: '2026-10-09T06:00:00.000Z',
        stableClusterId: 'clu-1',
        publicationName: 'Seed Pub',
      },
    });
  });

  it('startTracking carries nulls for the optional subject fields it was not given', async () => {
    const s = subject(freshId(), { pubDate: undefined, stableClusterId: undefined, publicationName: undefined });
    const { result } = renderHook(() => useTrackedSubject(s));
    await waitFor(() => result.current.tracked === false);

    act(() => result.current.startTracking());

    expect(useFloatingChatStore.getState().context).toMatchObject({
      trackSubject: { pubDate: null, stableClusterId: null, publicationName: null },
    });
  });

  // Q13: re-following is not a thing, and the only way to stop is a destructive delete, so a stray
  // second tap must neither re-open the proposal nor untrack anything.
  it('startTracking does nothing when the story is already followed', async () => {
    const s = subject(freshId());
    await follow(s);
    const { result } = renderHook(() => useTrackedSubject(s));
    await waitFor(() => result.current.tracked);

    act(() => result.current.startTracking());

    const chat = useFloatingChatStore.getState();
    expect(chat.isExpanded).toBe(false);
    expect(chat.pendingInitialMessage).toBeNull();
    expect(result.current.tracked).toBe(true);
  });
});
