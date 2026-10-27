// Followed stories: tracked-story-service and the follow flow in lib/tracking/track-actions, on the
// in-memory DB over the real topic, suggestion, saved-suggestion, setting and fact-check services.
// A story is a tracked topic plus a `tracked_stories` row; every member is retained on the device.
// The legacy-conversion half of track-actions is in legacy-migration.test.ts.
//
// Replaces lib/database/services/__tests__/tracked-story-service.test.ts (all 56 `it`) and, from
// lib/tracking/__tests__/track-actions.test.ts, trackStoryWithProposal (8 + 3 article-less),
// deleteTrackedStoryById (5), disownStoryMember (2) and isSubjectTracked (1).
//
// Not carried over: tracked-story-service's `sortTrackedStories` and `mergeMemberSnapshots` unit
// cases are asserted through observeActive and applyUpdates (the pure functions are only called there).
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

import database from '@/lib/database';
import { getSetting } from '@/lib/database/services/setting-service';
import * as savedService from '@/lib/database/services/saved-article-suggestion-service';
import * as topicService from '@/lib/database/services/topic-service';
import { getAllByNormalizedText } from '@/lib/database/services/topic-service';
import {
  MAX_MEMBER_IDS,
  MAX_MEMBER_SNAPSHOTS,
  advanceSeenWatermark,
  applyUpdates,
  backfillSnapshotSource,
  bindTrackedTopic,
  findActiveTrackedId,
  getActiveForTopicReconcile,
  getLegacyTrackedForMigration,
  getTrackedStoryById,
  isTracked,
  isTrackedStoryMember,
  markSeen,
  observeActive,
  observeTracked,
  observeTrackedId,
  observeUnseenTotal,
  removeMemberSnapshot,
  setLlmHeadline,
  stampChecked,
  trackStory,
  untrackStory,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import logger from '@/lib/logger';
import {
  backfillTrackedStoryRetention,
  deleteTrackedStoryById,
  disownStoryMember,
  isSubjectTracked,
  observeSubjectTrackedId,
  retainStoryMember,
  trackStoryWithProposal,
} from '@/lib/tracking/track-actions';
import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { useFakeClock } from '@/test/helpers';
import {
  collect,
  failTableQuery,
  freshId,
  landSuggestion,
  originsById,
  rawTracked,
  resetRetentionMemory,
  restoreFaults,
  restoreRows,
  savedRow,
  savedRows,
  spyOn,
  waitFor,
} from './support';

beforeEach(resetRetentionMemory);
afterEach(restoreFaults);

const warn = logger.warn as jest.Mock;
const captureException = logger.captureException as jest.Mock;

const T0 = Date.UTC(2026, 9, 9, 12, 0, 0);
const PUB = T0 - 3_600_000;

const subject = (articleId: string, over: Partial<FeedbackSubject> = {}): FeedbackSubject => ({
  origin: 'suggestion',
  surface: 'for_you',
  articleId,
  title: `Seed ${articleId}`,
  pubDate: new Date(PUB).toISOString(),
  publicationName: 'Seed Pub',
  ...over,
});

const snap = (articleId: string, pubDateMs: number, over: Partial<TrackedStoryMemberSnapshot> = {}): TrackedStoryMemberSnapshot => ({
  articleId,
  title: `Title ${articleId}`,
  pubDateMs,
  ...over,
});

/** Follows a story through the confirmed-proposal path; returns the story id. */
async function follow(articleId: string, searchText = `story ${articleId}`, over: Partial<FeedbackSubject> = {}): Promise<string> {
  await trackStoryWithProposal(subject(articleId, over), { label: `Label ${searchText}`, searchText });
  return (await findActiveTrackedId({ articleId }))!;
}

const story = async (id: string) => (await getTrackedStoryById(id))!;
const memberIds = async (id: string) => (await story(id)).memberArticleIds;
const snapshotIds = async (id: string) => (await story(id)).memberSnapshots.map((s) => s.articleId);

describe('trackStory', () => {
  it('creates an active row seeded from the tapped article, with no topic', async () => {
    const created = await trackStory({ stableClusterId: 'clu-1', articleId: 'art-1', title: ' Big story ', originSurface: 'for_you' });

    const row = await story(created.id);
    expect(row).toMatchObject({
      status: 'active',
      stableClusterId: 'clu-1',
      memberArticleIds: ['art-1'],
      fallbackTitle: 'Big story',
      latestArticleId: 'art-1',
      originSurface: 'for_you',
      unseenCount: 0,
      missCount: 0,
      llmHeadline: null,
      lastUpdateAt: null,
      lastCheckedAt: null,
      topicId: null,
      topicText: null,
      memberSnapshots: [],
    });
  });

  it('persists the topic link, headline and the seed snapshot of a topic-linked story', async () => {
    const created = await trackStory({
      stableClusterId: 'clu-1',
      articleId: 'art-1',
      title: 'Big story',
      originSurface: 'for_you',
      topicId: 'top-1',
      topicText: 'Updates on the protest',
      llmHeadline: 'Updates on the protest',
      initialSnapshot: { articleId: 'art-1', title: 'Big story', pubDateMs: 1_700_000_000_000, publicationName: 'BBC' },
    });

    expect(await story(created.id)).toMatchObject({
      topicId: 'top-1',
      topicText: 'Updates on the protest',
      llmHeadline: 'Updates on the protest',
      memberSnapshots: [{ articleId: 'art-1', title: 'Big story', pubDateMs: 1_700_000_000_000, publicationName: 'BBC' }],
    });
  });

  // Q15. A fresh story with no watermark takes applyUpdates' legacy branch, so the first reconcile
  // counted every pre-existing article as new.
  it('seeds the seen-pubDate watermark from the tapped article, so a fresh follow shows 0 new', async () => {
    const created = await trackStory({
      articleId: 'art-1',
      title: 'Big story',
      originSurface: 'detail',
      initialSnapshot: snap('art-1', 5_000),
    });
    expect(await story(created.id)).toMatchObject({ seenPubWatermarkMs: 5_000, unseenCount: 0 });
  });

  it('falls back to now, never 0, when the seed has no pubDate or there is no snapshot at all', async () => {
    useFakeClock(T0);
    const undated = await trackStory({ articleId: 'a1', title: 'Undated', originSurface: 'detail', initialSnapshot: snap('a1', 0) });
    const bare = await trackStory({ articleId: 'a2', title: 'No snapshot', originSurface: 'detail' });

    // 0 would switch the story onto the gated branch with an all-permissive threshold
    expect((await story(undated.id)).seenPubWatermarkMs).toBeGreaterThanOrEqual(T0);
    expect((await story(bare.id)).seenPubWatermarkMs).toBeGreaterThanOrEqual(T0);
  });

  it('normalises a blank stable cluster id and origin surface to null', async () => {
    const created = await trackStory({ stableClusterId: '   ', articleId: 'art-2', title: 'X', originSurface: '  ' });
    expect(await story(created.id)).toMatchObject({ stableClusterId: null, originSurface: null });
  });
});

describe('trackStoryWithProposal', () => {
  it('mints a tracked topic from the search text and a topic-linked story headed by the label', async () => {
    const s = await landSuggestion(freshId());

    await trackStoryWithProposal(subject(s.articleId, { stableClusterId: 'clu-1' }), { label: ' Protest updates ', searchText: ' Updates on the protest ' });

    const [topic] = await getAllByNormalizedText('updates on the protest');
    expect(topic).toMatchObject({ status: 'active', provenance: 'tracked', highPriority: true, weight: 0.85 });
    const id = (await findActiveTrackedId({ articleId: s.articleId }))!;
    expect(await story(id)).toMatchObject({
      topicId: topic.id,
      topicText: 'Updates on the protest',
      llmHeadline: 'Protest updates',
      stableClusterId: 'clu-1',
      originSurface: 'for_you',
      fallbackTitle: `Seed ${s.articleId}`,
      memberArticleIds: [s.articleId],
      latestArticleId: s.articleId,
    });
  });

  it('seeds the first snapshot with the subject\'s real pubDate and country, and no publication or language', async () => {
    const id = await follow(freshId(), 'tokyo weather', { countryCode: 'JPN' } as never);
    const row = await story(id);
    expect(row.memberSnapshots).toEqual([
      expect.objectContaining({ title: expect.stringContaining('Seed'), pubDateMs: PUB, countryCode: 'JPN' }),
    ]);
    expect(row.memberSnapshots[0].publicationName).toBeUndefined();
    expect(row.memberSnapshots[0].languageCode).toBeUndefined();
    expect(row.seenPubWatermarkMs).toBe(PUB);
  });

  it('falls back to 0 (unknown), not now, when the subject carries no pubDate', async () => {
    useFakeClock(T0);
    const id = await follow(freshId(), 'undated story', { pubDate: undefined });
    const row = await story(id);
    expect(row.memberSnapshots[0].pubDateMs).toBe(0);
    expect(row.seenPubWatermarkMs).toBeGreaterThanOrEqual(T0);
  });

  it('uses the search text as the headline when the label is blank', async () => {
    const a = freshId();
    await trackStoryWithProposal(subject(a), { label: '  ', searchText: 'plain search' });
    expect((await story((await findActiveTrackedId({ articleId: a }))!)).llmHeadline).toBe('plain search');
  });

  it('retains the seed article like a save does, from the local suggestion when it is still there', async () => {
    const s = await landSuggestion(freshId());

    await follow(s.articleId);

    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
    expect(await savedService.getSavedSuggestionByServerId(s.articleId)).toMatchObject({
      description_en: s.description_en,
      article_url: s.article_url,
    });
  });

  it('degrades to the subject\'s title and publication when the suggestion is gone', async () => {
    const id = freshId();

    await follow(id);

    expect(await savedService.getSavedSuggestionByServerId(id)).toMatchObject({
      title_en: `Seed ${id}`,
      publication_name: 'Seed Pub',
      article_url: null,
    });
  });

  it('does not mint a second topic or row when the same scope is followed again', async () => {
    const a = freshId();
    const first = await follow(a, 'gaza ceasefire', { stableClusterId: 'clu-9' });

    await trackStoryWithProposal(subject(a), { label: 'Again', searchText: 'gaza ceasefire' });
    // a different article of the SAME cluster is the same story
    await trackStoryWithProposal(subject(freshId(), { stableClusterId: 'clu-9' }), { label: 'Again', searchText: ' Gaza  Ceasefire ' });

    expect((await observeAll()).map((r) => r.id)).toEqual([first]);
    expect(await getAllByNormalizedText('gaza ceasefire')).toHaveLength(1);
  });

  it('follows a different scope of the same cluster as its own row', async () => {
    const a = freshId();
    const first = await follow(a, 'gaza ceasefire', { stableClusterId: 'clu-9' });

    await trackStoryWithProposal(subject(freshId(), { stableClusterId: 'clu-9' }), { label: 'Talks', searchText: 'gaza ceasefire talks' });

    const ids = (await observeAll()).map((r) => r.id);
    expect(ids).toHaveLength(2);
    expect(ids).toContain(first);
    expect(await getAllByNormalizedText('gaza ceasefire talks')).toHaveLength(1);
  });

  it('mints for a different story', async () => {
    await follow(freshId(), 'story one');
    await follow(freshId(), 'story two');
    expect(await observeAll()).toHaveLength(2);
  });

  it('does nothing for a blank search text', async () => {
    const a = freshId();
    await trackStoryWithProposal(subject(a), { label: 'Protest updates', searchText: '   ' });
    expect(await observeAll()).toEqual([]);
    expect(await savedRows()).toEqual([]);
  });

  it('still creates the story, with a null topic, when the topic mint throws', async () => {
    const a = freshId();
    spyOn(topicService, 'createTopics').mockRejectedValueOnce(new Error('mint failed'));

    await trackStoryWithProposal(subject(a), { label: 'Protest updates', searchText: 'Updates on the protest' });

    const row = await story((await findActiveTrackedId({ articleId: a }))!);
    expect(row).toMatchObject({ topicId: null, topicText: 'Updates on the protest' });
    expect(warn).toHaveBeenCalledWith('[track-actions] topic mint failed', expect.anything());
  });

  describe('from the article-less follow-story chat', () => {
    const FREE_TEXT = {
      origin: 'article',
      surface: 'tracked-stories-chat',
      articleId: '',
      title: '',
      pubDate: null,
      stableClusterId: null,
      publicationName: null,
    } as unknown as FeedbackSubject;

    it('mints the topic and a topic-linked story with no member and no retention', async () => {
      await trackStoryWithProposal(FREE_TEXT, { label: 'Protest updates', searchText: 'Updates on the protest' });

      const [row] = await observeAll();
      const [topic] = await getAllByNormalizedText('updates on the protest');
      expect(row).toMatchObject({
        topicId: topic.id,
        topicText: 'Updates on the protest',
        llmHeadline: 'Protest updates',
        originSurface: 'tracked-stories-chat',
        memberArticleIds: [],
        memberSnapshots: [],
        latestArticleId: null,
      });
      expect(topic).toMatchObject({ provenance: 'tracked', status: 'active' });
      expect(await savedRows()).toEqual([]);
    });

    it('is never blocked by an unrelated followed story', async () => {
      await follow(freshId(), 'story one');

      await trackStoryWithProposal(FREE_TEXT, { label: 'Free text', searchText: 'free text topic' });

      expect(await observeAll()).toHaveLength(2);
    });
  });
});

/** Every active story, via the reactive read (the only list there is). */
async function observeAll() {
  const values = collect(observeActive());
  await waitFor(() => values.length > 0);
  return values[values.length - 1];
}

describe('retainStoryMember', () => {
  it('does nothing for a blank id, or when there is neither a suggestion nor a title to keep', async () => {
    await retainStoryMember('  ');
    await retainStoryMember(freshId());
    await retainStoryMember(freshId(), { title: null, publicationName: null });
    expect(await savedRows()).toEqual([]);
  });

  it('never throws: a failed keep is logged and the follow carries on', async () => {
    spyOn(savedService, 'keepArticleForTrackedStory').mockRejectedValueOnce(new Error('keep failed'));
    await expect(retainStoryMember(freshId(), { title: 'x' })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[track-actions] member retention failed', expect.anything());
  });
});

describe('isTracked / findActiveTrackedId / observeTracked', () => {
  it('match a story by stable cluster id or by member article id, and by nothing else', async () => {
    const id = (await trackStory({ stableClusterId: 'clu-9', articleId: 'a1', title: 'T', originSurface: 'x' })).id;
    await applyUpdates(id, { newMemberIds: ['a2'] });

    expect(await isTracked({ stableClusterId: 'clu-9' })).toBe(true);
    expect(await isTracked({ stableClusterId: 'clu-other' })).toBe(false);
    expect(await isTracked({ articleId: 'a2' })).toBe(true);
    expect(await isTracked({ articleId: 'a3' })).toBe(false);
    expect(await isTracked({})).toBe(false);
    expect(await isTracked({ stableClusterId: '  ', articleId: ' ' })).toBe(false);
    expect(await findActiveTrackedId({ stableClusterId: 'clu-9' })).toBe(id);
    expect(await findActiveTrackedId({ articleId: 'a2' })).toBe(id);
    expect(await findActiveTrackedId({ articleId: 'a3' })).toBeNull();
    expect(await findActiveTrackedId({})).toBeNull();
  });

  it('ignore an ended story', async () => {
    await restoreRows({
      tracked_stories: [rawTracked('ended-1', { status: 'ended', stable_cluster_id: 'clu-3', member_article_ids_json: '["ea1"]' })],
    });
    expect(await isTracked({ stableClusterId: 'clu-3' })).toBe(false);
    expect(await isTracked({ articleId: 'ea1' })).toBe(false);
    expect(await findActiveTrackedId({ stableClusterId: 'clu-3' })).toBeNull();
    expect(await isTrackedStoryMember('ea1')).toBe(false);
  });

  it('observeTracked and observeTrackedId follow a story added and removed', async () => {
    const flags = collect(observeTracked({ articleId: 'a1' }));
    const ids = collect(observeTrackedId({ articleId: 'a1' }));
    await waitFor(() => flags.length > 0);
    expect(flags[flags.length - 1]).toBe(false);

    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    await waitFor(() => flags[flags.length - 1] === true);
    expect(flags[flags.length - 1]).toBe(true);
    expect(ids[ids.length - 1]).toBe(id);

    expect(await untrackStory(id)).toBe(true);
    await waitFor(() => flags[flags.length - 1] === false);
    expect(flags[flags.length - 1]).toBe(false);
    expect(ids[ids.length - 1]).toBeNull();
  });

  // DATA-U9-4. observeTrackedId watches the column 'member_article_ids', but the column is
  // 'member_article_ids_json', so a story that absorbs the article LATER (the topic reconcile) does not
  // re-emit and the track button stays on "Track story" until some other change re-fires the query.
  async function absorbLater() {
    const flags = collect(observeTracked({ articleId: 'a2' }));
    await waitFor(() => flags.length > 0);
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    await applyUpdates(id, { newMemberIds: ['a2'] });
    return { flags, id };
  }

  test('DATA-U9-4: observeTracked flips when a followed story absorbs the article through the reconcile', async () => {
    const { flags } = await absorbLater();

    expect(await waitFor(() => flags[flags.length - 1] === true)).toBe(true);
  });

  it('isSubjectTracked and observeSubjectTrackedId read the story a subject belongs to', async () => {
    const a = freshId();
    const ids = collect(observeSubjectTrackedId(subject(a)));
    expect(await isSubjectTracked(subject(a))).toBe(false);

    const id = await follow(a);

    expect(await isSubjectTracked(subject(a))).toBe(true);
    await waitFor(() => ids[ids.length - 1] === id);
  });
});

describe('observeActive / observeUnseenTotal', () => {
  it('list active stories with unseen updates first, then newest activity', async () => {
    useFakeClock(T0 - 600_000);
    const neverUpdated = (await trackStory({ articleId: 'n1', title: 'never updated', originSurface: 'x' })).id;
    jest.setSystemTime(T0);
    const quietOld = (await trackStory({ articleId: 'q1', title: 'quiet old', originSurface: 'x' })).id;
    const quietNew = (await trackStory({ articleId: 'q2', title: 'quiet new', originSurface: 'x' })).id;
    const unseen = (await trackStory({ articleId: 'u1', title: 'unseen', originSurface: 'x' })).id;
    // an update with no new ids bumps nothing but stamps last_update_at
    await applyUpdates(quietOld, { newMemberIds: [] });
    jest.setSystemTime(T0 + 60_000);
    await applyUpdates(quietNew, { newMemberIds: [] });
    jest.setSystemTime(T0 + 120_000);
    await applyUpdates(unseen, { newMemberIds: ['u2'] });

    const lists = collect(observeActive());
    await waitFor(() => lists.length > 0);

    // a story never updated sorts by created_at, which is older than every update here
    expect(lists[lists.length - 1].map((r) => r.id)).toEqual([unseen, quietNew, quietOld, neverUpdated]);
  });

  it('sum the unseen counts of active stories and drop to zero once they are seen', async () => {
    await restoreRows({ tracked_stories: [rawTracked('ended-1', { status: 'ended', unseen_count: 9 })] });
    const a = (await trackStory({ articleId: 'a1', title: 'A', originSurface: 'x' })).id;
    const b = (await trackStory({ articleId: 'b1', title: 'B', originSurface: 'x' })).id;
    await applyUpdates(a, { newMemberIds: ['a2', 'a3'] });
    await applyUpdates(b, { newMemberIds: ['b2'] });
    const totals = collect(observeUnseenTotal());
    await waitFor(() => totals[totals.length - 1] === 3);
    expect(totals[totals.length - 1]).toBe(3);

    await markSeen(a);
    await markSeen(b);

    await waitFor(() => totals[totals.length - 1] === 0);
    expect(totals[totals.length - 1]).toBe(0);
  });
});

describe('markSeen / advanceSeenWatermark', () => {
  it('markSeen zeroes the unseen count and never throws on a missing row', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    await applyUpdates(id, { newMemberIds: ['a2', 'a3', 'a4', 'a5'] });
    expect((await story(id)).unseenCount).toBe(4);

    await markSeen(id);
    expect((await story(id)).unseenCount).toBe(0);
    await expect(markSeen('nope')).resolves.toBeUndefined();
  });

  it('advanceSeenWatermark only moves forward, ignores non-positive or non-finite values and never throws', async () => {
    await restoreRows({ tracked_stories: [rawTracked('s1', { seen_pub_watermark_ms: null })] });

    await advanceSeenWatermark('s1', 5_000);
    expect((await story('s1')).seenPubWatermarkMs).toBe(5_000);
    await advanceSeenWatermark('s1', 9_000);
    expect((await story('s1')).seenPubWatermarkMs).toBe(9_000);
    await advanceSeenWatermark('s1', 3_000);
    expect((await story('s1')).seenPubWatermarkMs).toBe(9_000);
    for (const bad of [0, -1, NaN, Infinity]) await advanceSeenWatermark('s1', bad);
    expect((await story('s1')).seenPubWatermarkMs).toBe(9_000);
    await expect(advanceSeenWatermark('nope', 1_234)).resolves.toBeUndefined();
  });
});

describe('applyUpdates', () => {
  it('prepends the new ids, bumps unseen, stamps the update, points at the latest article and resets misses', async () => {
    useFakeClock(T0);
    await restoreRows({
      tracked_stories: [
        rawTracked('s1', { member_article_ids_json: '["old1","old2"]', unseen_count: 1, miss_count: 3, latest_article_id: 'old1' }),
      ],
    });

    await applyUpdates('s1', { newMemberIds: ['new1', 'new2'], latestArticleId: 'new1' });

    const row = await story('s1');
    expect(row.memberArticleIds).toEqual(['new1', 'new2', 'old1', 'old2']);
    expect(row.unseenCount).toBe(3);
    expect(row.missCount).toBe(0);
    expect(row.latestArticleId).toBe('new1');
    expect(row.lastUpdateAt!.getTime()).toBeGreaterThanOrEqual(T0);
  });

  it('keeps the latest article when none is passed, and ignores blank ids in the unseen math', async () => {
    const { id } = await trackStory({ articleId: 'a', title: 'T', originSurface: 'x' });

    await applyUpdates(id, { newMemberIds: ['', '  ', 'real'] });

    expect(await story(id)).toMatchObject({ memberArticleIds: ['real', 'a'], unseenCount: 1, latestArticleId: 'a' });
  });

  it('caps the member ids at MAX_MEMBER_IDS, newest first', async () => {
    // It must hold every member still on device, or an evicted id is counted as new again.
    expect(MAX_MEMBER_IDS).toBe(2000);
    const { id } = await trackStory({ articleId: 'seed', title: 'T', originSurface: 'x' });
    await applyUpdates(id, { newMemberIds: Array.from({ length: MAX_MEMBER_IDS - 1 }, (_, i) => `old${i}`) });
    expect((await memberIds(id))).toHaveLength(MAX_MEMBER_IDS);

    await applyUpdates(id, { newMemberIds: ['n1', 'n2', 'n3'] });

    const ids = await memberIds(id);
    expect(ids).toHaveLength(MAX_MEMBER_IDS);
    expect(ids.slice(0, 3)).toEqual(['n1', 'n2', 'n3']);
    // the seed was the oldest and fell off the tail
    expect(ids).not.toContain('seed');
  });

  it('merges new snapshots newest first, the incoming one winning on a repeated id', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x', initialSnapshot: snap('a1', 1_000, { title: 'Old A1' }) });

    await applyUpdates(id, {
      newMemberIds: ['a2', 'a1'],
      newSnapshots: [snap('a2', 3_000, { title: 'A2' }), snap('a1', 5_000, { title: 'Fresh A1' })],
    });

    expect((await story(id)).memberSnapshots).toEqual([
      snap('a1', 5_000, { title: 'Fresh A1' }),
      snap('a2', 3_000, { title: 'A2' }),
    ].map((s) => expect.objectContaining(s)));
  });

  it('caps the snapshots at MAX_MEMBER_SNAPSHOTS by pubDate and leaves them alone when none are passed', async () => {
    expect(MAX_MEMBER_SNAPSHOTS).toBe(2000);
    const { id } = await trackStory({ articleId: 'seed', title: 'T', originSurface: 'x', initialSnapshot: snap('seed', 1) });
    await applyUpdates(id, {
      newMemberIds: [],
      newSnapshots: Array.from({ length: MAX_MEMBER_SNAPSHOTS - 1 }, (_, i) => snap(`old${i}`, i + 2)),
    });
    expect((await story(id)).memberSnapshots).toHaveLength(MAX_MEMBER_SNAPSHOTS);

    await applyUpdates(id, { newMemberIds: ['n1'], newSnapshots: [snap('n1', 10_000)] });

    const shots = (await story(id)).memberSnapshots;
    expect(shots).toHaveLength(MAX_MEMBER_SNAPSHOTS);
    expect(shots[0].articleId).toBe('n1');
    // the oldest (the seed, pubDateMs 1) is the one dropped
    expect(shots.some((s) => s.articleId === 'seed')).toBe(false);

    await applyUpdates(id, { newMemberIds: ['n2'] });
    expect((await story(id)).memberSnapshots).toHaveLength(MAX_MEMBER_SNAPSHOTS);
    expect((await story(id)).memberSnapshots[0].articleId).toBe('n1');
  });

  describe('the watermark-gated unseen count', () => {
    it('counts only members published AFTER the watermark, and counts 0 or missing pubDates as old', async () => {
      await restoreRows({ tracked_stories: [rawTracked('s1', { seen_pub_watermark_ms: 1_000 })] });

      await applyUpdates('s1', {
        newMemberIds: ['newer1', 'newer2', 'newer3', 'backfilled', 'zero', 'undef'],
        newSnapshots: [
          snap('newer1', 2_000),
          snap('newer2', 3_000),
          snap('newer3', 4_000),
          snap('backfilled', 500),
          snap('zero', 0),
          { articleId: 'undef', title: 'U' } as never,
        ],
      });

      const row = await story('s1');
      expect(row.unseenCount).toBe(3);
      // every one still joins the timeline, newest first
      expect(row.memberSnapshots.map((s) => s.articleId).slice(0, 4)).toEqual(['newer3', 'newer2', 'newer1', 'backfilled']);
    });

    it('falls back to the legacy count with no snapshots, or with a null watermark', async () => {
      await restoreRows({
        tracked_stories: [rawTracked('gated', { seen_pub_watermark_ms: 1_000 }), rawTracked('ungated', { seen_pub_watermark_ms: null })],
      });

      await applyUpdates('gated', { newMemberIds: ['a2', 'a3'] });
      await applyUpdates('ungated', {
        newMemberIds: ['a2', 'a3'],
        newSnapshots: [snap('a2', 500), snap('a3', 9_000)],
      });

      expect((await story('gated')).unseenCount).toBe(2);
      expect((await story('ungated')).unseenCount).toBe(2);
    });
  });

  it('never throws on a missing story', async () => {
    await expect(applyUpdates('nope', { newMemberIds: ['a'] })).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith('[tracked-story] applyUpdates failed', expect.anything());
  });
});

