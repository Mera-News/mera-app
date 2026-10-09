// reconcileTrackedStories against the real tracked-story, suggestion, saved-suggestion and
// notification services on the in-memory DB. A followed story is a tracked topic; the reconcile
// grows it from the suggestion rows already on the device. Suggestions go in through
// persistAndLinkV2Suggestions, stories through trackStoryWithProposal.
// Replaces lib/scheduler/feed-sync/__tests__/tracked-story-reconcile.test.ts.
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

import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import { persistAndLinkV2Suggestions } from '@/lib/database/services/article-suggestion-service';
import * as trackedStoryService from '@/lib/database/services/tracked-story-service';
import {
  getTrackedStoryById,
  observeActive,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import { reconcileTrackedStories } from '@/lib/scheduler/feed-sync/tracked-story-reconcile';
import { deleteTrackedStoryById, disownStoryMember, trackStoryWithProposal } from '@/lib/tracking/track-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import logger from '@/lib/logger';
import { firstValueFrom } from 'rxjs';
import { server } from '@/test/helpers';
import {
  art,
  cleanupFeedSync,
  failTableQuery,
  hydrate,
  makeCtx,
  resetFeedSyncMemory,
  retentionRows,
  seedInterest,
  servePersona,
  serveHydrate,
  spyOnExport,
  fetchAndDiff,
  until,
} from './support';

beforeEach(resetFeedSyncMemory);
afterEach(cleanupFeedSync);

const SEED_PUB_MS = Date.parse('2026-10-09T06:00:00.000Z');

const subject = (articleId: string, over: Partial<FeedbackSubject> = {}): FeedbackSubject => ({
  origin: 'suggestion',
  surface: 'for_you',
  articleId,
  title: `Seed ${articleId}`,
  pubDate: new Date(SEED_PUB_MS).toISOString(),
  publicationName: 'Seed Pub',
  ...over,
});

/** Follow a story: mints the tracked topic, the story row and the seed member's retention. */
async function follow(seedArticleId: string, searchText: string) {
  await trackStoryWithProposal(subject(seedArticleId), { label: `Label ${searchText}`, searchText });
  const stories = await firstValueFrom(observeActive());
  const story = stories.find((s) => s.topicText === searchText)!;
  return { storyId: story.id, topicId: story.topicId as string };
}

/** Suggestion rows on the device, each matched to the given topic ids, as feed-sync stores them. */
async function stored(
  rows: { id: string; topicIds: string[]; over?: Parameters<typeof art>[1] }[],
) {
  const personaMeta = {
    matchedTopics: new Map(rows.map((r) => [r.id, r.topicIds.map((topicId) => ({ topicId, text: topicId }))])),
  };
  await persistAndLinkV2Suggestions(
    rows.map((r) => art(r.id, r.over)),
    new Map(),
    personaMeta,
  );
}

const members = async (storyId: string) => (await getTrackedStoryById(storyId))!.memberArticleIds;
const snapshots = async (storyId: string): Promise<TrackedStoryMemberSnapshot[]> =>
  (await getTrackedStoryById(storyId))!.memberSnapshots ?? [];

describe('reconcileTrackedStories', () => {
  it('does nothing when no story is followed', async () => {
    await stored([{ id: 'a1', topicIds: ['topic-x'] }]);

    await expect(reconcileTrackedStories()).resolves.toBeUndefined();

    expect(await retentionRows()).toEqual([]);
  });

  it('grows a followed story from the suggestions that matched its topic, newest member first, and stamps it checked', async () => {
    const { storyId, topicId } = await follow('seed', 'gaza ceasefire');
    await stored([
      { id: 'seed', topicIds: [topicId] }, // already a member
      { id: 'new1', topicIds: [topicId] },
      { id: 'elsewhere', topicIds: ['some-other-topic'] },
    ]);
    expect((await getTrackedStoryById(storyId))!.lastCheckedAt).toBeNull();

    await reconcileTrackedStories();

    expect(await members(storyId)).toEqual(['new1', 'seed']);
    const story = (await getTrackedStoryById(storyId))!;
    expect(story.lastCheckedAt).not.toBeNull();
    expect(story.status).toBe('active');
  });

  it('remembers a lean snapshot per new member, with the original-language title beside the English one', async () => {
    const { storyId, topicId } = await follow('seed', 'tokyo weather');
    await stored([
      {
        id: 'jp1',
        topicIds: [topicId],
        over: {
          title: '東京で雨',
          title_en: 'Tokyo rain',
          publication_name: 'NHK',
          language_code: 'ja',
          country_code: 'JPN',
          pubDate: new Date(SEED_PUB_MS + 3_600_000).toISOString(),
        },
      },
    ]);

    await reconcileTrackedStories();

    const snap = (await snapshots(storyId)).find((s) => s.articleId === 'jp1')!;
    expect(snap).toMatchObject({
      articleId: 'jp1',
      title: 'Tokyo rain',
      titleOriginal: '東京で雨',
      publicationName: 'NHK',
      languageCode: 'ja',
      countryCode: 'JPN',
      pubDateMs: SEED_PUB_MS + 3_600_000,
    });
  });

  it('counts only members newer than what the reader saw as unseen', async () => {
    const { storyId, topicId } = await follow('seed', 'gaza ceasefire');
    await stored([
      { id: 'older', topicIds: [topicId], over: { pubDate: new Date(SEED_PUB_MS - 3_600_000).toISOString() } },
      { id: 'newer', topicIds: [topicId], over: { pubDate: new Date(SEED_PUB_MS + 3_600_000).toISOString() } },
    ]);

    await reconcileTrackedStories();

    expect((await getTrackedStoryById(storyId))!.unseenCount).toBe(1);
  });

  it('writes a retention row (origin tracked_story) for the seed and for each new member', async () => {
    const { topicId } = await follow('seed', 'gaza ceasefire');
    await stored([
      { id: 'new1', topicIds: [topicId] },
      { id: 'new2', topicIds: [topicId] },
    ]);

    await reconcileTrackedStories();

    const rows = (await retentionRows()).sort((a, b) => a.id.localeCompare(b.id));
    expect(rows).toEqual([
      { id: 'new1', origin: 'tracked_story' },
      { id: 'new2', origin: 'tracked_story' },
      { id: 'seed', origin: 'tracked_story' },
    ]);
  });

  it('raises no notification: growth is quiet', async () => {
    const { topicId } = await follow('seed', 'gaza ceasefire');
    await stored([{ id: 'new1', topicIds: [topicId] }]);

    await reconcileTrackedStories();

    expect(await getNotifications()).toEqual([]);
  });

  it('stamps a story checked but does not grow it when no fresh member matches', async () => {
    const { storyId, topicId } = await follow('seed', 'gaza ceasefire');
    await stored([{ id: 'seed', topicIds: [topicId] }]);

    await reconcileTrackedStories();

    const story = (await getTrackedStoryById(storyId))!;
    expect(story.memberArticleIds).toEqual(['seed']);
    expect(story.lastUpdateAt).toBeNull();
    expect(story.lastCheckedAt).not.toBeNull();
    expect(story.status).toBe('active');
  });

  it('grows each story from its own topic only', async () => {
    const a = await follow('seedA', 'gaza ceasefire');
    const b = await follow('seedB', 'titan inquiry');
    await stored([
      { id: 'a1', topicIds: [a.topicId] },
      { id: 'b1', topicIds: [b.topicId] },
    ]);

    await reconcileTrackedStories();

    expect(await members(a.storyId)).toEqual(['a1', 'seedA']);
    expect(await members(b.storyId)).toEqual(['b1', 'seedB']);
  });

  it('isolates a failure in one story: the others still grow and every story is stamped', async () => {
    const a = await follow('seedA', 'gaza ceasefire');
    const b = await follow('seedB', 'titan inquiry');
    await stored([
      { id: 'a1', topicIds: [a.topicId] },
      { id: 'b1', topicIds: [b.topicId] },
    ]);
    spyOnExport(trackedStoryService, 'applyUpdates').mockRejectedValueOnce(new Error('boom'));

    await reconcileTrackedStories();

    expect(logger.captureException).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'boom' }),
      expect.objectContaining({
        tags: expect.objectContaining({ component: 'tracked-story-reconcile' }),
        extra: expect.objectContaining({ trackedStoryId: expect.any(String) }),
      }),
    );
    // the story whose update failed kept its seed only; the other one grew
    const sizes = await Promise.all([a, b].map(async (s) => (await members(s.storyId)).length));
    expect(sizes.sort()).toEqual([1, 2]);
    for (const s of [a, b]) expect((await getTrackedStoryById(s.storyId))!.lastCheckedAt).not.toBeNull();
  });
});

