// migrateLegacyTrackedStories: the one-shot upgrade of a stable-cluster follow (a tracked story with no
// topic) to a topic-linked one. Cloud mode runs the migrate handler inline over the gateway mock, one
// E2EE completion per story; on-device mode enqueues one deduped `tracked_story_migrate` job per story.
// The legacy row is written by `trackStory` without a topic, which is what a pre-redesign follow was.
// Real topic, tracked-story, inference-job and setting services on the in-memory DB; the queue's own
// reset comes from the chat inference kit, and the clock is the strict one so the upper-bound
// assertions on fake time are exact.
//
// Replaces the migrateLegacyTrackedStories block of lib/tracking/__tests__/track-actions.test.ts (8 `it`).
//
// Deviation from the brief: a failed getLegacyTrackedForMigration read does NOT reject. The service
// catches it and returns [], so migrateLegacyTrackedStories resolves 0 and the `.catch` at
// feed-sync-steps.ts:1093 is not reachable through that fault (R30 candidate). The test below pins
// what happens.
import { inferenceQueue } from '@/lib/inference/InferenceQueue';
import * as jobService from '@/lib/database/services/inference-job-service';
import * as topicService from '@/lib/database/services/topic-service';
import { getAllByNormalizedText } from '@/lib/database/services/topic-service';
import {
  applyUpdates,
  getLegacyTrackedForMigration,
  getTrackedStoryById,
  trackStory,
  type TrackedStoryMemberSnapshot,
} from '@/lib/database/services/tracked-story-service';
import { migrateLegacyTrackedStories, trackStoryWithProposal } from '@/lib/tracking/track-actions';
import { gatewayCalls, mockGateway, server } from '@/test/helpers';
import { cleanup, driveDone, jobRows, leaveRunning, prepare, setMode } from '@/test/integration/chat/inference/kit';
import { failTableQuery, restoreFaults, spyOn } from './support';

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

import logger from '@/lib/logger';

beforeEach(prepare);
afterEach(async () => {
  restoreFaults();
  await cleanup();
});

const warn = logger.warn as jest.Mock;

const ASSAM = '{"label":"Assam floods","search":"assam floods displacement"}';
const QUAKE = '{"label":"Quake recovery","search":"nepal quake recovery"}';

const snap = (articleId: string, title: string, pubDateMs: number): TrackedStoryMemberSnapshot => ({ articleId, title, pubDateMs });

/** A pre-redesign follow: a cluster-keyed story with member titles and no topic. */
async function legacyStory(articleId: string, title: string, ...moreTitles: string[]) {
  const { id } = await trackStory({ stableClusterId: `clu-${articleId}`, articleId, title, originSurface: 'for_you' });
  if (moreTitles.length > 0) {
    await applyUpdates(id, {
      newMemberIds: moreTitles.map((_, i) => `${articleId}-m${i}`),
      newSnapshots: moreTitles.map((t, i) => snap(`${articleId}-m${i}`, t, 1_000 + i)),
    });
  }
  return id;
}

/** Answers each migrate call by the story it is about; the user prompt lists the titles. */
const scopeBy = (answers: Record<string, string>) =>
  server.use(
    ...mockGateway((call) => {
      const user = call.messages.find((m) => m.role === 'user')?.content ?? '';
      const key = Object.keys(answers).find((k) => user.includes(k));
      return key ? answers[key] : { status: 400, body: { error: 'no answer scripted' } };
    }),
  );

const topicOf = async (id: string) => (await getTrackedStoryById(id))!;
const legacyIds = async () => (await getLegacyTrackedForMigration()).map((r) => r.id);