describe('the small writers', () => {
  it('setLlmHeadline writes a trimmed headline and ignores a blank one', async () => {
    const { id } = await trackStory({ articleId: 'a', title: 'T', originSurface: 'x' });
    await setLlmHeadline(id, '  Headline here  ');
    expect((await story(id)).llmHeadline).toBe('Headline here');
    await setLlmHeadline(id, '   ');
    expect((await story(id)).llmHeadline).toBe('Headline here');
    await expect(setLlmHeadline('nope', 'x')).resolves.toBeUndefined();
  });

  it('bindTrackedTopic binds the id and a trimmed text, allows unbinding the id, and ignores a blank text', async () => {
    const { id } = await trackStory({ articleId: 'a', title: 'T', originSurface: 'x' });

    await bindTrackedTopic(id, 'top-9', '  Updates on the protest  ');
    expect(await story(id)).toMatchObject({ topicId: 'top-9', topicText: 'Updates on the protest' });
    await bindTrackedTopic(id, null, 'New text');
    expect(await story(id)).toMatchObject({ topicId: null, topicText: 'New text' });
    await bindTrackedTopic(id, 'top-2', '   ');
    expect(await story(id)).toMatchObject({ topicId: null, topicText: 'New text' });
    await expect(bindTrackedTopic('nope', 'top-1', 'text')).resolves.toBeUndefined();
  });

  it('stampChecked stamps the time of the reconcile and never throws on a missing story', async () => {
    useFakeClock(T0);
    const { id } = await trackStory({ articleId: 'a', title: 'T', originSurface: 'x' });
    expect((await story(id)).lastCheckedAt).toBeNull();

    await stampChecked(id);

    expect((await story(id)).lastCheckedAt!.getTime()).toBeGreaterThanOrEqual(T0);
    await expect(stampChecked('nope')).resolves.toBeUndefined();
  });

  it('backfillSnapshotSource fills blank fields only, writes nothing when there is nothing to fill, and never throws', async () => {
    const { id } = await trackStory({
      articleId: 'a1',
      title: 'T',
      originSurface: 'x',
      initialSnapshot: snap('a1', 9),
    });
    await applyUpdates(id, {
      newMemberIds: ['a2'],
      newSnapshots: [snap('a2', 5, { languageCode: 'de', countryCode: 'DEU' })],
    });

    await backfillSnapshotSource(
      id,
      new Map([
        ['a1', { languageCode: 'uk', countryCode: 'UKR', publicationName: 'Pub' }],
        ['a2', { languageCode: 'fr', countryCode: 'FRA' }],
      ]),
    );

    const shots = (await story(id)).memberSnapshots;
    expect(shots.find((s) => s.articleId === 'a1')).toMatchObject({ languageCode: 'uk', countryCode: 'UKR', publicationName: 'Pub' });
    expect(shots.find((s) => s.articleId === 'a2')).toMatchObject({ languageCode: 'de', countryCode: 'DEU' });

    const write = spyOn(database, 'write');
    await backfillSnapshotSource(id, new Map([['a2', { languageCode: 'fr' }]]));
    await backfillSnapshotSource('nope', new Map([['a1', { languageCode: 'uk' }]]));
    await backfillSnapshotSource(id, new Map());
    expect(write).not.toHaveBeenCalled();
  });
});

