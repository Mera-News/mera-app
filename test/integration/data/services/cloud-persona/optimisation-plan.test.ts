// The daily feed tune-up (Round-4 C5): deferred verdicts are folded into ONE plan, organised by ONE
// E2EE completion, reviewed by the reader, and applied only on accept. Real in-memory DB, real
// article-feedback rows, the real digest and persona-action executor, and the gateway mock.
//
// Replaces optimisation-plan-service.test.ts (14 `it`). Carried: skips on too few signals; skips on
// cooldown; runs once the cooldown has passed; builds the deterministic plan and fires ONE
// notification when the gateway fails; honours a valid model organisation; sweeps long-stale signals
// when nothing is actionable; does not sweep recent ones; a later run replaces the pending plan;
// accept applies every checked auto and selected review op and marks ALL rows processed; unchecked and
// skipped fingerprints are remembered and not re-proposed; accept with no plan; dismiss remembers
// everything, marks rows processed and applies nothing; the structured suppression kind and value reach
// the executor; on-device mode skips the whole cycle.
// Not carried: nothing. The mocked executor, topic service and feedback service are the real ones, so
// "forwards kind and value to the executor" is asserted on the stored suppression row.
// Also covered (no legacy case): the 40-signal cap, the model's outputs being validated, alternatives.
import {
  getUnprocessedFeedback,
  recordArticleFeedback,
  countUnprocessedFeedback,
} from '@/lib/database/services/article-feedback-service';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import {
  MAX_SIGNALS_PER_RUN,
  MIN_UNPROCESSED_FOR_RUN,
  RUN_COOLDOWN_MS,
  STALE_SIGNAL_MS,
  acceptPlan,
  dismissPlan,
  getPendingPlan,
  runOptimisationCycle,
} from '@/lib/database/services/optimisation-plan-service';
import * as executor from '@/lib/database/services/persona-action-executor';
import { getRecent } from '@/lib/database/services/persona-change-log-service';
import { getPreferenceKind } from '@/lib/database/services/publication-preference-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { getAll as getSuppressions } from '@/lib/database/services/suppression-service';
import { getByFact, retire } from '@/lib/database/services/topic-service';
import database from '@/lib/database';
import { SMALL_MODEL } from '@/lib/llm/constants';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import type { GatewayCall, GatewayReply } from '@/test/helpers';

import {
  DAY,
  T0,
  quietLogger,
  resetCloudPersonaMemory,
  seedFact,
  setMode,
  spyOnNotifications,
  userMessage,
  systemMessage,
} from './support';

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;

/** The default model: no reply that parses, so the plan is the deterministic one. */
const SILENT = () => 'no plan today';

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(SILENT));
});
afterEach(() => {
  notified.restore();
  logs.restore();
});

const reply = (respond: (call: GatewayCall) => GatewayReply) => server.use(...mockGateway(respond));
const cycle = (opts: Parameters<typeof runOptimisationCycle>[0] = { now: T0 }) => advanceUntilDone(runOptimisationCycle(opts));
/** The candidate lines the service put in the prompt: `[fingerprint] kind | summary ...`. */
const promptLines = (call: GatewayCall) => userMessage(call).split('\n').filter(Boolean);
const fingerprintsOf = (call: GatewayCall) => promptLines(call).map((l) => /^\[([^\]]+)\]/.exec(l)![1]);

const TREE = {
  aLotMore: ['more_about_topic', 'a_lot_more'],
  kindOfEvent: ['not_important_to_me', 'this_kind_of_event'],
  seenOnly: ['feedback', 'seenOnly'], // a context-ful verdict that maps to no candidate
};

/** One committed verdict, recorded at `at` (the digest reads only verdicts that carry a tree path). */
async function verdict(
  article: string,
  sentiment: 'like' | 'dislike',
  ctx: Record<string, unknown>,
  at?: number,
) {
  if (at !== undefined) jest.setSystemTime(at);
  await recordArticleFeedback({
    articleId: article,
    sentiment,
    title: `Story ${article}`,
    contextJson: JSON.stringify(ctx),
  });
}

/** Two topics and the three verdicts of the usual day: two nudges and one "fewer obituaries". */
async function actionableDay(at = T0 - DAY) {
  const { topics } = await seedFact('Follows climate and space', [
    { text: 'Climate', weight: 0.5 },
    { text: 'Space', weight: 0.5 },
  ]);
  const [climate, space] = topics;
  await verdict('a1', 'like', { matchedTopics: [{ topicId: climate.id, text: 'Climate' }], treePath: TREE.aLotMore }, at);
  await verdict('a2', 'dislike', { eventType: 'obituary', treePath: TREE.kindOfEvent }, at + 1000);
  await verdict('a3', 'like', { matchedTopics: [{ topicId: space.id, text: 'Space' }], treePath: TREE.aLotMore }, at + 2000);
  const rows = await getUnprocessedFeedback();
  return { climate, space, rowIds: rows.map((r) => r.id).sort() };
}

