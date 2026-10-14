// tracked-story-reconcile over the in-memory DB: how a followed story grows across feed syncs.
// Story, topic and suggestion rows are seeded directly; each "sync" is one reconcileTrackedStories
// call. Faked: nothing.
import database from '@/lib/database';
import type ArticleSuggestionModel from '@/lib/database/models/ArticleSuggestion';
import { getTrackedStoryById, trackStory } from '@/lib/database/services/tracked-story-service';
import { createTopics } from '@/lib/database/services/topic-service';
import { reconcileTrackedStories } from '@/lib/scheduler/feed-sync/tracked-story-reconcile';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);

async function seedSuggestions(topicId: string, count: number): Promise<void> {
  const col = database.get<ArticleSuggestionModel>('article_suggestions');
  await database.write(async () => {
    for (let i = 0; i < count; i++) {
      await col.create((r) => {
        r._raw.id = `art-${i}`;
        r.titleEn = `Headline ${i}`;
        r.firstPubDate = new Date(T0 + i * 60_000);
        r.matchedTopicsJson = JSON.stringify([{ topicId, text: 'Russia Ukraine war' }]);
      });
    }
  });
}

describe('followed story growth', () => {
  // A hot story has more matching rows on device than the member-id ledger used to hold (30).
  // Ids pushed off the ledger read as new on the next sync, so the same articles were counted
  // again every sync and the "N new" badge climbed into the thousands.
  it('counts each matching article once across repeated syncs and keeps them all', async () => {
    const [topic] = await createTopics([
      { text: 'Russia Ukraine war', weight: 0.85, status: 'active', provenance: 'tracked', highPriority: true },
    ]);
    const story = await trackStory({
      stableClusterId: null,
      articleId: 'seed',
      title: 'Seed',
      originSurface: 'feed',
      topicId: topic.id,
      topicText: 'Russia Ukraine war',
      llmHeadline: 'Russia-Ukraine war',
      initialSnapshot: { articleId: 'seed', title: 'Seed', pubDateMs: T0 - 1 },
    });
    await seedSuggestions(topic.id, 120);

    await reconcileTrackedStories();
    const afterFirst = (await getTrackedStoryById(story.id))?.unseenCount;
    await reconcileTrackedStories();
    await reconcileTrackedStories();

    expect(afterFirst).toBe(120);
    const after = await getTrackedStoryById(story.id);
    expect(after?.unseenCount).toBe(120);
    // The timeline keeps every member, not the newest 50 (seed included).
    expect(after?.memberSnapshots).toHaveLength(121);
  });
});
