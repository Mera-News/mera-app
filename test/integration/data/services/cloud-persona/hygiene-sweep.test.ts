// The weekly persona hygiene sweep: its gates, the ONE billed cloud batch (the topic-sanity audit), the
// proposals it stores and presents, and the single notification. Real in-memory DB and stores, the real
// analyzer and audit, and the gateway mock (real E2EE). The accept / reject half is hygiene-decisions.test.ts.
//
// Replaces, with hygiene-decisions.test.ts, hygiene-service.test.ts (37 `it`). This file carries: skips
// on too few facts, a young persona, the cooldown, and `force` bypasses it; stores proposals and fires ONE
// notification with the count; no notification with no proposals; the sanity audit runs before the size
// and age gates and publishes even for one fact; still zero when the audit found nothing; the early
// returns stamp the cooldown; a credential-less audit WITHHOLDS the stamp; a timed-out or refused audit
// DOES stamp; a publish that throws does not stamp; never a second notification; completes when the audit
// fails or hangs past SANITY_RACE_MS; the presentation cap and the true outstanding total (sweep half).
// Not carried: nothing. The mocked sanity service, executor and settings are the real ones.
import {
  HYGIENE_PENDING_PRESENTATION_CAP,
  MIN_FACTS_FOR_SWEEP,
  MIN_PERSONA_AGE_MS,
  SANITY_RACE_MS,
  SWEEP_COOLDOWN_MS,
  getPendingCount,
  getPendingProposals,
  rejectProposal,
  runHygieneSweep,
  subscribeHygieneChange,
} from '@/lib/database/services/hygiene-service';
import { getAll as getNotifications } from '@/lib/database/services/notification-service';
import * as sanityService from '@/lib/database/services/topic-sanity-service';
import * as settingService from '@/lib/database/services/setting-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { addFact } from '@/lib/database/services/fact-service';
import { SANITY_MAX_TOPICS_PER_SWEEP } from '@/lib/news-harness/persona-management/topic-sanity';
import { TOPIC_SANITY_SYSTEM_PROMPT } from '@/lib/news-harness/prompts/prompts';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';

import {
  DAY,
  T0,
  isContaminated,
  loseCredential,
  quietLogger,
  resetCloudPersonaMemory,
  sanityItems,
  sanityModel,
  sanityTexts,
  seedContaminated,
  seedFact,
  seedFactOrdered,
  seedPersona,
  seedTopicsOverTime,
  setMode,
  spyOnNotifications,
  systemMessage,
  userMessage,
} from './support';

const STAMP = 'hygiene_last_sweep_at';
const CRICKET = 'Follows the Indian national cricket team';
const BAD = 'Amsterdam cricket festival music tech';

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(sanityModel(isContaminated)));
});
afterEach(() => {
  notified.restore();
  logs.restore();
});

const sweep = (opts: Parameters<typeof runHygieneSweep>[0] = { now: T0 }) => advanceUntilDone(runHygieneSweep(opts));
/** A persona of `count - 1` plain facts plus the cricket fact owning one contaminated and one good topic. */
async function cricketPersona(count: number, ageDays = 100) {
  await seedPersona(count - 1, ageDays);
  jest.setSystemTime(T0 - ageDays * DAY);
  const world = await seedFact(CRICKET, [BAD, 'India cricket news']);
  jest.setSystemTime(T0);
  return world;
}

describe('the sweep gates', () => {
  it('too few facts: no cleanup is proposed, the reason is reported, and the cooldown is stamped', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP - 1);

    const res = await sweep();

    expect(res).toEqual({ ran: false, reason: 'too_few_facts', proposalCount: 0, sanitySkipped: false });
    expect(await getPendingProposals()).toEqual([]);
    expect(notified.calls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBe(String(T0));
  });

  it('exactly the minimum number of facts is swept', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);

    expect(await sweep()).toMatchObject({ ran: true });
  });

  it('a persona younger than a week gets no cleanup; one exactly a week old does', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP, 2);
    const young = await sweep();
    expect(young).toMatchObject({ ran: false, reason: 'persona_too_young', proposalCount: 0 });
    expect(await getPendingProposals()).toEqual([]);
    expect(await getSetting(STAMP)).toBe(String(T0));

    const ripe = await sweep({ now: T0 + MIN_PERSONA_AGE_MS - 2 * DAY, force: true });
    expect(ripe).toMatchObject({ ran: true, proposalCount: 1 });
  });

  it('inside the cooldown it does nothing (no model, no new proposals) and reports the outstanding count; it runs from 6 days on', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);
    await sweep({ now: T0 });
    expect(await getPendingCount()).toBe(1);
    const callsBefore = gatewayCalls().length;

    const early = await sweep({ now: T0 + SWEEP_COOLDOWN_MS - 1 });
    expect(early).toEqual({ ran: false, reason: 'cooldown', proposalCount: 1 });
    expect(gatewayCalls()).toHaveLength(callsBefore);
    expect(await getSetting(STAMP)).toBe(String(T0));

    expect((await sweep({ now: T0 + SWEEP_COOLDOWN_MS })).ran).toBe(true);
  });

  it('`force` bypasses the cooldown', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);
    await setSetting(STAMP, String(T0 - DAY));

    expect(await sweep({ now: T0 })).toMatchObject({ ran: false, reason: 'cooldown' });
    expect((await sweep({ now: T0, force: true })).ran).toBe(true);
  });
});