const planFingerprints = (plan: NonNullable<Awaited<ReturnType<typeof getPendingPlan>>>) => ({
  auto: plan.autoChanges.map((a) => a.fingerprint).sort(),
  review: plan.reviewItems.map((r) => r.fingerprint),
});


// ---------------------------------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------------------------------
describe('runOptimisationCycle: guards', () => {
  it('skips with too few unprocessed verdicts: no model, no stamp', async () => {
    await seedFact('Follows climate', [{ text: 'Climate', weight: 0.5 }]);
    for (let i = 0; i < MIN_UNPROCESSED_FOR_RUN - 1; i++) {
      await verdict(`v${i}`, 'dislike', { eventType: `e${i}`, treePath: TREE.kindOfEvent }, T0 - DAY + i * 1000);
    }

    const res = await cycle();

    expect(res).toEqual({ ran: false, reason: 'too_few_signals', autoCount: 0, reviewCount: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting('optimisation_last_run_at')).toBeNull();
  });

  it('runs with exactly the minimum number of verdicts', async () => {
    for (let i = 0; i < MIN_UNPROCESSED_FOR_RUN; i++) {
      await verdict(`v${i}`, 'dislike', { eventType: `e${i}`, treePath: TREE.kindOfEvent }, T0 - DAY + i * 1000);
    }

    expect(await cycle()).toMatchObject({ ran: true, reviewCount: MIN_UNPROCESSED_FOR_RUN });
  });

  it('skips inside the cooldown, runs from the cooldown on, and `force` bypasses it', async () => {
    await actionableDay();
    expect((await cycle({ now: T0 })).ran).toBe(true);
    expect(await getSetting('optimisation_last_run_at')).toBe(String(T0));
    const callsAfterFirst = gatewayCalls().length;

    const early = await cycle({ now: T0 + RUN_COOLDOWN_MS - 1 });
    expect(early).toEqual({ ran: false, reason: 'cooldown', autoCount: 0, reviewCount: 0 });
    expect(gatewayCalls()).toHaveLength(callsAfterFirst);
    expect(await getSetting('optimisation_last_run_at')).toBe(String(T0));

    expect((await cycle({ now: T0 + RUN_COOLDOWN_MS })).ran).toBe(true);
    expect(gatewayCalls()).toHaveLength(callsAfterFirst + 1);

    expect((await cycle({ now: T0 + RUN_COOLDOWN_MS + 1, force: true })).ran).toBe(true);
  });

  it('stamps the run even when nothing is actionable, so the cooldown holds', async () => {
    for (let i = 0; i < 3; i++) {
      await verdict(`v${i}`, 'dislike', { eventType: `e${i}`, treePath: TREE.seenOnly }, T0 - DAY + i * 1000);
    }

    const res = await cycle();

    expect(res).toEqual({ ran: true, reason: 'no_candidates', autoCount: 0, reviewCount: 0 });
    expect(await getSetting('optimisation_last_run_at')).toBe(String(T0));
    expect(gatewayCalls()).toHaveLength(0); // nothing to organise, so no model call
    expect(notified.calls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// What the cycle sends and stores
// ---------------------------------------------------------------------------------------------------
describe('runOptimisationCycle: the one organise call and the stored plan', () => {
  it('sends ONE completion on the small model carrying every candidate line, and nothing else', async () => {
    const { climate, space } = await actionableDay();

    await cycle();

    const calls = gatewayCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ route: 'chat', model: SMALL_MODEL, stream: false });
    expect(systemMessage(calls[0])).toContain('You organize a daily news-feed "tune-up" plan');
    // Auto nudges first, then the review candidates; each line names its fingerprint, kind and summary.
    expect(promptLines(calls[0]).sort()).toEqual(
      [
        `[topic_up:${climate.id}] topic_up | Show more about "Climate"`,
        `[topic_up:${space.id}] topic_up | Show more about "Space"`,
        '[suppress:evt:obituary] suppress | Fewer "obituary" stories',
      ].sort(),
    );
    expect(promptLines(calls[0])[2]).toContain('suppress:evt:obituary');
    // No signal is sent as such: no article id, no title, no raw feedback context.
    expect(userMessage(calls[0])).not.toContain('Story a');
  });

  it('stores the pending plan with the candidate registry and every source row, and fires ONE notification', async () => {
    const { climate, space, rowIds } = await actionableDay();

    const res = await cycle();

    expect(res).toEqual({ ran: true, autoCount: 2, reviewCount: 1 });
    const plan = (await getPendingPlan())!;
    expect(plan).toMatchObject({ createdAt: T0, status: 'pending' });
    expect(planFingerprints(plan)).toEqual({
      auto: [`topic_up:${climate.id}`, `topic_up:${space.id}`].sort(),
      review: ['suppress:evt:obituary'],
    });
    expect(plan.reviewItems[0]).toMatchObject({
      question: 'Fewer "obituary" stories?',
      options: [
        { label: 'Apply', action: 'apply' },
        { label: 'Skip', action: 'skip' },
      ],
      defaultIndex: 0,
      conflictsWith: [],
    });
    expect(plan.candidates['suppress:evt:obituary'].ops).toEqual([
      {
        action_type: 'add_suppression',
        suppressionPattern: 'obituary',
        suppressionKeywords: ['obituary'],
        suppressionStrength: 0.5,
        suppressionKind: 'event_type',
        suppressionValue: 'obituary',
      },
    ]);
    expect(plan.allSourceRowIds).toEqual(rowIds);
    expect(await getSetting('optimisation_last_run_at')).toBe(String(T0));

    expect(notified.calls()).toEqual([
      {
        type: 'optimisation_plan',
        source: 'optimisation-plan',
        title: 'optimisationPlan.notificationTitle',
        body: 'optimisationPlan.notificationBody',
        icon: 'auto-fix-high',
        context: { count: 3 },
        actions: [{ id: 'review-plan', labelKey: 'optimisationPlan.reviewChip' }],
      },
    ]);
    const rows = await getNotifications();
    expect(rows.map((r) => r.type)).toEqual(['optimisation_plan']);
  });

  it('builds the same deterministic plan when the gateway refuses, and reports the failure once', async () => {
    await actionableDay();
    reply(() => ({ status: 400, body: { error: 'refused' } }));

    const res = await cycle();

    expect(res).toEqual({ ran: true, autoCount: 2, reviewCount: 1 });
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(logs.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'optimisation-plan-service', method: 'organizePlan.gateway' },
    });
    expect(notified.calls()).toHaveLength(1);
  });

  it('replaces the previous pending plan on a later run', async () => {
    await actionableDay();
    await cycle({ now: T0 });
    expect((await getPendingPlan())!.createdAt).toBe(T0);

    await cycle({ now: T0 + 2 * DAY, force: true });

    expect((await getPendingPlan())!.createdAt).toBe(T0 + 2 * DAY);
  });

  it('feeds at most the newest MAX_SIGNALS_PER_RUN verdicts into the digest', async () => {
    const stale = 5;
    // The five oldest verdicts all name "Old topic": were they read, it would be the best supported candidate.
    for (let i = 0; i < stale; i++) {
      await verdict(`old${i}`, 'like', { matchedTopics: [{ text: 'Old topic' }], treePath: TREE.aLotMore }, T0 - 2 * DAY + i * 1000);
    }
    for (let i = 0; i < MAX_SIGNALS_PER_RUN; i++) {
      await verdict(`new${i}`, 'like', { matchedTopics: [{ text: 'Newer topic' }], treePath: TREE.aLotMore }, T0 - DAY + i * 1000);
    }
    const newest = (await getUnprocessedFeedback()).slice(0, MAX_SIGNALS_PER_RUN).map((r) => r.id).sort();

    await cycle();

    const call = gatewayCalls()[0];
    expect(promptLines(call)).toEqual(['[topic_up:newer topic] topic_up | Show more about "Newer topic"']);
    const plan = (await getPendingPlan())!;
    expect(Object.keys(plan.candidates)).toEqual(['topic_up:newer topic']);
    expect(plan.allSourceRowIds).toEqual(newest);
    expect(plan.allSourceRowIds).toHaveLength(MAX_SIGNALS_PER_RUN);
  });

  it('keeps a stale verdict out of the sweep while the cycle has candidates (stale rows are swept only when nothing is actionable)', async () => {
    const { rowIds } = await actionableDay(T0 - STALE_SIGNAL_MS - DAY);

    const res = await cycle();

    expect(res).toMatchObject({ ran: true, autoCount: 2, reviewCount: 1 });
    expect((await getPendingPlan())!.allSourceRowIds).toEqual(rowIds);
    expect(await countUnprocessedFeedback()).toBe(3); // nothing processed until the reader decides
  });
});

describe('runOptimisationCycle: nothing actionable', () => {
  const lone = async (ageDays: number) => {
    for (let i = 0; i < 3; i++) {
      await verdict(`v${i}`, 'dislike', { eventType: `e${i}`, treePath: TREE.seenOnly }, T0 - ageDays * DAY + i * 1000);
    }
  };

  it('marks long-stale verdicts processed so they cannot wedge the minimum forever', async () => {
    await lone(STALE_SIGNAL_MS / DAY + 10);

    const res = await cycle();

    expect(res.reason).toBe('no_candidates');
    expect(await countUnprocessedFeedback()).toBe(0);
    expect(await getPendingPlan()).toBeNull();
    expect(notified.calls()).toHaveLength(0);
  });

  it('does NOT sweep recent verdicts', async () => {
    await lone(1);

    const res = await cycle();

    expect(res.reason).toBe('no_candidates');
    expect(await countUnprocessedFeedback()).toBe(3);
  });
});

// ---------------------------------------------------------------------------------------------------
// The model annotates; it never invents
// ---------------------------------------------------------------------------------------------------
describe('runOptimisationCycle: the model reply is validated', () => {
  /** A model that answers from the fingerprints it was shown. */
  const model = (build: (fps: string[]) => unknown) => (call: GatewayCall) => JSON.stringify(build(fingerprintsOf(call)));

  it('honours a valid organisation: a safe nudge can be moved to review with the model question and default', async () => {
    const { climate, space } = await actionableDay();
    reply(
      model(() => ({
        autoChanges: [{ fingerprint: `topic_up:${space.id}`, summary: 'More Space' }],
        reviewItems: [
          {
            fingerprint: `topic_up:${climate.id}`,
            question: 'More about Climate?',
            options: [
              { label: 'Yes', action: 'apply' },
              { label: 'No', action: 'skip' },
            ],
            defaultIndex: 1,
            rationale: 'You liked several climate stories.',
          },
        ],
      })),
    );

    const res = await cycle();

    expect(res).toEqual({ ran: true, autoCount: 1, reviewCount: 2 });
    const plan = (await getPendingPlan())!;
    expect(plan.reviewItems.find((r) => r.fingerprint === `topic_up:${climate.id}`)).toMatchObject({
      question: 'More about Climate?',
      options: [
        { label: 'Yes', action: 'apply' },
        { label: 'No', action: 'skip' },
      ],
      defaultIndex: 1,
      rationale: 'You liked several climate stories.',
    });
    // The summary the reader sees is the deterministic one, not the model's rewording.
    expect(plan.autoChanges).toEqual([{ fingerprint: `topic_up:${space.id}`, summary: 'Show more about "Space"' }]);
  });

  it('cannot promote a suppression to auto, and cannot invent a candidate', async () => {
    const { climate, space } = await actionableDay();
    reply(
      model((fps) => ({
        autoChanges: [...fps, 'topic_up:invented', 'suppress:everything'].map((fingerprint) => ({ fingerprint, summary: 'x' })),
        reviewItems: [{ fingerprint: 'retire_topic:invented', question: 'q', options: [], defaultIndex: 0, rationale: '' }],
      })),
    );

    await cycle();

    const plan = (await getPendingPlan())!;
    expect(planFingerprints(plan)).toEqual({
      auto: [`topic_up:${climate.id}`, `topic_up:${space.id}`].sort(),
      review: ['suppress:evt:obituary'],
    });
    expect(Object.keys(plan.candidates).sort()).toEqual(
      [`topic_up:${climate.id}`, `topic_up:${space.id}`, 'suppress:evt:obituary'].sort(),
    );
  });

  it('a reply that is not a plan changes nothing: the plan equals the deterministic one', async () => {
    const { climate, space } = await actionableDay();
    const expected = {
      auto: [`topic_up:${climate.id}`, `topic_up:${space.id}`].sort(),
      review: ['suppress:evt:obituary'],
    };
    for (const garbage of ['I could not decide.', '{"autoChanges": "all", "reviewItems": 7}', '[1, 2', '{not json}', '']) {
      await setSetting('optimisation_last_run_at', '');
      reply(() => garbage);

      const res = await cycle({ now: T0, force: true });

      expect(res).toEqual({ ran: true, autoCount: 2, reviewCount: 1 });
      expect(planFingerprints((await getPendingPlan())!)).toEqual(expected);
    }
  });

  it('keeps only options the reader can act on: apply and skip are always present, a bad default falls back to the first', async () => {
    await actionableDay();
    reply(
      model(() => ({
        autoChanges: [],
        reviewItems: [
          {
            fingerprint: 'suppress:evt:obituary',
            question: '  Fewer obituaries?  ',
            options: [
              { label: 'Only this', action: 'apply' },
              { label: '', action: 'skip' }, // no label: dropped
              { label: 'Do something else', action: 'delete-everything' }, // unknown action: dropped
              { label: 'Keep a bit', action: 'alternative', altOps: [{ action_type: 'add_suppression', suppressionStrength: 0.2 }] },
            ],
            defaultIndex: 9,
            rationale: ' because ',
          },
        ],
      })),
    );

    await cycle();

    const item = (await getPendingPlan())!.reviewItems[0];
    expect(item.question).toBe('Fewer obituaries?');
    expect(item.rationale).toBe('because');
    expect(item.defaultIndex).toBe(0);
    expect(item.options.map((o) => [o.label, o.action])).toEqual([
      ['Only this', 'apply'],
      ['Keep a bit', 'alternative'],
      ['Skip', 'skip'],
    ]);
    // The gentler suppression keeps the candidate's own pattern and structured field, at the lower strength.
    expect(item.options[1].altOps).toEqual([
      {
        action_type: 'add_suppression',
        suppressionPattern: 'obituary',
        suppressionKeywords: ['obituary'],
        suppressionStrength: 0.2,
        suppressionKind: 'event_type',
        suppressionValue: 'obituary',
      },
    ]);
  });

  it('accepts an alternative only when it is a gentler version of the same change', async () => {
    const { climate } = await actionableDay();
    const fp = `topic_up:${climate.id}`;
    reply(
      model(() => ({
        autoChanges: [],
        reviewItems: [
          {
            fingerprint: fp,
            question: 'More climate?',
            options: [
              { label: 'Gentler', action: 'alternative', altOps: [{ action_type: 'set_topic_weight', delta: 0.1 }] },
              { label: 'Stronger', action: 'alternative', altOps: [{ action_type: 'set_topic_weight', delta: 0.9 }] },
              { label: 'Opposite', action: 'alternative', altOps: [{ action_type: 'set_topic_weight', delta: -0.1 }] },
              { label: 'Other', action: 'alternative', altOps: [{ action_type: 'retire_topic' }] },
            ],
            defaultIndex: 0,
            rationale: '',
          },
        ],
      })),
    );

    await cycle();

    const item = (await getPendingPlan())!.reviewItems.find((r) => r.fingerprint === fp)!;
    expect(item.options.map((o) => o.label)).toEqual(['Apply', 'Gentler', 'Skip']);
    expect(item.options[1].altOps).toEqual([
      { action_type: 'set_topic_weight', topicId: climate.id, topicText: 'Climate', delta: 0.1 },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------
// On-device
// ---------------------------------------------------------------------------------------------------
describe('runOptimisationCycle: on-device mode', () => {
  it('skips the whole cycle: no model call, nothing stamped or consumed, not even with force', async () => {
    await actionableDay();
    await setMode('on-device');

    const res = await cycle({ now: T0, force: true });

    expect(res).toEqual({ ran: false, reason: 'on_device', autoCount: 0, reviewCount: 0 });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting('optimisation_last_run_at')).toBeNull();
    expect(await getPendingPlan()).toBeNull();
    expect(await countUnprocessedFeedback()).toBe(3);
    expect(notified.calls()).toHaveLength(0);
  });

  it('also skips when only the persisted row says on-device', async () => {
    await actionableDay();
    await setSetting('mera_processing_mode', 'ON_DEVICE');

    expect((await cycle()).reason).toBe('on_device');
    expect(gatewayCalls()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// Accept and dismiss
// ---------------------------------------------------------------------------------------------------
const weightOf = async (factId: string, text: string) => (await getByFact(factId)).find((t) => t.text === text)!.weight;

describe('getPendingPlan', () => {
  it('is null with nothing queued, and null for a stored row that is not a plan', async () => {
    expect(await getPendingPlan()).toBeNull();
    await setSetting('optimisation_pending_plan', '{not json');
    expect(await getPendingPlan()).toBeNull();
    await setSetting('optimisation_pending_plan', JSON.stringify({ status: 'pending', candidates: {} }));
    expect(await getPendingPlan()).toBeNull();
  });
});

describe('acceptPlan', () => {
  it('applies every auto nudge and the default review option through the real executor, and settles the plan', async () => {
    const { climate, space, rowIds } = await actionableDay();
    await cycle();

    const res = await acceptPlan();

    expect(res).toEqual({ applied: true, appliedOps: 3, errors: [] });
    expect(await weightOf(climate.factId!, 'Climate')).toBeCloseTo(0.8);
    expect(await weightOf(space.factId!, 'Space')).toBeCloseTo(0.8);
    // The structured pair reaches the executor: an exact event-type filter, not a keyword scan.
    const suppressions = await getSuppressions();
    expect(suppressions).toHaveLength(1);
    expect(suppressions[0]).toMatchObject({ pattern: 'obituary', kind: 'event_type', value: 'obituary' });
    // Every applied op is an invertible change-log row from the feedback source.
    const log = await getRecent();
    expect(log.map((l) => l.source)).toEqual(['feedback', 'feedback', 'feedback']);
    // ALL source verdicts are processed, the plan is settled, and no second accept finds it.
    expect(await countUnprocessedFeedback()).toBe(0);
    expect(rowIds).toHaveLength(3);
    expect(await getPendingPlan()).toBeNull();
    expect(await acceptPlan()).toEqual({ applied: false, appliedOps: 0, errors: ['no pending plan'] });
  });

  it('skips an unchecked auto change and a review "skip", remembers both, and never re-proposes them', async () => {
    const { climate, space } = await actionableDay();
    await cycle();

    const res = await acceptPlan({ uncheckedAuto: [`topic_up:${climate.id}`], reviewChoices: { 'suppress:evt:obituary': 1 } });

    expect(res).toEqual({ applied: true, appliedOps: 1, errors: [] });
    expect(await weightOf(climate.factId!, 'Climate')).toBeCloseTo(0.5);
    expect(await weightOf(space.factId!, 'Space')).toBeCloseTo(0.8);
    expect(await getSuppressions()).toHaveLength(0);
    expect(JSON.parse((await getSetting('optimisation_rejected_fingerprints'))!).sort()).toEqual(
      [`topic_up:${climate.id}`, 'suppress:evt:obituary'].sort(),
    );

    // The same verdicts again, two days later: only the nudge the reader accepted can come back.
    await verdict('b1', 'like', { matchedTopics: [{ topicId: climate.id, text: 'Climate' }], treePath: TREE.aLotMore }, T0 + DAY);
    await verdict('b2', 'dislike', { eventType: 'obituary', treePath: TREE.kindOfEvent }, T0 + DAY + 1000);
    await verdict('b3', 'like', { matchedTopics: [{ topicId: space.id, text: 'Space' }], treePath: TREE.aLotMore }, T0 + DAY + 2000);
    await cycle({ now: T0 + 2 * DAY, force: true });
    const plan = (await getPendingPlan())!;
    expect(planFingerprints(plan)).toEqual({ auto: [`topic_up:${space.id}`], review: [] });
  });

  it('applies a chosen gentler alternative instead of the full change', async () => {
    const { climate } = await actionableDay();
    reply((call) =>
      JSON.stringify({
        autoChanges: [],
        reviewItems: [
          {
            fingerprint: `topic_up:${climate.id}`,
            question: 'More climate?',
            options: [
              { label: 'Yes', action: 'apply' },
              { label: 'A little', action: 'alternative', altOps: [{ action_type: 'set_topic_weight', delta: 0.1 }] },
              { label: 'No', action: 'skip' },
            ],
            defaultIndex: 0,
            rationale: '',
          },
        ],
        seen: fingerprintsOf(call).length,
      }),
    );
    await cycle();

    await acceptPlan({ reviewChoices: { [`topic_up:${climate.id}`]: 1 } });

    expect(await weightOf(climate.factId!, 'Climate')).toBeCloseTo(0.6);
  });

  it('resolves a topic named only by text to the strongest ACTIVE topic with that text; one with no active topic is reported and the rest still apply', async () => {
    // The verdicts came from cards whose topics had no row on this device when the plan was made.
    for (let i = 0; i < 2; i++) {
      await verdict(`b${i}`, 'like', { matchedTopics: [{ text: 'Birdwatching' }], treePath: TREE.aLotMore }, T0 - DAY + i * 1000);
    }
    await verdict('g0', 'like', { matchedTopics: [{ text: 'Ghosting' }], treePath: TREE.aLotMore }, T0 - DAY + 5000);
    await cycle();
    const plan = (await getPendingPlan())!;
    expect(Object.keys(plan.candidates).sort()).toEqual(['topic_up:birdwatching', 'topic_up:ghosting']);
    expect(plan.candidates['topic_up:birdwatching'].ops[0]).toEqual({
      action_type: 'set_topic_weight',
      topicText: 'Birdwatching',
      delta: 0.3,
    });

    // Before the accept the device mints two Birdwatching topics (and retires a third, the strongest of all).
    const weaker = await seedFact('Follows birds', [{ text: 'Birdwatching', weight: 0.4 }]);
    const stronger = await seedFact('Follows nature', [{ text: 'Birdwatching', weight: 0.6 }]);
    const gone = await seedFact('Used to follow birds', [{ text: 'Birdwatching', weight: 1, status: 'retired' }]);

    const res = await acceptPlan();

    expect(res.applied).toBe(true);
    expect(res.appliedOps).toBe(1);
    expect(res.errors).toEqual(['topic_up:ghosting: skipped invalid op set_topic_weight']);
    expect(await weightOf(stronger.fact.id, 'Birdwatching')).toBeCloseTo(0.9);
    expect(await weightOf(weaker.fact.id, 'Birdwatching')).toBeCloseTo(0.4);
    expect(await weightOf(gone.fact.id, 'Birdwatching')).toBeCloseTo(1);
    expect(await countUnprocessedFeedback()).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// The other candidate kinds, end to end
// ---------------------------------------------------------------------------------------------------
describe('what the model is told about a candidate', () => {
  it('names the entities of the stories behind it, liked and disliked apart, and the liked stories a removal would hit', async () => {
    const { climate } = await actionableDay();
    await verdict(
      'e1',
      'like',
      { matchedTopics: [{ topicId: climate.id, text: 'Climate' }], entities: [' IPCC ', '', 'Greta Thunberg'], treePath: TREE.aLotMore },
      T0 - DAY + 5000,
    );
    await verdict('e2', 'like', { eventType: 'obituary', treePath: TREE.seenOnly }, T0 - DAY + 6000);
    await verdict('e3', 'dislike', { eventType: 'obituary', entities: ['Local mayor'], treePath: TREE.kindOfEvent }, T0 - DAY + 7000);

    await cycle();

    const lines = promptLines(gatewayCalls()[0]);
    expect(lines).toContain(`[topic_up:${climate.id}] topic_up | Show more about "Climate" | about — liked: Greta Thunberg, IPCC`);
    const suppress = lines.find((l) => l.startsWith('[suppress:evt:obituary]'))!;
    expect(suppress).toContain('| conflicts: Story e2');
    expect(suppress).toContain('| about — disliked: Local mayor');
    // A removal that would hit a liked story is always a review item, and carries the conflict.
    expect((await getPendingPlan())!.reviewItems[0].conflictsWith).toEqual([{ title: 'Story e2', reason: 'You liked this story' }]);
  });
});

describe('retire, publication and failure paths on accept', () => {
  /** Three low-relevance dislikes on one topic: the digest proposes to retire it. */
  async function retireDay() {
    const { topics } = await seedFact('Follows cricket', [{ text: 'Cricket', weight: 0.5 }]);
    for (let i = 0; i < 3; i++) {
      await verdict(
        `r${i}`,
        'dislike',
        { matchedTopics: [{ topicId: topics[0].id, text: 'Cricket' }], relevance: 0.1, treePath: TREE.seenOnly },
        T0 - DAY + i * 1000,
      );
    }
    return topics[0];
  }

  it('retires the topic on the default option, through the executor', async () => {
    const cricket = await retireDay();
    await cycle();
    const plan = (await getPendingPlan())!;
    expect(plan.reviewItems.map((r) => r.fingerprint)).toContain(`retire_topic:${cricket.id}`);

    const res = await acceptPlan({ uncheckedAuto: plan.autoChanges.map((a) => a.fingerprint) });

    expect(res.errors).toEqual([]);
    expect((await getByFact(cricket.factId!)).find((t) => t.id === cricket.id)!.status).toBe('retired');
  });

  it('OWNER-D2 today: a gentler alternative to a retire turns into a down-weight of at most 0.5 (it must name retire_topic itself; a set_topic_weight one is dropped)', async () => {
    const cricket = await retireDay();
    reply((call) =>
      JSON.stringify({
        autoChanges: [],
        reviewItems: [
          {
            fingerprint: `retire_topic:${cricket.id}`,
            question: 'Drop cricket?',
            options: [
              { label: 'Drop it', action: 'apply' },
              { label: 'Lower it (dropped)', action: 'alternative', altOps: [{ action_type: 'set_topic_weight', delta: -0.2 }] },
              { label: 'Just lower it', action: 'alternative', altOps: [{ action_type: 'retire_topic', delta: -0.9 }] },
              { label: 'Raise it (dropped)', action: 'alternative', altOps: [{ action_type: 'retire_topic', delta: 0.2 }] },
              { label: 'No', action: 'skip' },
            ],
            defaultIndex: 0,
            rationale: '',
            seen: fingerprintsOf(call).length,
          },
        ],
      }),
    );
    await cycle();
    const item = (await getPendingPlan())!.reviewItems.find((r) => r.fingerprint === `retire_topic:${cricket.id}`)!;
    expect(item.options.map((o) => o.label)).toEqual(['Drop it', 'Just lower it', 'No']);
    expect(item.options[1].altOps).toEqual([{ action_type: 'set_topic_weight', topicId: cricket.id, topicText: 'Cricket', delta: -0.5 }]);

    await acceptPlan({ reviewChoices: { [item.fingerprint]: 1 }, uncheckedAuto: [] });

    const row = (await getByFact(cricket.factId!)).find((t) => t.id === cricket.id)!;
    expect(row.status).toBe('active');
    expect(row.weight).toBeLessThan(0.5);
  });

  it('turns "more from this publication" into a stored publication preference', async () => {
    for (let i = 0; i < 3; i++) {
      await verdict(`p${i}`, 'like', { publication: 'pub-42', treePath: ['publication', 'more_from_publication'] }, T0 - DAY + i * 1000);
    }
    await cycle();
    expect(Object.keys((await getPendingPlan())!.candidates)).toEqual(['publication_up:pub-42']);

    const res = await acceptPlan();

    expect(res).toEqual({ applied: true, appliedOps: 1, errors: [] });
    expect(await getPreferenceKind('pub-42')).toBe('boost');
  });

  it('reports an op the executor throws on, and still applies the rest and settles the plan', async () => {
    await actionableDay();
    await cycle();
    const spy = jest.spyOn(executor, 'applyPersonaAction').mockRejectedValueOnce(new Error('db locked'));

    const res = await acceptPlan();
    spy.mockRestore();

    expect(res.applied).toBe(true);
    expect(res.appliedOps).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(res.errors[0]).toMatch(/: apply failed$/);
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(await countUnprocessedFeedback()).toBe(0);
  });

  it('a corrupt rejected-fingerprint row is read as empty', async () => {
    await actionableDay();
    await setSetting('optimisation_rejected_fingerprints', '{not json');

    expect(await cycle()).toEqual({ ran: true, autoCount: 2, reviewCount: 1 });
  });
});

describe('what accept does when an op cannot change anything', () => {
  it('reports a nudge the rails refuse (the topic is already at the ceiling) and still settles the plan', async () => {
    const { topics } = await seedFact('Follows climate', [{ text: 'Climate', weight: 1 }]);
    for (let i = 0; i < 3; i++) {
      await verdict(`c${i}`, 'like', { matchedTopics: [{ topicId: topics[0].id, text: 'Climate' }], treePath: TREE.aLotMore }, T0 - DAY + i * 1000);
    }
    await cycle();

    const res = await acceptPlan();

    expect(res).toEqual({
      applied: true,
      appliedOps: 0,
      errors: [`topic_up:${topics[0].id}: Nudge budget exhausted; topic weight unchanged`],
    });
    expect(await getRecent()).toEqual([]);
    expect(await countUnprocessedFeedback()).toBe(0);
  });
});

describe('a verdict row whose stored context cannot be read', () => {
  // Rows the service itself never writes: an older build, or a damaged disk, left context_json that is not
  // an object. The digest must read them as context-free verdicts, not throw.
  const damaged = async (contextJson: string, ageDays: number) =>
    database.write(async () => {
      await database.get('article_feedback').create((r: any) => {
        r.articleId = `d-${contextJson}`;
        r.sentiment = 'dislike';
        r.title = 'Damaged';
        r.contextJson = contextJson;
        r.createdAt = new Date(T0 - ageDays * DAY);
        r.processedAt = null;
      });
    });

  it('treats null, a number and broken JSON as no context at all: nothing to propose, and stale rows are swept', async () => {
    for (const bad of ['null', '7', '{broken']) await damaged(bad, STALE_SIGNAL_MS / DAY + 5);

    const res = await cycle();

    expect(res).toEqual({ ran: true, reason: 'no_candidates', autoCount: 0, reviewCount: 0 });
    expect(await countUnprocessedFeedback()).toBe(0); // all three were read, found stale, and swept
    expect(logs.captureException).not.toHaveBeenCalled();
  });
});

describe('DA32: accepting a nudge for a topic the reader has since retired', () => {
  async function retiredBeforeAccept() {
    const { climate, space } = await actionableDay();
    await cycle();
    await retire(space.id);
    return { climate, space };
  }
  const logsFor = async (topicId: string) => (await getRecent()).filter((l) => JSON.parse(l.actionJson).targetId === topicId);

  test.failing('DA32: a nudge on a retired topic is not recorded as applied', async () => {
    const { space } = await retiredBeforeAccept();

    const res = await acceptPlan();

    expect(res.appliedOps).toBe(2);
    expect(res.errors).toHaveLength(1);
    expect(await logsFor(space.id)).toEqual([]);
  });

  it('DA32 today: a nudge on a retired topic is counted as applied, moves its weight, and writes a change-log row', async () => {
    const { space } = await retiredBeforeAccept();

    const res = await acceptPlan();

    expect(res).toEqual({ applied: true, appliedOps: 3, errors: [] });
    const row = (await getByFact(space.factId!)).find((t) => t.id === space.id)!;
    expect(row.status).toBe('retired');
    expect(row.weight).toBeCloseTo(0.8);
    expect(await logsFor(space.id)).toHaveLength(1);
  });
});

describe('dismissPlan', () => {
  it('remembers every fingerprint, processes the rows, applies nothing, and is a no-op with no plan', async () => {
    const { climate, space } = await actionableDay();
    await cycle();

    await dismissPlan();

    expect(JSON.parse((await getSetting('optimisation_rejected_fingerprints'))!).sort()).toEqual(
      [`topic_up:${climate.id}`, `topic_up:${space.id}`, 'suppress:evt:obituary'].sort(),
    );
    expect(await countUnprocessedFeedback()).toBe(0);
    expect(await getPendingPlan()).toBeNull();
    expect(await weightOf(climate.factId!, 'Climate')).toBeCloseTo(0.5);
    expect(await getSuppressions()).toHaveLength(0);
    expect(await getRecent()).toEqual([]);

    await dismissPlan(); // nothing pending any more
    expect(await getRecent()).toEqual([]);
  });
});