describe('removeMemberSnapshot', () => {
  async function storyWith(...ids: string[]) {
    const { id } = await trackStory({ articleId: ids[0], title: 'T', originSurface: 'x', initialSnapshot: snap(ids[0], 1_000) });
    await applyUpdates(id, {
      newMemberIds: ids.slice(1),
      newSnapshots: ids.slice(1).map((a, i) => snap(a, 2_000 + i * 1_000)),
      latestArticleId: ids[ids.length - 1],
    });
    return id;
  }

  it('drops only the matching snapshot, keeps the member id so the reconcile cannot re-add it, and leaves the badge alone', async () => {
    const id = await storyWith('a1', 'a2', 'a3');
    const before = await story(id);
    const { unseenCount, missCount, latestArticleId, seenPubWatermarkMs } = before;
    const lastUpdateAt = before.lastUpdateAt!.getTime();

    expect(await removeMemberSnapshot(id, 'a2')).toBe(true);

    const row = await story(id);
    expect(row.memberSnapshots.map((s) => s.articleId)).toEqual(['a3', 'a1']);
    expect(row.memberArticleIds).toEqual(before.memberArticleIds);
    expect(row.memberArticleIds).toContain('a2');
    expect([row.unseenCount, row.missCount, row.latestArticleId, row.seenPubWatermarkMs, row.lastUpdateAt!.getTime()]).toEqual([
      unseenCount,
      missCount,
      latestArticleId,
      seenPubWatermarkMs,
      lastUpdateAt,
    ]);
  });

  it('trims the article id before matching', async () => {
    const id = await storyWith('a1', 'a2');
    expect(await removeMemberSnapshot(id, '  a2  ')).toBe(true);
    expect(await snapshotIds(id)).toEqual(['a1']);
  });

  it('writes NOTHING, and succeeds, when the article is not a snapshot, the id is blank or the story is gone', async () => {
    const id = await storyWith('a1');
    const write = spyOn(database, 'write');

    expect(await removeMemberSnapshot(id, 'a9')).toBe(true);
    expect(await removeMemberSnapshot(id, '   ')).toBe(true);
    expect(await removeMemberSnapshot('nope', 'a1')).toBe(true);

    expect(write).not.toHaveBeenCalled();
    expect(await snapshotIds(id)).toEqual(['a1']);
  });

  it('tolerates a story with no snapshots at all', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    expect(await removeMemberSnapshot(id, 'a1')).toBe(true);
  });

  it('returns false, and the snapshot stays, when the write fails', async () => {
    const id = await storyWith('a1', 'a2');
    spyOn(await story(id), 'update').mockRejectedValueOnce(new Error('disk full'));

    expect(await removeMemberSnapshot(id, 'a2')).toBe(false);

    expect(await snapshotIds(id)).toEqual(['a2', 'a1']);
    expect(warn).toHaveBeenCalledWith('[tracked-story] removeMemberSnapshot failed', expect.anything());
  });

  it('returns false when the story cannot be read', async () => {
    const id = await storyWith('a1');
    failTableQuery('tracked_stories');
    expect(await removeMemberSnapshot(id, 'a1')).toBe(false);
  });
});