describe('cloud processing mode', () => {
  it('asks the gateway once per legacy story, mints a tracked topic from the search, binds it and heads the story with the label', async () => {
    const id = await legacyStory('a1', 'Floods hit Assam', 'Assam floods displace thousands');
    scopeBy({ Assam: ASSAM });

    const count = await driveDone(migrateLegacyTrackedStories());

    expect(count).toBe(1);
    const calls = gatewayCalls('chat');
    expect(calls).toHaveLength(1);
    const prompt = calls[0].messages.find((m) => m.role === 'user')!.content;
    expect(prompt).toContain('Titles for this story:');
    expect(prompt).toContain('Floods hit Assam');
    expect(prompt).toContain('Assam floods displace thousands');
    const [topic] = await getAllByNormalizedText('assam floods displacement');
    expect(topic).toMatchObject({ status: 'active', provenance: 'tracked', highPriority: true, weight: 0.85 });
    expect(await topicOf(id)).toMatchObject({
      topicId: topic.id,
      topicText: 'assam floods displacement',
      llmHeadline: 'Assam floods',
      status: 'active',
    });
    expect(await legacyIds()).toEqual([]);
  });

  it('is a cheap no-op once nothing legacy remains, and never touches a topic-linked story', async () => {
    await legacyStory('a1', 'Floods hit Assam');
    await trackStoryWithProposal(
      { origin: 'suggestion', surface: 'for_you', articleId: 'linked-1', title: 'Linked', pubDate: null, publicationName: null } as never,
      { label: 'Linked', searchText: 'linked story' },
    );
    scopeBy({ Assam: ASSAM });
    expect(await driveDone(migrateLegacyTrackedStories())).toBe(1);
    expect(gatewayCalls('chat')).toHaveLength(1);

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(0);

    expect(gatewayCalls('chat')).toHaveLength(1);
  });

  it('does nothing, and asks nobody, when there is no legacy story', async () => {
    expect(await driveDone(migrateLegacyTrackedStories())).toBe(0);
    expect(gatewayCalls()).toHaveLength(0);
    expect(await jobRows()).toEqual([]);
  });

  it('migrates every story with its own answer and counts only the ones the model answered usably', async () => {
    const assam = await legacyStory('a1', 'Floods hit Assam');
    const quake = await legacyStory('q1', 'Quake rocks Nepal');
    const garbled = await legacyStory('g1', 'Garbled story');
    scopeBy({ Assam: ASSAM, Nepal: QUAKE, Garbled: 'I am sorry, I cannot do that' });

    const count = await driveDone(migrateLegacyTrackedStories());

    expect(count).toBe(2);
    expect((await topicOf(assam)).llmHeadline).toBe('Assam floods');
    expect((await topicOf(quake)).llmHeadline).toBe('Quake recovery');
    // the unusable answer leaves that story legacy: no topic, no headline
    expect(await topicOf(garbled)).toMatchObject({ topicId: null, topicText: null, llmHeadline: null });
    expect(await legacyIds()).toEqual([garbled]);
  });

  it('leaves the story legacy when the gateway refuses, and the next run retries it', async () => {
    const id = await legacyStory('a1', 'Floods hit Assam');
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'nope' } })));

    await expect(driveDone(migrateLegacyTrackedStories())).resolves.toBe(0);

    expect(await topicOf(id)).toMatchObject({ topicId: null, topicText: null, llmHeadline: null });
    expect(await getAllByNormalizedText('assam floods displacement')).toEqual([]);
    expect(await legacyIds()).toEqual([id]);

    scopeBy({ Assam: ASSAM });
    await expect(driveDone(migrateLegacyTrackedStories())).resolves.toBe(1);
    expect(await legacyIds()).toEqual([]);
    expect((await topicOf(id)).llmHeadline).toBe('Assam floods');
  });

  it('carries on with the next story when one story throws, and never throws itself', async () => {
    const first = await legacyStory('a1', 'Floods hit Assam');
    const second = await legacyStory('q1', 'Quake rocks Nepal');
    scopeBy({ Assam: ASSAM, Nepal: QUAKE });
    spyOn(topicService, 'createTopics').mockRejectedValueOnce(new Error('mint failed'));

    await expect(driveDone(migrateLegacyTrackedStories())).resolves.toBe(1);

    expect(warn).toHaveBeenCalledWith(
      '[track-actions] legacy tracked-story migrate failed',
      expect.objectContaining({ id: first }),
    );
    expect(await legacyIds()).toEqual([first]);
    expect((await topicOf(second)).llmHeadline).toBe('Quake recovery');
  });

  it('two stories with the same scope share the one topic instead of minting a twin', async () => {
    const one = await legacyStory('a1', 'Floods hit Assam');
    const two = await legacyStory('a2', 'Assam floods continue');
    scopeBy({ Assam: ASSAM });

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(2);

    const topics = await getAllByNormalizedText('assam floods displacement');
    expect(topics).toHaveLength(1);
    expect((await topicOf(one)).topicId).toBe(topics[0].id);
    expect((await topicOf(two)).topicId).toBe(topics[0].id);
  });
});