describe('releasing retention when a snapshot goes', () => {
  it('disowning a member removes its snapshot and its retention row, and keeps the others', async () => {
    const { storyId, topicId } = await follow('seed', 'gaza ceasefire');
    await stored([
      { id: 'new1', topicIds: [topicId] },
      { id: 'new2', topicIds: [topicId] },
    ]);
    await reconcileTrackedStories();

    await expect(disownStoryMember(storyId, 'new1')).resolves.toBe(true);

    expect((await snapshots(storyId)).map((s) => s.articleId).sort()).toEqual(['new2', 'seed']);
    expect((await retentionRows()).map((r) => r.id).sort()).toEqual(['new2', 'seed']);
  });

  it('keeps the retention row while another followed story still holds the article', async () => {
    const a = await follow('seedA', 'gaza ceasefire');
    const b = await follow('seedB', 'ceasefire talks');
    await stored([{ id: 'shared', topicIds: [a.topicId, b.topicId] }]);
    await reconcileTrackedStories();
    expect((await retentionRows()).map((r) => r.id)).toContain('shared');

    await disownStoryMember(a.storyId, 'shared');
    expect((await retentionRows()).map((r) => r.id)).toContain('shared');

    await disownStoryMember(b.storyId, 'shared');
    expect((await retentionRows()).map((r) => r.id)).not.toContain('shared');
  });

  it('deleting a story releases every member it held', async () => {
    const { storyId, topicId } = await follow('seed', 'gaza ceasefire');
    await stored([{ id: 'new1', topicIds: [topicId] }]);
    await reconcileTrackedStories();
    expect((await retentionRows()).map((r) => r.id).sort()).toEqual(['new1', 'seed']);

    await expect(deleteTrackedStoryById(storyId)).resolves.toBe(true);

    expect(await retentionRows()).toEqual([]);
  });
});