describe('the proposals and the one notification', () => {
  it('stores the proposals and fires ONE hygiene notification stamped with the outstanding count, then the cooldown', async () => {
    const [news] = await seedPersona(MIN_FACTS_FOR_SWEEP);
    const changed = jest.fn();
    const stop = subscribeHygieneChange(changed);

    const res = await sweep();
    stop();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: false });
    const pending = await getPendingProposals();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: 'too_broad_fact', targetFactIds: [news.id], invertible: true });
    expect(pending[0].ops).toEqual([{ type: 'persona_action', action: { action_type: 'set_fact_weight', factId: news.id, delta: -0.3 } }]);
    expect(notified.calls()).toEqual([
      {
        type: 'hygiene',
        source: 'hygiene',
        title: 'hygiene.notificationTitle',
        body: 'hygiene.notificationBody',
        icon: 'cleaning-services',
        context: { count: 1 },
        actions: [{ id: 'review-hygiene', labelKey: 'hygiene.reviewChip' }],
      },
    ]);
    expect((await getNotifications()).map((n) => n.type)).toEqual(['hygiene']);
    expect(await getSetting(STAMP)).toBe(String(T0));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('no proposals: no notification, but the sweep ran and the cooldown is stamped', async () => {
    jest.setSystemTime(T0 - 100 * DAY);
    for (let i = 0; i < MIN_FACTS_FOR_SWEEP; i++) await addFact(`a distinct multi word interest ${i}`);
    jest.setSystemTime(T0);

    const res = await sweep();

    expect(res).toEqual({ ran: true, proposalCount: 0, sanitySkipped: false });
    expect(notified.calls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBe(String(T0));
  });

  it('shows at most the presentation cap, parks the rest, and the notification and count carry the TRUE total', async () => {
    const total = HYGIENE_PENDING_PRESENTATION_CAP + 15;
    await seedContaminated(total);

    const res = await sweep();

    expect(res.proposalCount).toBe(total);
    expect(await getPendingProposals()).toHaveLength(HYGIENE_PENDING_PRESENTATION_CAP);
    expect(await getPendingCount()).toBe(total);
    expect(notified.calls()).toHaveLength(1);
    expect(notified.calls()[0].context).toEqual({ count: total });
  });
});