describe('untrackStory', () => {
  it('hard-deletes the row, and says true for a story that is already gone', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });

    expect(await untrackStory(id)).toBe(true);
    expect(await getTrackedStoryById(id)).toBeNull();
    expect(await untrackStory(id)).toBe(true);
    expect(await untrackStory('never-existed')).toBe(true);
  });

  it('returns false, never throws, and leaves the story when the delete fails', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    spyOn(await story(id), 'destroyPermanently').mockRejectedValueOnce(new Error('disk full'));

    await expect(untrackStory(id)).resolves.toBe(false);

    expect(await getTrackedStoryById(id)).not.toBeNull();
    expect(warn).toHaveBeenCalledWith('[tracked-story] untrackStory failed', expect.anything());
  });

  it('returns false when the story cannot be read', async () => {
    const { id } = await trackStory({ articleId: 'a1', title: 'T', originSurface: 'x' });
    failTableQuery('tracked_stories');
    await expect(untrackStory(id)).resolves.toBe(false);
  });
});

describe('deleteTrackedStoryById', () => {
  const topicOf = async (text: string) => (await getAllByNormalizedText(text))[0];

  it('retires the minted topic, deletes the story and releases the retention of its members', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId, 'gaza ceasefire');
    expect((await topicOf('gaza ceasefire')).status).toBe('active');
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });

    expect(await deleteTrackedStoryById(id)).toBe(true);

    expect(await getTrackedStoryById(id)).toBeNull();
    // retired, not destroyed: dedup and history survive
    expect((await topicOf('gaza ceasefire')).status).toBe('retired');
    expect(await savedRows()).toEqual([]);
  });

  it('releases only AFTER the story row is gone, since the release reads the snapshots', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId);
    const real = savedService.releaseTrackedStoryRetention;
    const stillMember: boolean[] = [];
    spyOn(savedService, 'releaseTrackedStoryRetention').mockImplementation(async (articleId: string) => {
      stillMember.push(await isTrackedStoryMember(articleId));
      return real(articleId);
    });

    await deleteTrackedStoryById(id);

    expect(stillMember).toEqual([false]);
  });

  it('reports false, keeps the story and releases nothing when the row delete fails', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId);
    spyOn(await story(id), 'destroyPermanently').mockRejectedValueOnce(new Error('disk full'));
    const release = spyOn(savedService, 'releaseTrackedStoryRetention');

    await expect(deleteTrackedStoryById(id)).resolves.toBe(false);

    expect(release).not.toHaveBeenCalled();
    expect(await getTrackedStoryById(id)).not.toBeNull();
    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
  });

  // Owner ruling (ux1 E6): a failed retire must not block the row delete.
  it('still deletes the row, and reports it to Sentry, when the topic retire throws', async () => {
    const id = await follow(freshId(), 'gaza ceasefire');
    spyOn(topicService, 'retire').mockRejectedValueOnce(new Error('retire failed'));

    await expect(deleteTrackedStoryById(id)).resolves.toBe(true);

    expect(await getTrackedStoryById(id)).toBeNull();
    expect(captureException).toHaveBeenCalledWith(
      expect.any(Error),
      expect.objectContaining({ tags: expect.objectContaining({ method: 'deleteTrackedStoryById.retire' }) }),
    );
  });

  it('keeps the retention of an article another followed story still holds', async () => {
    const s = await landSuggestion(freshId());
    const one = await follow(s.articleId, 'first take');
    await trackStory({ articleId: freshId(), title: 'Other', originSurface: 'x', initialSnapshot: snap(s.articleId, 1) });

    expect(await deleteTrackedStoryById(one)).toBe(true);

    expect(await originsById()).toEqual({ [s.articleId]: 'tracked_story' });
  });

  it('treats a blank id, or a story already gone, as nothing to delete', async () => {
    await expect(deleteTrackedStoryById('')).resolves.toBe(true);
    await expect(deleteTrackedStoryById('already-gone')).resolves.toBe(true);
  });
});

