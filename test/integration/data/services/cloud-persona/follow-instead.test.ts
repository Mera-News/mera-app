// The daily follow-instead offer: the sweep over real rows, the AI check through the gateway mock
// (real E2EE), and the reader's accept on the real tracked-story and fact services. In-memory DB.
import type { ArticleWithClusters } from '@/lib/generated/graphql-types';
import database from '@/lib/database';
import { getScoredDonorRows } from '@/lib/database/services/article-suggestion-reads';
import { batchMarkAsScoredByIds } from '@/lib/database/services/article-suggestion-scoring-writes';
import { addFact, getFacts } from '@/lib/database/services/fact-service';
import { runFollowInsteadSweep } from '@/lib/database/services/follow-instead-service';
import {
  acceptProposal,
  addSanityProposals,
  followInsteadTakesFact,
  getPendingCount,
  getPendingProposals,
  HYGIENE_PENDING_PRESENTATION_CAP,
  rejectProposal,
  runHygieneSweep,
} from '@/lib/database/services/hygiene-service';
import { getRecent } from '@/lib/database/services/persona-change-log-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { recordOpen } from '@/lib/database/services/story-impression-service';
import * as topicService from '@/lib/database/services/topic-service';
import { findActiveTrackedId, getActiveForTopicReconcile } from '@/lib/database/services/tracked-story-service';
import { RENDER_GATE } from '@/lib/stores/fact-rows-selector';
import { stepDiff } from '@/lib/scheduler/feed-sync/feed-sync-steps';
import { STAKE_RULE } from '@/lib/news-harness/persona-management/stake-check';
import * as tracking from '@/lib/tracking/track-actions';
import { advanceUntilDone, gatewayCalls, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';
import type { GatewayCall } from '@/test/helpers';

import { allRows, article, row, seed, toAlreadyRead, toComplete } from '../suggestions/support';
import {
  DAY,
  HOUR,
  T0,
  quietLogger,
  resetCloudPersonaMemory,
  sanityModel,
  seedPersona,
  seedTopics,
  setMode,
  spyOnNotifications,
  userMessage,
} from './support';

const KEY = 'follow_instead_last_sweep_at';

/** An interest the way chat stores it. */
const interest = async (statement: string, topics: string[], attribute = 'topics') => {
  const fact = await addFact(statement, undefined, { attribute });
  const rows = await seedTopics(fact.id, topics);
  return { fact, topics: rows };
};

let serial = 0;
/** `n` stories that matched a topic in the window, each scored `relevance`. */
async function stories(topic: { id: string; text: string }, n: number, relevance = 0.2, over: Partial<ArticleWithClusters> = {}) {
  const ids = Array.from({ length: n }, () => `s${(serial += 1)}`);
  const articles = ids.map((id) => article(id, { story_key: id, title_en: `Unrelated headline ${id}`, ...over } as Partial<ArticleWithClusters>));
  await seed(articles, { topics: Object.fromEntries(ids.map((id) => [id, [{ topicId: topic.id, text: topic.text }]])) as never });
  for (const id of ids) await toComplete(id, relevance);
  return ids;
}

/** The AI check's model: `hasStake` decides per fact statement. */
const checkModel = (hasStake: (statement: string) => boolean = () => false, subject = 'Football') => (call: GatewayCall) => {
  if (!/has_stake/.test(call.messages[0]?.content ?? '')) return sanityModel(() => false)(call);
  const statement = JSON.parse(userMessage(call).replace(/^Fact: /, '')) as string;
  return JSON.stringify({ has_stake: hasStake(statement), story_subject: subject, search: subject.toLowerCase() });
};

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;
let syncNow: jest.SpyInstance;

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(checkModel()));
  syncNow = jest.spyOn(tracking, 'syncFollowedStoryNow').mockResolvedValue();
});
afterEach(() => {
  syncNow.mockRestore();
  notified.restore();
  logs.restore();
});

const sweep = (now = T0) => advanceUntilDone(runFollowInsteadSweep({ now }));
const accept = (id: string) => advanceUntilDone(acceptProposal(id));
const checks = () => gatewayCalls().filter((c) => (c.messages[0]?.content ?? '').includes(STAKE_RULE));

