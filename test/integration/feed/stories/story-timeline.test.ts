// useStoryTimelineScreen: a followed story's timeline, driven under renderHook with the real
// stores and the in-memory DB. Stories and topics are seeded through the app's own services
// (tracked-story-service, topic-service). Focus is the hook's `onFocus`, called by the test along
// with its cleanup. Faked: nothing (the screen has no timers).
import { renderHookInScreen } from '@/test/helpers';
import { act, waitFor } from '@testing-library/react-native';
import { useStoryTimelineScreen } from '@/components/custom/tracked-stories/useStoryTimelineScreen';
import {
  applyUpdates,
  getTrackedStoryById,
  trackStory,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import * as trackedStoryService from '@/lib/database/services/tracked-story-service';
import { createTopics, getAllByNormalizedText } from '@/lib/database/services/topic-service';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const snap = (articleId: string, hoursAfter: number): TrackedStoryMemberSnapshot => ({
  articleId,
  title: `Headline ${articleId}`,
  pubDateMs: T0 + hoursAfter * 3_600_000,
  languageCode: 'en',
  countryCode: 'NLD',
});

const TOPIC_TEXT = 'harbour bridge repairs';

/**
 * A followed story: its topic, the originating article m1 (seeded as the story's first snapshot),
 * and two members found later (m2, m3) that postdate the seen watermark, so `unseen_count` is 2.
 */
async function seedStory(): Promise<{ storyId: string; topicId: string }> {
  const [topic] = await createTopics([
    { text: TOPIC_TEXT, weight: 0.85, status: 'active', provenance: 'tracked', highPriority: true },
  ]);
  const story = await trackStory({
    stableClusterId: null,
    articleId: 'm1',
    title: 'Headline m1',
    originSurface: 'feed',
    topicId: topic.id,
    topicText: TOPIC_TEXT,
    llmHeadline: 'Harbour bridge repairs',
    initialSnapshot: snap('m1', 0),
  });
  await applyUpdates(story.id, { newMemberIds: ['m3', 'm2'], newSnapshots: [snap('m2', 1), snap('m3', 2)] });
  return { storyId: story.id, topicId: topic.id };
}

const open = (trackedStoryId: string, onBack = jest.fn()) => ({
  onBack,
  ...renderHookInScreen(() => useStoryTimelineScreen({ trackedStoryId, onBack })),
});

/** Focus the screen the way useFocusEffect does and hand back the effect's cleanup. */
async function focus(hook: { current: { onFocus: () => () => void } }): Promise<() => void> {
  let cleanup!: () => void;
  await act(async () => {
    cleanup = hook.current.onFocus();
  });
  return cleanup;
}

describe('onFocus', () => {
  it('reads the unseen count before markSeen stamps it, then loads the timeline newest first', async () => {
    const { storyId } = await seedStory();
    expect((await getTrackedStoryById(storyId))?.unseenCount).toBe(2);

    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    await waitFor(() => expect(result.current.newAtOpen).toBe(2));

    expect((await getTrackedStoryById(storyId))?.unseenCount).toBe(0);
    expect(result.current.cards.map((c) => c.articleId)).toEqual(['m3', 'm2', 'm1']);
    expect(result.current.headline).toBe('Harbour bridge repairs');
    expect(result.current.isLlmHeadline).toBe(true);
    expect(result.current.emptyReason).toBe('quiet');
  });

  it('a second open reports nothing new: the first visit cleared the badge', async () => {
    const { storyId } = await seedStory();
    const first = open(storyId);
    await focus(first.result);
    await waitFor(() => expect(first.result.current.newAtOpen).toBe(2));
    await waitFor(async () => expect((await getTrackedStoryById(storyId))?.unseenCount).toBe(0));

    const second = open(storyId);
    await focus(second.result);
    await waitFor(() => expect(second.result.current.isLoading).toBe(false));
    expect(second.result.current.newAtOpen).toBe(0);
    expect(second.result.current.cards).toHaveLength(3);
  });

  it('the cleanup invalidates a load still in flight: a blurred screen writes no state', async () => {
    const { storyId } = await seedStory();
    const { result } = open(storyId);
    act(() => {
      result.current.onFocus()(); // focus, then blur before the first read can answer
    });
    await act(async () => {
      for (let i = 0; i < 20; i++) await new Promise<void>((resolve) => setImmediate(resolve));
    });
    expect(result.current.cards).toEqual([]);
    expect(result.current.isLoading).toBe(true);
  });
});

describe('a story missing from the DB', () => {
  it('has the empty reason gone, no cards, and a zero unseen count', async () => {
    const { result } = open('does-not-exist');
    await focus(result);
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.emptyReason).toBe('gone');
    expect(result.current.cards).toEqual([]);
    expect(result.current.newAtOpen).toBe(0);
  });
});