describe('disownStoryMember', () => {
  it('removes the snapshot, releases its retention and reports success', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId);

    expect(await disownStoryMember(id, s.articleId)).toBe(true);

    expect(await snapshotIds(id)).toEqual([]);
    // the id stays in the ledger: it is the record of the removal
    expect(await memberIds(id)).toEqual([s.articleId]);
    expect(await savedRows()).toEqual([]);
  });

  it('releases only after the snapshot is gone', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId);
    const real = savedService.releaseTrackedStoryRetention;
    const stillMember: boolean[] = [];
    spyOn(savedService, 'releaseTrackedStoryRetention').mockImplementation(async (articleId: string) => {
      stillMember.push(await isTrackedStoryMember(articleId));
      return real(articleId);
    });

    await disownStoryMember(id, s.articleId);

    expect(stillMember).toEqual([false]);
  });

  it('reports false and skips the release when the removal failed', async () => {
    const s = await landSuggestion(freshId());
    const id = await follow(s.articleId);
    spyOn(await story(id), 'update').mockRejectedValueOnce(new Error('disk full'));
    const release = spyOn(savedService, 'releaseTrackedStoryRetention');

    expect(await disownStoryMember(id, s.articleId)).toBe(false);

    expect(release).not.toHaveBeenCalled();
    expect(await snapshotIds(id)).toEqual([s.articleId]);
  });
});

