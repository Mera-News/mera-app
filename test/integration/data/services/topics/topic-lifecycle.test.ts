// The empty-fact lifecycle: stuck facts move on, background ladders run on their slots, and a fact
// goes only when every guard holds, in one write with its inbox row and audit entry.
import { addFact, getFacts, getTopicsStatus, isRemovableEmptyFact, patchMetadata, removeEmptyFact, updateFact } from '@/lib/database/services/fact-service';
import { enqueueJob } from '@/lib/database/services/inference-job-service';
import { getByTypes } from '@/lib/database/services/notification-service';
import { countEmptyFactRemovals, getRecent } from '@/lib/database/services/persona-change-log-service';
import { recordDecline } from '@/lib/database/services/topic-decline-service';
import { failTopicGeneration, restartTopicClocks, settleEmptyTopicGeneration, LEGACY_EMPTY_ERROR } from '@/lib/database/services/topic-generation-status-service';
import { holdFactOnScreen, sweepTopicLifecycle } from '@/lib/database/services/topic-planning-service';
import { createTopics, getByFact } from '@/lib/database/services/topic-service';
import { useNetworkStore } from '@/lib/stores/network-store';
import { useSchedulerStore } from '@/lib/scheduler/scheduler-store';
import { signInFixtureAccount, useFakeClock } from '@/test/helpers';

import { cleanupTopics, failBatchWhere, jobRows, resetCloudMemory, resetTopicsMemory, setMode } from './support';

const T0 = Date.parse('2026-11-05T10:00:00Z');
const HOUR = 60 * 60 * 1000;
const STATEMENT = '30 year old male';

beforeEach(async () => {
  resetTopicsMemory();
  resetCloudMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  await setMode('cloud');
  useNetworkStore.setState({ isConnected: true });
});
afterEach(cleanupTopics);

const factNow = async (id: string) => (await getFacts()).find((f) => f.id === id);
const meta = async (id: string) => (await factNow(id))?.metadata as unknown as Record<string, unknown>;
const empty = async (statement = STATEMENT, attribute?: string) => {
  const fact = await addFact(statement, undefined, attribute ? { attribute } : undefined, { topicsStatus: 'pending' });
  await settleEmptyTopicGeneration(fact.id, statement);
  return fact;
};
/** As if both background ladders came back empty. */
const ripe = async (statement = STATEMENT, attribute?: string) => {
  const fact = await empty(statement, attribute);
  await patchMetadata(fact.id, { topics_empty_runs: 2, topics_empty_since: T0 - 25 * HOUR, topics_retry_at: T0 - HOUR });
  return fact;
};
const removing = () => sweepTopicLifecycle({ now: T0, autoDelete: true });

describe('stuck facts', () => {
  it('move onto the lifecycle at the next open, the clock starting then, with no red state left', async () => {
    const fact = await addFact(STATEMENT, undefined, undefined, { topicsStatus: 'pending' });
    await failTopicGeneration(fact.id, LEGACY_EMPTY_ERROR);

    await sweepTopicLifecycle({ now: T0 });

    expect(await getTopicsStatus(fact.id)).toBe('done');
    expect(await meta(fact.id)).toMatchObject({ topics_empty_since: T0, topics_empty_runs: 0 });
    expect(await meta(fact.id)).not.toHaveProperty('topicGenError');
  });

  it('leave a real error on Retry', async () => {
    const fact = await addFact(STATEMENT, undefined, undefined, { topicsStatus: 'pending' });
    await failTopicGeneration(fact.id, 'E2EE completion failed: 500');

    await sweepTopicLifecycle({ now: T0 });

    expect(await getTopicsStatus(fact.id)).toBe('error');
  });
});