describe('on-device processing mode', () => {
  beforeEach(() => setMode('on-device'));

  it('enqueues one deduped job per legacy story, notifies the queue once and asks the gateway nothing', async () => {
    const one = await legacyStory('a1', 'Floods hit Assam', 'Assam floods displace thousands');
    const two = await legacyStory('q1', 'Quake rocks Nepal');
    const notify = spyOn(inferenceQueue, 'notify');

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(2);

    // two jobs created in the same millisecond have no defined order, so match them by story
    const jobs = await jobRows('tracked_story_migrate');
    const jobFor = (id: string) => jobs.find((j) => j.payload.trackedStoryId === id)!;
    expect(jobs).toHaveLength(2);
    expect(jobFor(one)).toMatchObject({
      status: 'pending',
      priority: 20,
      payload: { trackedStoryId: one, titles: ['Floods hit Assam', 'Assam floods displace thousands'] },
    });
    expect(jobFor(two)).toMatchObject({ status: 'pending', priority: 20, payload: { trackedStoryId: two, titles: ['Quake rocks Nepal'] } });
    // exactly the payload the handler reads: no cloud flag, because the queue runs these locally
    expect(Object.keys(jobFor(one).payload).sort()).toEqual(['titles', 'trackedStoryId']);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(gatewayCalls()).toHaveLength(0);
    // nothing is migrated yet: the queue does that
    expect(await legacyIds()).toEqual([one, two]);
  });

  it('enqueues nothing more, and does not notify, when every story already has a job', async () => {
    const one = await legacyStory('a1', 'Floods hit Assam');
    await legacyStory('q1', 'Quake rocks Nepal');
    await driveDone(migrateLegacyTrackedStories());
    // a RUNNING job counts as pending too
    const first = (await jobRows('tracked_story_migrate')).find((j) => j.payload.trackedStoryId === one)!;
    await leaveRunning(first.id);
    const notify = spyOn(inferenceQueue, 'notify');

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(0);

    expect(await jobRows('tracked_story_migrate')).toHaveLength(2);
    expect(notify).not.toHaveBeenCalled();
    expect((await jobRows('tracked_story_migrate')).find((j) => j.id === first.id)!.status).toBe('running');
  });

  it('enqueues only for the story that has no job yet', async () => {
    await legacyStory('a1', 'Floods hit Assam');
    await driveDone(migrateLegacyTrackedStories());
    const late = await legacyStory('q1', 'Quake rocks Nepal');

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(1);

    const jobs = await jobRows('tracked_story_migrate');
    expect(jobs).toHaveLength(2);
    expect(jobs.filter((j) => j.payload.trackedStoryId === late)).toHaveLength(1);
  });

  it('carries on past a story whose job cannot be enqueued', async () => {
    const first = await legacyStory('a1', 'Floods hit Assam');
    const second = await legacyStory('q1', 'Quake rocks Nepal');
    spyOn(jobService, 'enqueueJob').mockRejectedValueOnce(new Error('disk full'));
    const notify = spyOn(inferenceQueue, 'notify');

    expect(await driveDone(migrateLegacyTrackedStories())).toBe(1);

    expect((await jobRows('tracked_story_migrate')).map((j) => j.payload.trackedStoryId)).toEqual([second]);
    expect(warn).toHaveBeenCalledWith(
      '[track-actions] legacy tracked-story migrate failed',
      expect.objectContaining({ id: first }),
    );
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no legacy story', async () => {
    const notify = spyOn(inferenceQueue, 'notify');
    expect(await driveDone(migrateLegacyTrackedStories())).toBe(0);
    expect(await jobRows()).toEqual([]);
    expect(notify).not.toHaveBeenCalled();
  });
});

describe('an unreadable tracked_stories table', () => {
  it('reads as "nothing to migrate": the call resolves 0, enqueues nothing and does not reject', async () => {
    await legacyStory('a1', 'Floods hit Assam');
    failTableQuery('tracked_stories');

    await expect(driveDone(migrateLegacyTrackedStories())).resolves.toBe(0);

    expect(warn).toHaveBeenCalledWith('[tracked-story] getLegacyTrackedForMigration failed', expect.anything());
    expect(gatewayCalls()).toHaveLength(0);
    expect(await jobRows()).toEqual([]);
  });
});