describe('the topic reconcile and migration work lists', () => {
  it('getActiveForTopicReconcile returns lean rows for active stories that carry a topic id', async () => {
    await restoreRows({ tracked_stories: [rawTracked('ended-1', { status: 'ended', topic_id: 'top-3' })] });
    const article = freshId();
    const linked = await follow(article);
    await trackStory({ articleId: freshId(), title: 'Legacy', originSurface: 'x' });

    expect(await getActiveForTopicReconcile()).toEqual([
      { id: linked, topicId: expect.any(String), memberArticleIds: [article] },
    ]);
  });

  it('getLegacyTrackedForMigration lists active topic-less stories with de-duplicated, trimmed titles', async () => {
    const a = (await trackStory({ articleId: 's1', title: 'Protest hits capital', originSurface: 'x', initialSnapshot: snap('s1', 2, { title: 'Protest hits capital' }) })).id;
    await setLlmHeadline(a, '  Protest updates  ');
    await applyUpdates(a, {
      newMemberIds: ['s2', 's3'],
      newSnapshots: [snap('s2', 1, { title: 'Thousands march downtown' }), snap('s3', 3, { title: '   ' })],
    });
    const b = (await trackStory({ articleId: 'b1', title: '  Fallback only  ', originSurface: 'x' })).id;
    // no usable title at all: dropped
    await trackStory({ articleId: '', title: '', originSurface: 'x' });
    // already topic-linked: excluded
    await follow(freshId(), 'linked story');

    expect(await getLegacyTrackedForMigration()).toEqual([
      { id: a, titles: ['Protest updates', 'Protest hits capital', 'Thousands march downtown'] },
      { id: b, titles: ['Fallback only'] },
    ]);
  });

  it('getLegacyTrackedForMigration leaves out an ended story', async () => {
    await restoreRows({ tracked_stories: [rawTracked('ended-1', { status: 'ended', fallback_title: 'Ended headline' })] });
    expect(await getLegacyTrackedForMigration()).toEqual([]);
  });
});

