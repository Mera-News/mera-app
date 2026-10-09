// Branch arms the legacy hygiene-service and optimisation-plan-service suites reached and the seam
// tests did not (gate G42): a sweep or cycle called with no `now`, a persona whose facts carry no
// usable creation time, and a verdict row whose stored context has no usable tree path.
// Real in-memory DB, real stores and digest, the gateway mock (real E2EE both ways).
import database from '@/lib/database';
import type ArticleFeedback from '@/lib/database/models/ArticleFeedback';
import { recordArticleFeedback, updateFeedbackContextPath } from '@/lib/database/services/article-feedback-service';
import { addFact } from '@/lib/database/services/fact-service';
import { MIN_FACTS_FOR_SWEEP, runHygieneSweep } from '@/lib/database/services/hygiene-service';
import { getPendingPlan, runOptimisationCycle } from '@/lib/database/services/optimisation-plan-service';
import { getSetting } from '@/lib/database/services/setting-service';
import { DIGEST_CONSTANTS } from '@/lib/news-harness/persona-management/feedback-digest';
import { advanceUntilDone, mockGateway, server, signInFixtureAccount, useFakeClock } from '@/test/helpers';

import { DAY, T0, quietLogger, resetCloudPersonaMemory, seedFact, seedPersona, sanityModel, spyOnNotifications } from './support';

const LEAF = ['more_about_topic', 'a_lot_more'];

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
});
afterEach(() => {
  notified.restore();
  logs.restore();
});

describe('hygiene sweep: the defaults a scheduler tick relies on', () => {
  beforeEach(() => {
    server.use(...mockGateway(sanityModel(() => false)));
  });

  it('a sweep called with no `now` reads the clock: the cooldown stamp is the current time', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP - 1);

    await advanceUntilDone(runHygieneSweep());

    expect(await getSetting('hygiene_last_sweep_at')).toBe(String(T0));
  });

  // The age gate reads the earliest creation time of the facts. A fact row without one (a restored or
  // pre-column row reads as 0) cannot prove age, so the persona counts as new today.
  it('facts with no recorded creation time: the persona is treated as young, however many facts there are', async () => {
    jest.setSystemTime(0);
    for (let i = 0; i < MIN_FACTS_FOR_SWEEP; i++) await addFact(i === 0 ? 'News' : `distinct interest number ${i}`);
    jest.setSystemTime(T0);

    const res = await advanceUntilDone(runHygieneSweep({ now: T0 }));

    expect(res).toMatchObject({ ran: false, reason: 'persona_too_young', proposalCount: 0 });
    expect(notified.calls()).toHaveLength(0);
  });

  it('the same facts with a recorded creation time, 100 days back, are swept (control for the case above)', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP, 100);

    const res = await advanceUntilDone(runHygieneSweep({ now: T0 }));

    expect(res).toMatchObject({ ran: true });
    expect(T0 - 100 * DAY).toBeGreaterThan(0);
  });
});

describe('optimisation cycle: defaults and verdict rows without a usable tree path', () => {
  beforeEach(() => {
    server.use(...mockGateway(() => 'no plan today'));
  });

  /** A topic and the context every liked verdict below carries. */
  async function climate() {
    const { topics } = await seedFact('Follows climate', [{ text: 'Climate', weight: 0.5 }]);
    return { topic: topics[0], matchedTopics: [{ topicId: topics[0].id, text: 'Climate' }] };
  }
  /** A verdict the way the tree writes it: recorded with its path, so the row is pending for the digest. */
  async function like(article: string, ctx: Record<string, unknown>, i: number) {
    jest.setSystemTime(T0 - DAY + i * 1000);
    await recordArticleFeedback({ articleId: article, sentiment: 'like', title: `Story ${article}`, contextJson: JSON.stringify(ctx) });
    jest.setSystemTime(T0);
  }
  /** A pending row an older build wrote (before verdicts without a path were born processed). */
  async function legacyLike(article: string, ctx: Record<string, unknown>, i: number) {
    await database.write(async () => {
      await database.get<ArticleFeedback>('article_feedback').create((r) => {
        r.articleId = article;
        r.sentiment = 'like';
        r.title = `Story ${article}`;
        r.contextJson = JSON.stringify(ctx);
        r.createdAt = new Date(T0 - DAY + i * 1000);
      });
    });
  }
  const weightDeltas = async (topicId: string) =>
    (await getPendingPlan())!.candidates[`topic_up:${topicId}`].ops.map((op) => (op as { delta?: number }).delta);

  it('a cycle called with no `now` reads the clock: the pending plan and the stamp carry the current time', async () => {
    const { matchedTopics } = await climate();
    for (let i = 0; i < 3; i++) await like(`l${i}`, { matchedTopics, treePath: LEAF }, i);

    await advanceUntilDone(runOptimisationCycle());

    expect(await getSetting('optimisation_last_run_at')).toBe(String(T0));
    expect((await getPendingPlan())!.createdAt).toBe(T0);
  });

  // The digest takes a tree path as a non-empty list of strings. Anything else means the reader gave a
  // verdict and went no deeper, so the rows fall through to verdict aggregation (a plain boost for repeated
  // likes) and not to the leaf's stronger one.
  it('rows with the leaf `a_lot_more` are boosted by the leaf strength (control for the cases below)', async () => {
    const { topic, matchedTopics } = await climate();
    for (let i = 0; i < 3; i++) await like(`l${i}`, { matchedTopics, treePath: LEAF }, i);

    await advanceUntilDone(runOptimisationCycle({ now: T0 }));

    expect(await weightDeltas(topic.id)).toEqual([DIGEST_CONSTANTS.pathBoostStrong]);
  });

  it('a list with no strings in it counts as no path: the rows are aggregated as plain verdicts', async () => {
    const { topic, matchedTopics } = await climate();
    for (let i = 0; i < 3; i++) await like(`l${i}`, { matchedTopics, treePath: [1, 2] }, i);

    const res = await advanceUntilDone(runOptimisationCycle({ now: T0 }));

    expect(res).toEqual({ ran: true, autoCount: 1, reviewCount: 0 });
    expect(await weightDeltas(topic.id)).toEqual([DIGEST_CONSTANTS.aggregateLikeDelta]);
  });

  it('a verdict committed on a leaf and then walked back up to the root keeps no path: aggregated as a plain verdict', async () => {
    const { topic, matchedTopics } = await climate();
    for (let i = 0; i < 3; i++) {
      await like(`l${i}`, { matchedTopics, treePath: LEAF }, i);
      await updateFeedbackContextPath(`l${i}`, 'like', [], true);
    }

    await advanceUntilDone(runOptimisationCycle({ now: T0 }));

    expect(await weightDeltas(topic.id)).toEqual([DIGEST_CONSTANTS.aggregateLikeDelta]);
  });

  it.each([
    ['carries no path at all', {}],
    ['carries a path that is not a list', { treePath: 'a_lot_more' }],
  ])('a pending row from an older build that %s is aggregated as a plain verdict', async (_label, extra) => {
    const { topic, matchedTopics } = await climate();
    for (let i = 0; i < 3; i++) await legacyLike(`l${i}`, { matchedTopics, ...extra }, i);

    const res = await advanceUntilDone(runOptimisationCycle({ now: T0 }));

    expect(res).toEqual({ ran: true, autoCount: 1, reviewCount: 0 });
    expect(await weightDeltas(topic.id)).toEqual([DIGEST_CONSTANTS.aggregateLikeDelta]);
  });
});