/** The four-fact account, one fact standing in for each. */
async function fourFacts() {
  const out = [];
  for (const [statement, text] of [
    ['Follows technology news', 'artificial intelligence'],
    ['Follows world politics news', 'united nations'],
    ['Follows climate news', 'climate policy'],
    ['Follows football', 'premier league'],
  ]) {
    const seeded = await interest(statement, [text]);
    await stories(seeded.topics[0], 21, RENDER_GATE - 0.02);
    out.push(seeded);
  }
  return out;
}

/** One flooded topic on a non-interest fact, three quiet topics that do reach the Feed. */
async function flooded() {
  const pop = await interest('Works at a record label', ['katseye', 'streaming royalties'], 'employer');
  await stories(pop.topics[0], 40);
  await stories(pop.topics[1], 3, 0.8);
  for (const text of ['cricket', 'harbour']) {
    const other = await interest(`Works on ${text}`, [text], 'profession');
    await stories(other.topics[0], 3, 0.8);
  }
  return pop;
}

describe('the sweep', () => {
  it('offers the four-fact account one fact, with the subject from the check and no personal phrase', async () => {
    await fourFacts();

    expect((await sweep()).offered).toMatch(/^follow_instead:fact:/);

    const [offer, ...rest] = await getPendingProposals();
    expect(rest).toEqual([]);
    expect(offer).toMatchObject({ kind: 'follow_instead', invertible: false, subject: { topics: ['Football'] } });
    expect(offer.ops[0]).toMatchObject({ type: 'follow_story', label: 'Football', searchText: 'football' });
    expect(checks()).toHaveLength(1);
    expect(await getSetting(KEY)).toBe(String(T0));
    expect(notified.calls()).toHaveLength(1);
  });

  it('skips a candidate with a stake and moves on, at most three checks a sweep', async () => {
    await fourFacts();
    server.use(...mockGateway(checkModel(() => true)));

    expect((await sweep()).offered).toBeNull();

    expect(checks()).toHaveLength(3);
    expect(await getPendingProposals()).toEqual([]);
    expect(await getSetting(KEY)).toBe(String(T0));
  });

  it('a call that fails offers nothing and stamps nothing, so the next run asks again', async () => {
    await fourFacts();
    server.use(...mockGateway(() => ({ status: 500, body: 'nope' })));

    expect((await sweep()).offered).toBeNull();

    expect(await getPendingProposals()).toEqual([]);
    expect(await getSetting(KEY)).toBeNull();
  });

  it('on the phone it makes no call and no offer', async () => {
    await fourFacts();
    await setMode('on-device');

    expect((await sweep()).reason).toBe('on_device');

    expect(gatewayCalls()).toHaveLength(0);
    expect(await getPendingProposals()).toEqual([]);
  });

  it('with a clear persona it makes no call', async () => {
    const { topics } = await interest('Follows football', ['premier league']);
    await stories(topics[0], 21, 0.8);

    expect((await sweep()).offered).toBeNull();

    expect(gatewayCalls()).toHaveLength(0);
  });

  it('makes at most one offer a day, and none while one waits', async () => {
    await fourFacts();
    await sweep();
    const [first] = await getPendingProposals();

    await rejectProposal(first.id);
    expect((await sweep(T0 + 23 * HOUR)).reason).toBe('cooldown');
    expect(await getPendingProposals()).toEqual([]);

    expect((await sweep(T0 + DAY)).offered).toMatch(/^follow_instead:fact:/);
    expect((await sweep(T0 + 3 * DAY)).reason).toBe('waiting');
    expect(await getPendingCount()).toBe(1);
  });

  it('never offers a dismissed fact again', async () => {
    await fourFacts();
    await sweep();
    const [first] = await getPendingProposals();
    await rejectProposal(first.id);

    const { offered } = await sweep(T0 + DAY);

    expect(offered).toMatch(/^follow_instead:fact:/);
    expect(offered).not.toBe(first.id);
  });

  it('reads opens from the last 48h only: an older open says nothing about these stories', async () => {
    const pop = await flooded();
    const ids = (await allRows()).filter((r) => r.matchedTopicsJson?.includes(pop.topics[0].id)).map((r) => r.id);
    jest.setSystemTime(T0 - 3 * DAY);
    for (const id of ids.slice(0, 20)) await recordOpen({ articleId: id, surface: 'feed' });
    jest.setSystemTime(T0);

    expect((await sweep()).offered).toBe('follow_instead:topic:katseye');
  });

  it('a flooded topic the reader opens gets no offer, and already-read rows leave the share', async () => {
    const pop = await flooded();
    const ids = (await allRows()).filter((r) => r.matchedTopicsJson?.includes(pop.topics[0].id)).map((r) => r.id);
    for (const id of ids.slice(0, 15)) await toAlreadyRead(id);
    // 7 of the 25 left is 28%.
    for (const id of ids.slice(15, 22)) await recordOpen({ articleId: id, surface: 'feed' });

    expect((await sweep()).offered).toBeNull();
    expect(gatewayCalls()).toHaveLength(0);
  });

  it('skips a story-bound topic and a followed topic', async () => {
    const pop = await flooded();
    const topic = pop.topics[0];
    await database.write(() =>
      database.get('tracked_stories').create((s) => {
        Object.assign(s, { topicId: topic.id, status: 'active', memberArticleIds: [], memberSnapshots: [] });
      }),
    );

    expect((await sweep()).offered).toBeNull();
  });
});