describe('disowning a member ("not part of this story")', () => {
  it('the snapshot leaves the timeline and the row, and the member id STAYS on the row', async () => {
    const { storyId } = await seedStory();
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.cards).toHaveLength(3));

    act(() => result.current.setConfirmRemove(result.current.entries.find((e) => e.head.articleId === 'm2')!));
    await act(async () => {
      await result.current.handleConfirmRemove();
    });

    expect(result.current.cards.map((c) => c.articleId)).toEqual(['m3', 'm1']);
    expect(result.current.confirmRemove).toBeNull();
    const row = await getTrackedStoryById(storyId);
    expect(row?.memberSnapshots.map((s) => s.articleId)).toEqual(['m3', 'm1']);
    // The reconcile's already-considered ledger keeps it, so the next sync cannot resurrect the card.
    expect(row?.memberArticleIds).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
    expect(row?.memberArticleIds).toHaveLength(3);
  });

  it('a remove with nothing chosen changes nothing', async () => {
    const { storyId } = await seedStory();
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.cards).toHaveLength(3));
    await act(async () => {
      await result.current.handleConfirmRemove();
    });
    expect(result.current.cards).toHaveLength(3);
    expect((await getTrackedStoryById(storyId))?.memberSnapshots).toHaveLength(3);
  });
});

describe('deleting the story', () => {
  it('the row is gone, the linked topic is retired (not destroyed), and the screen leaves', async () => {
    const { storyId, topicId } = await seedStory();
    const { result, onBack } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.cards).toHaveLength(3));

    act(() => result.current.setConfirmDelete(true));
    await act(async () => {
      await result.current.handleConfirmDelete();
    });

    expect(await getTrackedStoryById(storyId)).toBeNull();
    const topics = await getAllByNormalizedText(TOPIC_TEXT);
    expect(topics.map((t) => [t.id, t.status])).toEqual([[topicId, 'retired']]);
    expect(onBack).toHaveBeenCalledTimes(1);
    expect(result.current.confirmDelete).toBe(false);
  });
});

describe('export', () => {
  it('has one row per member that has an article id, in timeline order', async () => {
    const { storyId } = await seedStory();
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.cards).toHaveLength(3));
    expect(result.current.exportRows).toEqual([
      { id: 'm3', title: 'Headline m3', language: 'en' },
      { id: 'm2', title: 'Headline m2', language: 'en' },
      { id: 'm1', title: 'Headline m1', language: 'en' },
    ]);
  });

  it('is empty before the timeline loads', async () => {
    const { storyId } = await seedStory();
    const { result } = open(storyId);
    expect(result.current.exportRows).toEqual([]);
  });
});

describe('copies of one story fold into one entry', () => {
  /** m2 and m3 are two publishers' copies of one story (same storyKey); m1 is another story. */
  async function seedFolded() {
    const { storyId } = await seedStory();
    await trackedStoryService.backfillSnapshotSource(
      storyId,
      new Map([
        ['m2', { storyKey: 'K' }],
        ['m3', { storyKey: 'K' }],
      ]),
    );
    return storyId;
  }

  it('shows one entry for the two copies, counts it as one article, and exports its head only', async () => {
    const storyId = await seedFolded();
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    const folded = result.current.entries.find((e) => e.copies.length === 1)!;
    expect([folded.head.articleId, folded.copies[0].articleId].sort()).toEqual(['m2', 'm3']);
    expect(result.current.exportRows.map((r) => r.id).sort()).toEqual(['m1', folded.head.articleId].sort());
  });

  it('disowning the entry disowns every copy, and the ledger keeps the ids', async () => {
    const storyId = await seedFolded();
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    act(() => result.current.setConfirmRemove(result.current.entries.find((e) => e.copies.length === 1)!));
    await act(async () => {
      await result.current.handleConfirmRemove();
    });
    expect(result.current.entries.map((e) => e.head.articleId)).toEqual(['m1']);
    const row = await getTrackedStoryById(storyId);
    expect(row?.memberSnapshots.map((s) => s.articleId)).toEqual(['m1']);
    expect(row?.memberArticleIds).toEqual(expect.arrayContaining(['m1', 'm2', 'm3']));
  });

  it('disowning a head with two copies removes all three from the row, none written back by a stale list', async () => {
    const { storyId } = await seedStory();
    await applyUpdates(storyId, { newMemberIds: ['m4'], newSnapshots: [snap('m4', 3)] });
    await trackedStoryService.backfillSnapshotSource(
      storyId,
      new Map([
        ['m2', { storyKey: 'K' }],
        ['m3', { storyKey: 'K' }],
        ['m4', { storyKey: 'K' }],
      ]),
    );
    const { result } = open(storyId);
    await focus(result);
    await waitFor(() => expect(result.current.entries).toHaveLength(2));
    act(() => result.current.setConfirmRemove(result.current.entries.find((e) => e.copies.length === 2)!));
    await act(async () => {
      await result.current.handleConfirmRemove();
    });
    const row = await getTrackedStoryById(storyId);
    expect(row?.memberSnapshots.map((s) => s.articleId)).toEqual(['m1']);
  });
});