describe('backfillTrackedStoryRetention', () => {
  /** A story followed before retention existed: members with snapshots and no retention rows. */
  async function legacyFollowed(...articleIds: string[]) {
    const { id } = await trackStory({ articleId: articleIds[0], title: 'T', originSurface: 'x', initialSnapshot: snap(articleIds[0], 3_000) });
    await applyUpdates(id, {
      newMemberIds: articleIds.slice(1),
      newSnapshots: articleIds.slice(1).map((a, i) => snap(a, 2_000 - i)),
    });
    return id;
  }

  it('retains every member still inside its 48h window, skips the rest, and runs once', async () => {
    const [a, b] = [await landSuggestion(freshId()), await landSuggestion(freshId())];
    const gone = freshId(); // past the prune: nothing left to retain
    await legacyFollowed(a.articleId, b.articleId, gone);
    expect(await savedRows()).toEqual([]);

    expect(await backfillTrackedStoryRetention()).toBe(2);

    expect(await originsById()).toEqual({ [a.articleId]: 'tracked_story', [b.articleId]: 'tracked_story' });
    expect(await getSetting('tracked_story_retention_backfilled')).toBeTruthy();

    // one-shot: a member that appears later is not read again
    const late = await landSuggestion(freshId());
    await applyUpdates((await findActiveTrackedId({ articleId: a.articleId }))!, { newMemberIds: [late.articleId], newSnapshots: [snap(late.articleId, 1_500)] });
    expect(await backfillTrackedStoryRetention()).toBe(0);
    expect(await savedRow(late.articleId)).toBeUndefined();
  });

  it('returns 0, stamps the flag and retains nothing when no story is followed', async () => {
    expect(await backfillTrackedStoryRetention()).toBe(0);
    expect(await getSetting('tracked_story_retention_backfilled')).toBeTruthy();
  });

  it('never throws, and a failed pass leaves the flag unset so the next sync retries', async () => {
    const a = await landSuggestion(freshId());
    await legacyFollowed(a.articleId);
    failTableQuery('settings');

    await expect(backfillTrackedStoryRetention()).resolves.toBe(0);

    restoreFaults();
    expect(await getSetting('tracked_story_retention_backfilled')).toBeNull();
    expect(warn).toHaveBeenCalledWith('[track-actions] retention backfill failed', expect.anything());
    expect(await backfillTrackedStoryRetention()).toBe(1);
  });

  // DATA-U9-3. Same root as DATA-U9-1: listTrackedMemberArticleIds returns an EMPTY set when
  // tracked_stories cannot be read, so the pass looks clean, stamps the one-shot flag and the
  // backfill is skipped for good ("a throw leaves the flag unset" never gets to apply).
  async function legacyStoryWithUnreadableStories() {
    const a = await landSuggestion(freshId());
    await legacyFollowed(a.articleId);
    failTableQuery('tracked_stories');
    return a;
  }

  test('DATA-U9-3: an unreadable tracked_stories table leaves the one-shot flag unset', async () => {
    await legacyStoryWithUnreadableStories();

    await backfillTrackedStoryRetention();

    restoreFaults();
    expect(await getSetting('tracked_story_retention_backfilled')).toBeNull();
  });
});