describe('background ladders', () => {
  it('wait out the first gap, then run once, and never in the same sweep twice', async () => {
    const fact = await empty();

    expect((await sweepTopicLifecycle({ now: T0 + HOUR - 1 })).ladders).toBe(0);
    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(1);
    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(0);

    const [job] = await jobRows('topic_gen');
    expect(job.payload).toMatchObject({ factId: fact.id, background: true, useCloud: true });
    expect(await getTopicsStatus(fact.id)).toBe('done');
  });

  it('after the first background ladder the next waits 7 hours', async () => {
    const fact = await empty();
    await settleEmptyTopicGeneration(fact.id, STATEMENT, { background: true });

    expect(await meta(fact.id)).toMatchObject({ topics_empty_runs: 1, topics_retry_at: T0 + 7 * HOUR });
    expect((await sweepTopicLifecycle({ now: T0 + 7 * HOUR - 1 })).ladders).toBe(0);
    expect((await sweepTopicLifecycle({ now: T0 + 7 * HOUR })).ladders).toBe(1);
  });

  it('run at most 3 per sweep and stop after two completed', async () => {
    const facts = [await empty('a fact'), await empty('b fact'), await empty('c fact'), await empty('d fact')];
    await patchMetadata(facts[3].id, { topics_empty_runs: 2 });

    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(3);
  });

  it('wait while offline in cloud mode, spending nothing', async () => {
    await empty();
    useNetworkStore.setState({ isConnected: false });

    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(0);
  });

  it('skip a stopped fact, and the whole sweep waits for a running feed sync', async () => {
    const stopped = await empty('stopped fact');
    await patchMetadata(stopped.id, { news_stopped: true });
    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(0);

    await empty();
    useSchedulerStore.setState({ taskCurrentStatus: { 'feed-sync': 'running' } });
    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(0);
    useSchedulerStore.setState({ taskCurrentStatus: {} });
  });

  it('stop after 3 unreadable ladders until the person taps', async () => {
    const fact = await empty();
    await patchMetadata(fact.id, { topics_unreadable_runs: 3 });
    expect((await sweepTopicLifecycle({ now: T0 + HOUR })).ladders).toBe(0);

    await settleEmptyTopicGeneration(fact.id, STATEMENT);
    expect((await sweepTopicLifecycle({ now: T0 + 2 * HOUR })).ladders).toBe(1);
  });

  it('reset a clock from the future to now', async () => {
    const fact = await empty();
    await patchMetadata(fact.id, { topics_empty_since: T0 + 90 * 24 * HOUR, topics_retry_at: T0 + 90 * 24 * HOUR });

    expect((await sweepTopicLifecycle({ now: T0 })).ladders).toBe(0);

    expect(await meta(fact.id)).toMatchObject({ topics_empty_since: T0, topics_retry_at: T0 });
  });

  it('a restore restarts every running clock', async () => {
    const fact = await ripe();

    await restartTopicClocks();

    expect(await meta(fact.id)).toMatchObject({ topics_empty_since: T0, topics_empty_runs: 0, topics_retry_at: T0 + HOUR });
  });
});