describe('the weekly sweep and the backfill leave a daily offer alone', () => {
  it('a full sweep keeps it first', async () => {
    await fourFacts();
    await sweep();
    const [offer] = await getPendingProposals();
    await seedPersona(10);

    await advanceUntilDone(runHygieneSweep({ now: T0, force: true }));

    expect((await getPendingProposals()).map((p) => p.id)).toContain(offer.id);
    expect((await getPendingProposals())[0].id).toBe(offer.id);
  });

  it('a sweep that bailed on the size gate keeps it too', async () => {
    await fourFacts();
    await sweep();
    const [offer] = await getPendingProposals();

    await advanceUntilDone(runHygieneSweep({ now: T0, force: true }));

    expect((await getPendingProposals()).map((p) => p.id)).toEqual([offer.id]);
  });

  it('a full queue still shows it: the offer takes the first slot', async () => {
    await fourFacts();
    const seeded = await seedPersona(HYGIENE_PENDING_PRESENTATION_CAP + 2);
    await addSanityProposals(seeded.map((f) => ({ factId: f.id, topicIds: [], fillTo: 1 })));

    await sweep();

    expect((await getPendingProposals())[0].kind).toBe('follow_instead');
  });
});

describe('accept', () => {
  it('a flood follows first, retires the one topic undoably, syncs last and settles', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    const retire = jest.spyOn(topicService, 'retire');

    const res = await accept(offer.id);

    expect(res).toMatchObject({ applied: true, ok: true });
    expect(await findActiveTrackedId({ stableClusterId: null, articleId: '', searchText: 'katseye' })).not.toBeNull();
    expect((await getActiveForTopicReconcile()).map((s) => s.topicId)).toHaveLength(1);
    expect((await topicService.getByFact(pop.fact.id)).find((t) => t.text === 'katseye')?.status).toBe('retired');
    expect((await getFacts()).map((f) => f.id)).toContain(pop.fact.id);
    const log = await getRecent(5);
    expect(log[0]).toMatchObject({ actionType: 'retire_topic', source: 'digest' });
    expect(await getPendingProposals()).toEqual([]);
    expect(syncNow).toHaveBeenCalledTimes(1);
    expect(syncNow.mock.invocationCallOrder[0]).toBeGreaterThan(retire.mock.invocationCallOrder[0]);
    retire.mockRestore();
  });

  it('a failed follow removes nothing and keeps the proposal', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    const mint = jest.spyOn(topicService, 'createTopics').mockRejectedValueOnce(new Error('no write'));

    const res = await accept(offer.id);
    mint.mockRestore();

    expect(res).toMatchObject({ applied: false, ok: false });
    expect((await topicService.getByFact(pop.fact.id)).every((t) => t.status === 'active')).toBe(true);
    expect((await getPendingProposals()).map((p) => p.id)).toEqual([offer.id]);
    expect(await getActiveForTopicReconcile()).toEqual([]);
    expect(syncNow).not.toHaveBeenCalled();
  });

  it('a follow that throws removes nothing and keeps the proposal', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    const follow = jest.spyOn(tracking, 'trackStoryWithProposal').mockRejectedValueOnce(new Error('no write'));

    const res = await accept(offer.id);
    follow.mockRestore();

    expect(res).toMatchObject({ applied: false, ok: false });
    expect((await topicService.getByFact(pop.fact.id)).every((t) => t.status === 'active')).toBe(true);
    expect(await getPendingCount()).toBe(1);
  });

  it('a retire that fails keeps the proposal, and a second tap finishes without a second story', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    const retire = jest.spyOn(topicService, 'retire').mockRejectedValueOnce(new Error('no write'));

    expect(await accept(offer.id)).toMatchObject({ applied: false, ok: false });
    expect(await getPendingCount()).toBe(1);
    retire.mockRestore();

    expect(await accept(offer.id)).toMatchObject({ applied: true, ok: true });
    expect(await getActiveForTopicReconcile()).toHaveLength(1);
    expect((await topicService.getByFact(pop.fact.id)).find((t) => t.text === 'katseye')?.status).toBe('retired');
  });

  it('the fact\'s last active topic takes the fact: the dialog can say so, and there is no retire row to undo', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    expect(await followInsteadTakesFact(offer)).toBe(false);
    await topicService.retire(pop.topics[1].id);
    expect(await followInsteadTakesFact(offer)).toBe(true);

    expect(await accept(offer.id)).toMatchObject({ applied: true, ok: true });

    expect((await getFacts()).map((f) => f.id)).not.toContain(pop.fact.id);
    const log = await getRecent(5);
    expect(log.map((l) => l.actionType)).not.toContain('retire_topic');
    expect(log[0]).toMatchObject({ actionType: 'hygiene_delete_fact', source: 'digest' });
  });

  it('a no-stake offer takes the fact and all its topics, and leaves the followed topic retrieving', async () => {
    const seeded = await fourFacts();
    await sweep();
    const [offer] = await getPendingProposals();
    const fact = seeded.find((s) => s.fact.id === offer.targetFactIds[0])!;
    expect(await followInsteadTakesFact(offer)).toBe(true);

    expect(await accept(offer.id)).toMatchObject({ applied: true, ok: true });

    expect((await getFacts()).map((f) => f.id)).not.toContain(fact.fact.id);
    expect(await topicService.getByFact(fact.fact.id)).toEqual([]);
    expect((await topicService.getActive()).find((t) => t.provenance === 'tracked')?.text).toBe('football');
    expect(syncNow).toHaveBeenCalledTimes(1);
  });
});