describe('the billed batch: what the audit sends', () => {
  it('sends ONE batch request: the sanity system prompt, each fact followed by its active auditable topics numbered', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);
    await seedFactOrdered(CRICKET, [
      { text: 'India cricket news' },
      { text: BAD },
      { text: 'a topic the reader typed', provenance: 'user' },
      { text: 'a topic of a followed story', provenance: 'tracked' },
      { text: 'a retired topic', status: 'retired' },
      { text: 'a suppressed topic', status: 'suppressed' },
    ]);
    await seedFact('Facts with no topics at all', []);

    await sweep();

    const calls = gatewayCalls('batch');
    expect(calls).toHaveLength(1);
    expect(systemMessage(calls[0])).toBe(TOPIC_SANITY_SYSTEM_PROMPT);
    expect(userMessage(calls[0])).toBe(
      [`Fact: "${CRICKET}"`, '1. "India cricket news"', `2. "${BAD}"`, '', 'Return exactly 2 verdicts.'].join('\n'),
    );
  });

  it('judges at most the oldest SANITY_MAX_TOPICS_PER_SWEEP topics, in prompts of 15', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);
    const fact = await addFact(CRICKET);
    await seedTopicsOverTime(fact.id, SANITY_MAX_TOPICS_PER_SWEEP + 10, { startMs: T0 - 50 * DAY, stepMs: 1000 });
    jest.setSystemTime(T0);

    await sweep();

    const calls = gatewayCalls('batch');
    expect(calls).toHaveLength(SANITY_MAX_TOPICS_PER_SWEEP / 15);
    expect(sanityTexts(calls)).toEqual(Array.from({ length: SANITY_MAX_TOPICS_PER_SWEEP }, (_, i) => `cricket topic ${i}`));
  });

  it('a persona with no topics bills nothing', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);

    await sweep();

    expect(gatewayCalls()).toHaveLength(0);
  });

  it('turns the model verdicts into one proposal per fact: generate replacements first, then the retires', async () => {
    const { fact, topics } = await cricketPersona(MIN_FACTS_FOR_SWEEP);

    const res = await sweep();

    expect(res.proposalCount).toBe(2); // the contaminated topics, and "News"
    const proposal = (await getPendingProposals()).find((p) => p.kind === 'incoherent_topics')!;
    expect(proposal.id).toBe(`incoherent_topics:${fact.id}`);
    expect(proposal.targetTopicIds).toEqual([topics[0].id]);
    expect(proposal.ops).toEqual([
      { type: 'generate_replacements', factId: fact.id, fillTo: 2 },
      { type: 'persona_action', action: { action_type: 'retire_topic', topicId: topics[0].id } },
    ]);
    expect(notified.calls()).toHaveLength(1); // cleanups and verdicts share ONE notification
    expect(notified.calls()[0].context).toEqual({ count: 2 });
  });
});

describe('the audit runs before the size and age gates', () => {
  it('publishes contamination for a persona far too small to clean, with the gate reason preserved', async () => {
    jest.setSystemTime(T0 - 100 * DAY);
    const { fact } = await seedFact(CRICKET, [BAD]);
    jest.setSystemTime(T0);

    const res = await sweep();

    expect(res).toEqual({ ran: false, reason: 'too_few_facts', proposalCount: 1, sanitySkipped: false });
    expect((await getPendingProposals()).map((p) => p.id)).toEqual([`incoherent_topics:${fact.id}`]);
    expect(notified.calls()).toHaveLength(1);
    expect(notified.calls()[0].context).toEqual({ count: 1 });
    expect(await getSetting(STAMP)).toBe(String(T0));
  });

  it('does the same for a persona younger than a week, and publishes only the contamination kind', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP, 2);

    const res = await sweep();

    expect(res).toMatchObject({ ran: false, reason: 'persona_too_young', proposalCount: 1 });
    expect((await getPendingProposals()).map((p) => p.kind)).toEqual(['incoherent_topics']); // "News" is withheld
  });

  it('still reports zero, and stamps, when every verdict is for a proposal the reader already rejected', async () => {
    jest.setSystemTime(T0 - 100 * DAY);
    const { fact } = await seedFact(CRICKET, [BAD]);
    jest.setSystemTime(T0);
    await rejectProposal(`incoherent_topics:${fact.id}`);

    const res = await sweep();

    expect(res).toEqual({ ran: false, reason: 'too_few_facts', proposalCount: 0, sanitySkipped: false });
    expect(notified.calls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBe(String(T0));
  });

  it('still reports zero when the audit found nothing and the gate bails', async () => {
    await seedFact(CRICKET, ['India cricket news']);

    const res = await sweep();

    expect(res).toEqual({ ran: false, reason: 'too_few_facts', proposalCount: 0, sanitySkipped: false });
    expect(await getPendingProposals()).toEqual([]);
    expect(notified.calls()).toHaveLength(0);
  });
});