describe('removal', () => {
  it('deletes the fact with its inbox row and audit entry', async () => {
    const fact = await ripe();

    expect(await removing()).toEqual({ ladders: 0, removed: 1 });

    expect(await factNow(fact.id)).toBeUndefined();
    const [row] = await getByTypes(['fact_removed']);
    expect(row.body).toBe('notifications.factRemovedBody');
    expect(JSON.parse(row.contextJson!)).toEqual({ statement: STATEMENT });
    expect(JSON.parse(row.actionsJson!)[0].id).toBe('add-fact-back');
    expect((await getRecent(1))[0].summary).toBe('empty_fact');
    expect(await countEmptyFactRemovals(T0 - HOUR)).toBe(1);
  });

  it('is all or nothing: a failed write leaves the fact, no row and no audit entry', async () => {
    const fact = await ripe();
    failBatchWhere((op) => op.table === 'notifications');

    await expect(removeEmptyFact(fact.id, STATEMENT, T0)).rejects.toThrow('batch failed (injected)');

    expect(await factNow(fact.id)).toBeDefined();
    expect(await getRecent(1)).toEqual([]);
  });

  it('is off until the flag turns it on', async () => {
    const fact = await ripe();

    expect((await sweepTopicLifecycle({ now: T0 })).removed).toBe(0);
    expect(await factNow(fact.id)).toBeDefined();
  });

  it('never runs in a sweep that ran a ladder', async () => {
    const fact = await ripe();
    await empty('due for a ladder');
    await patchMetadata((await getFacts()).find((f) => f.statement === 'due for a ladder')!.id, { topics_retry_at: T0 });

    expect(await removing()).toEqual({ ladders: 1, removed: 0 });
    expect(await factNow(fact.id)).toBeDefined();
  });

  it('takes one fact per sweep and at most 3 a day', async () => {
    for (const s of ['a fact', 'b fact', 'c fact', 'd fact']) await ripe(s);

    expect((await removing()).removed).toBe(1);
    expect((await removing()).removed).toBe(1);
    expect((await removing()).removed).toBe(1);
    expect((await removing()).removed).toBe(0);
    expect(await getFacts()).toHaveLength(1);
  });

  it.each([
    ['fewer than two background ladders', { topics_empty_runs: 1 }],
    ['under 24 hours', { topics_empty_since: T0 - 23 * HOUR }],
    ['a keep flag', { topics_keep: true }],
    ['stopped news', { news_stopped: true }],
    ['places the person chose', { places_by: 'user' }],
    ['a metadata-only topic', { topics: ['old topic'] }],
  ])('leaves a fact with %s', async (_name, patch) => {
    const fact = await ripe();
    await patchMetadata(fact.id, patch);

    expect((await removing()).removed).toBe(0);
    expect(await factNow(fact.id)).toBeDefined();
  });

  it('leaves a fact with a topic row of any status, a decline from it, or a residence attribute', async () => {
    const withRow = await ripe('has a row');
    await createTopics([{ factId: withRow.id, text: 'Some topic', weight: 0, status: 'suppressed' }]);
    const declined = await ripe('was declined');
    await recordDecline('Some text', declined.id);
    await ripe('Near the sea', 'location: neighborhood/area, city, and country (preserve specifics)');

    expect((await removing()).removed).toBe(0);
    expect(await getFacts()).toHaveLength(3);
    expect(await getByFact(withRow.id)).toHaveLength(1);
  });

  it('leaves a fact a combination topic draws on', async () => {
    await ripe('Keen beekeeper');
    const other = await addFact('Lives in Hoorn');
    await createTopics([{ factId: other.id, text: 'Hoorn beekeeper rules', weight: 1, provenance: 'combo' }]);

    expect((await removing()).removed).toBe(0);
  });

  it('leaves a fact the reader has open, until they leave it', async () => {
    const fact = await ripe();
    const release = holdFactOnScreen(fact.id);

    expect((await removing()).removed).toBe(0);
    release();
    expect((await removing()).removed).toBe(1);
  });

  it('refuses when the statement changed, or a live job exists', async () => {
    const fact = await ripe();
    expect(await removeEmptyFact(fact.id, 'something else', T0)).toBe(false);

    await enqueueJob('topic_gen', { factId: fact.id, factStatement: STATEMENT, useCloud: true, mode: 'append' });
    expect(await removeEmptyFact(fact.id, STATEMENT, T0)).toBe(false);

    await updateFact(fact.id, { statement: 'Reworded' });
    expect(await meta(fact.id)).not.toHaveProperty('topics_empty_since');
  });

  it('a fact the person shaped reads as guarded on the card', async () => {
    const fact = await empty();
    expect(isRemovableEmptyFact((await factNow(fact.id))!)).toBe(true);
    await patchMetadata(fact.id, { places_by: 'user' });
    expect(isRemovableEmptyFact((await factNow(fact.id))!)).toBe(false);
  });
});