describe('the two questions the plan left open', () => {
  it('purged article ids come back on the next sync, free, through the followed topic alone', async () => {
    const seeded = await fourFacts();
    await sweep();
    const [offer] = await getPendingProposals();
    const fact = seeded.find((s) => s.fact.id === offer.targetFactIds[0])!;
    const ids = (await allRows()).filter((r) => r.matchedTopicsJson?.includes(fact.topics[0].id)).map((r) => r.id);
    await accept(offer.id);
    expect((await allRows()).map((r) => r.id)).toEqual(expect.not.arrayContaining(ids));

    const ctx = { signal: new AbortController().signal, log: () => {} } as never;
    const diff = await stepDiff(
      {
        serverArticleIds: ids,
        articleToTopicTexts: new Map(ids.map((id) => [id, ['football']])),
        freeTopicTexts: new Set(['football']),
      },
      ctx,
    );

    expect([...diff.storyIds!].sort()).toEqual([...ids].sort());
    expect(diff.personaIds).toEqual([]);
  });

  it('a retired topic purges nothing: its rows stay, so no id comes back through the diff', async () => {
    const pop = await flooded();
    await sweep();
    const [offer] = await getPendingProposals();
    const before = (await allRows()).length;
    expect(pop.topics).toHaveLength(2);

    await accept(offer.id);

    expect((await allRows()).length).toBe(before);
  });

  it('a relevance-0 row a followed story brought in is no donor, so it cannot spread to a sibling', async () => {
    const { topics } = await interest('Follows football', ['premier league']);
    const [followedOnly] = await stories(topics[0], 1);
    await database.write(async () => {
      const r = await row(followedOnly);
      await r.update((x) => {
        x.status = 'unscored';
        x.scoredAt = null;
        x.relevance = 0;
      });
    });
    await batchMarkAsScoredByIds([followedOnly]);

    expect((await row(followedOnly)).status).toBe('complete');
    expect((await getScoredDonorRows(T0 - 2 * DAY)).map((d) => d.id)).not.toContain(followedOnly);
  });
});