describe('the reconcile as the feed sync runs it', () => {
  it('grows a followed story from the articles the sync just persisted', async () => {
    const { storyId } = await follow('seed', 'gaza ceasefire');
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'gaza ceasefire': ['n1', 'n2'] } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);
    expect(diff.storyIds).toEqual(['n1', 'n2']);

    await hydrate(diff, t);

    // fire-and-forget: the step does not wait for the reconcile
    await until(async () => (await members(storyId)).length === 3, 'the story to grow');
    expect([...(await members(storyId))].sort()).toEqual(['n1', 'n2', 'seed']);
    await until(async () => (await retentionRows()).length === 3, 'retention rows');
    expect((await retentionRows()).map((r) => r.origin)).toEqual(['tracked_story', 'tracked_story', 'tracked_story']);
  });

  it('never lets a reconcile failure surface from the sync', async () => {
    await seedInterest('I follow racing', ['formula 1']);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'formula 1': ['n1'] } }), ...served.handlers);
    const t = makeCtx();
    const { diff } = await fetchAndDiff(t);
    failTableQuery('tracked_stories');

    const run = await hydrate(diff, t);

    expect(run.result.insertedCount).toBe(1);
    await until(
      () => (logger.captureException as jest.Mock).mock.calls.some(([, o]) => o?.tags?.method === 'reconcileTrackedStories'),
      'the reconcile failure to be reported',
    );
  });
});
