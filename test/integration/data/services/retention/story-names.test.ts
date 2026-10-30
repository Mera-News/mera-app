// A followed story's must-match names come from a background `story_names` inference job: the
// follow, a re-follow of a story with no names, and the one-time backfill enqueue it, and the
// post-follow feed sync waits for it (or 10 s). In-memory DB, real topic and tracked-story services;
// the scheduler is spied, never run.
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

import { Q } from '@nozbe/watermelondb';

import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import database from '@/lib/database';
import type InferenceJob from '@/lib/database/models/InferenceJob';
import { setSetting } from '@/lib/database/services/setting-service';
import { getAllByNormalizedText, retire, setTrackedMustMatch } from '@/lib/database/services/topic-service';
import { findActiveTrackedId, getTrackedStoryById } from '@/lib/database/services/tracked-story-service';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { handleStoryNamesJob } from '@/lib/inference/handlers/story-names-handler';
import { backfillStoryNames, trackStoryWithProposal } from '@/lib/tracking/track-actions';

import { freshId, resetRetentionMemory, restoreFaults, waitFor } from './support';

beforeEach(resetRetentionMemory);
afterEach(async () => {
  restoreFaults();
  jest.useRealTimers();
  jest.restoreAllMocks();
  const jobs = await database.get<InferenceJob>('inference_jobs').query().fetch();
  await database.write(() => database.batch(jobs.map((j) => j.prepareDestroyPermanently())));
});

const subject = (articleId: string): FeedbackSubject =>
  ({ articleId, title: `Seed ${articleId}`, surface: 'for_you' }) as FeedbackSubject;

const nameJobs = async () =>
  (await database.get<InferenceJob>('inference_jobs').query(Q.where('job_type', 'story_names')).fetch()).map(
    (j) => ({ id: j.id, status: j.status, payload: j.payload }),
  );

const follow = (a: string, searchText: string, syncFeed = false) =>
  trackStoryWithProposal(subject(a), { label: `Label ${searchText}`, searchText }, { syncFeed });

const topicOf = async (searchText: string) => (await getAllByNormalizedText(searchText))[0];

describe('enqueueing story_names', () => {
  it('a follow enqueues one job with the topic, the label and the search text', async () => {
    await follow(freshId(), 'ceasefire talks');
    const topic = await topicOf('ceasefire talks');
    expect(await nameJobs()).toEqual([
      expect.objectContaining({
        status: 'pending',
        payload: expect.objectContaining({ topicId: topic.id, label: 'Label ceasefire talks', search: 'ceasefire talks' }),
      }),
    ]);
  });

  it('a re-follow of a story with no names enqueues again once the first job is gone', async () => {
    const a = freshId();
    await follow(a, 'ceasefire talks');
    const [first] = await nameJobs();
    const job = await database.get<InferenceJob>('inference_jobs').find(first.id);
    await database.write(() => job.destroyPermanently());

    expect(await follow(a, 'ceasefire talks')).toBe('already');
    expect(await nameJobs()).toHaveLength(1);
  });

  it('a re-follow while a job is still pending does not enqueue a second', async () => {
    const a = freshId();
    await follow(a, 'ceasefire talks');
    await follow(a, 'ceasefire talks');
    expect(await nameJobs()).toHaveLength(1);
  });

  it('a re-follow of a story that already has names enqueues nothing', async () => {
    const a = freshId();
    await follow(a, 'ceasefire talks');
    await setTrackedMustMatch((await topicOf('ceasefire talks')).id, ['Hamas']);
    const [first] = await nameJobs();
    const job = await database.get<InferenceJob>('inference_jobs').find(first.id);
    await database.write(() => job.destroyPermanently());

    await follow(a, 'ceasefire talks');
    expect(await nameJobs()).toHaveLength(0);
  });
});

describe('the real handler writes the names onto the followed topic', () => {
  it('runs the job payload from a follow through to Topic.mustMatch', async () => {
    jest
      .spyOn(require('@/lib/llm/completeLocal'), 'completeLocal')
      .mockResolvedValue('{"mustMatch": ["OceanGate", "Titan", "x"]}');
    await follow(freshId(), 'titan sub inquiry');
    const [job] = await nameJobs();

    const result = await handleStoryNamesJob({ ...(job.payload as { topicId: string; label: string; search: string }), useCloud: false });

    expect(result).toEqual({ ok: true, names: 2 });
    expect((await topicOf('titan sub inquiry')).mustMatch).toEqual(['OceanGate', 'Titan']);
  });
});

describe('the post-follow sync waits for the names', () => {
  const spyTrigger = () => jest.spyOn(AppScheduler, 'trigger').mockResolvedValue('started' as never);

  it('fires only once the names job settles', async () => {
    const trigger = spyTrigger();
    await follow(freshId(), 'ceasefire talks', true);

    // pending: no sync yet
    expect(await waitFor(() => trigger.mock.calls.length > 0, 150)).toBe(false);

    const [pending] = await nameJobs();
    const job = await database.get<InferenceJob>('inference_jobs').find(pending.id);
    await database.write(() => job.update((j) => { j.status = 'done'; }));

    expect(await waitFor(() => trigger.mock.calls.length > 0, 1000)).toBe(true);
    expect(trigger).toHaveBeenCalledWith('feed-sync', undefined, { bypassDebounce: true });
  });

  it('fires after 10 s when the job hangs', async () => {
    const trigger = spyTrigger();
    jest.useFakeTimers({ doNotFake: ['nextTick', 'setImmediate', 'queueMicrotask'] });
    await follow(freshId(), 'ceasefire talks', true);

    await jest.advanceTimersByTimeAsync(9_900);
    expect(trigger).not.toHaveBeenCalled();
    await jest.advanceTimersByTimeAsync(200);
    expect(trigger).toHaveBeenCalledTimes(1);
  });
});

describe('backfillStoryNames: once per device', () => {
  it('enqueues one job per live tracked topic with no names, using the story label, and never twice', async () => {
    const [a, b, c, d] = [freshId(), freshId(), freshId(), freshId()];
    await follow(a, 'needs names');
    await follow(b, 'has names');
    await follow(c, 'retired topic');
    await follow(d, 'second needs names');
    await setTrackedMustMatch((await topicOf('has names')).id, ['Hamas']);
    await retire((await topicOf('retired topic')).id);
    // the follow's own jobs are not what this asserts
    const jobs = await database.get<InferenceJob>('inference_jobs').query().fetch();
    await database.write(() => database.batch(jobs.map((j) => j.prepareDestroyPermanently())));

    expect(await backfillStoryNames()).toBe(2);
    expect(await backfillStoryNames()).toBe(0);

    const story = await getTrackedStoryById((await findActiveTrackedId({ articleId: a }))!);
    const payloads = (await nameJobs()).map((j) => j.payload);
    expect(payloads).toHaveLength(2);
    expect(payloads).toContainEqual(
      expect.objectContaining({ topicId: (await topicOf('needs names')).id, label: story!.llmHeadline, search: 'needs names' }),
    );
    expect(payloads.map((p) => p.search)).toContain('second needs names');
  });

  it('does nothing once the device flag is set', async () => {
    await follow(freshId(), 'needs names');
    const jobs = await database.get<InferenceJob>('inference_jobs').query().fetch();
    await database.write(() => database.batch(jobs.map((j) => j.prepareDestroyPermanently())));
    await setSetting('story_names_backfilled', String(Date.now()));

    expect(await backfillStoryNames()).toBe(0);
    expect(await nameJobs()).toHaveLength(0);
  });
});