describe('a credential lost mid-run: skipped, not "ran and found nothing"', () => {
  it('withholds the cooldown stamp, still publishes the cleanups, and makes no request', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    await loseCredential();

    const res = await sweep();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: true });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBeNull();
    expect((await getPendingProposals()).map((p) => p.kind)).toEqual(['too_broad_fact']);
    expect(notified.calls()).toHaveLength(1);
    // A breadcrumb, not an error: a missing keypair is a state.
    expect(logs.captureException).not.toHaveBeenCalled();
    expect(logs.addBreadcrumb).toHaveBeenCalledWith(
      expect.stringContaining('sanity audit skipped'),
      'topic-sanity-service',
      { method: 'runSanityAudit' },
      'info',
    );
  });

  it('the next scheduled sweep re-attempts the audit instead of waiting out a week it never used', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    await loseCredential();
    await sweep({ now: T0 });
    await signInFixtureAccount();

    const retry = await sweep({ now: T0 + 60_000 });

    expect(retry.sanitySkipped).toBe(false);
    expect(gatewayCalls('batch')).toHaveLength(1);
    expect(await getSetting(STAMP)).toBe(String(T0 + 60_000));
    expect((await getPendingProposals()).map((p) => p.kind).sort()).toEqual(['incoherent_topics', 'too_broad_fact']);
  });

  it('a too-small persona also withholds the stamp', async () => {
    await seedFact(CRICKET, [BAD]);
    await loseCredential();

    const res = await sweep();

    expect(res).toEqual({ ran: false, reason: 'too_few_facts', proposalCount: 0, sanitySkipped: true });
    expect(await getSetting(STAMP)).toBeNull();
  });

  it('on-device mode is the same skip: no request, the stamp withheld, the cleanups still published', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    await setMode('on-device');

    const res = await sweep();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: true });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await getSetting(STAMP)).toBeNull();
  });

  it('on-device by the persisted row alone is the same skip', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    await setSetting('mera_processing_mode', 'ON_DEVICE');

    expect((await sweep()).sanitySkipped).toBe(true);
    expect(gatewayCalls()).toHaveLength(0);
  });
});

describe('an attempted audit that gave no verdicts is NOT a skip', () => {
  it('a refused gateway call still stamps the cooldown (it was attempted, possibly billed) and the sweep completes', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));

    const res = await sweep();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: false });
    expect(await getSetting(STAMP)).toBe(String(T0));
    expect((await getPendingProposals()).map((p) => p.kind)).toEqual(['too_broad_fact']);
  });

  it('an audit that hangs past SANITY_RACE_MS is raced out: the sweep completes at the window, as "attempted"', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    server.use(...mockGateway(() => ({ chunks: ['[]'], headerDelayMs: 10 * SANITY_RACE_MS })));
    const started = Date.now();

    const res = await sweep();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: false });
    expect(Date.now() - started).toBeGreaterThanOrEqual(SANITY_RACE_MS);
    expect(Date.now() - started).toBeLessThan(SANITY_RACE_MS + 10_000);
    expect(await getSetting(STAMP)).toBe(String(T0));
    expect((await getPendingProposals()).map((p) => p.kind)).toEqual(['too_broad_fact']);
  });

  it('an audit that rejects outright is treated as "attempted, found nothing": the sweep completes and stamps', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    const spy = jest.spyOn(sanityService, 'runSanityAudit').mockRejectedValueOnce(new Error('audit blew up'));

    const res = await sweep();
    spy.mockRestore();

    expect(res).toEqual({ ran: true, proposalCount: 1, sanitySkipped: false });
    expect(await getSetting(STAMP)).toBe(String(T0));
  });

  it('does NOT stamp the cooldown when publishing throws, so the retry is not read as "cooldown"', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);
    const real = settingService.setSetting;
    const spy = jest.spyOn(settingService, 'setSetting').mockImplementation(async (key, value) => {
      if (key === 'hygiene_pending_proposals') throw new Error('disk full');
      return real(key, value);
    });

    await expect(sweep({ now: T0, force: true })).rejects.toThrow('disk full');
    spy.mockRestore();

    expect(await getSetting(STAMP)).toBeNull();
    expect((await sweep({ now: T0 + 1000 })).ran).toBe(true);
  });

  it('never fires a SECOND notification: one sweep publishes once, cleanups and verdicts together', async () => {
    await cricketPersona(MIN_FACTS_FOR_SWEEP);

    await sweep();

    expect(notified.calls()).toHaveLength(1);
  });
});

describe('verdict plumbing', () => {
  it('numbers the prompt from 1 and a verdict maps back to the topic at that position', async () => {
    await seedPersona(MIN_FACTS_FOR_SWEEP);
    const { fact, topics } = await seedFactOrdered(CRICKET, ['India cricket news', BAD, 'World Cup schedule']);
    server.use(...mockGateway((call) => JSON.stringify(sanityItems(call).map((i) => ({ i: i.n, ok: i.n !== 3 })))));

    await sweep();

    const proposal = (await getPendingProposals()).find((p) => p.kind === 'incoherent_topics')!;
    expect(proposal.id).toBe(`incoherent_topics:${fact.id}`);
    expect(proposal.targetTopicIds).toEqual([topics[2].id]);
  });
});
