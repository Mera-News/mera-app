// What the reader decides about hygiene proposals: accept (through the real persona-action executor and
// fact service, or the atomic generate-then-retire path), reject, the presentation cap with its backlog
// refill, the backfill's additive entry point, and the change notifier. Real in-memory DB and stores,
// the real analyzer, and the gateway mock (real E2EE). The sweep half is hygiene-sweep.test.ts.
//
// Replaces, with hygiene-sweep.test.ts, hygiene-service.test.ts (37 `it`). This file carries: accept
// routes a persona_action through the executor and clears it; accept routes a delete_fact through the
// fact service with a change-log row naming the statement; unknown id; reject remembers the fingerprint
// and the next sweep does not re-propose it; an incoherent accept retires nothing when generation fails;
// presentation cap, true outstanding total, immediate refill on reject, drain to empty, no-op under the
// cap; the incoherent happy path (whole proposal through the atomic path, retire logged, floor held is
// not-ok, a throwing path keeps the proposal, on-device needs the cloud); addSanityProposals (a
// corpus-wide pass cannot surface a wall, additive across chunks, rejected memory, empty no-op, notify
// only when asked, the notification stamps the outstanding total, also past the cap).
// Not carried: nothing. `mockGenerateAndReplace`, the mocked executor and fact service are the real ones.
import { deleteFact, getFacts, getFactSectionSnapshots } from '@/lib/database/services/fact-service';
import {
  acceptProposal,
  addSanityProposals,
  getPendingCount,
  getPendingProposals,
  rejectProposal,
  runHygieneSweep,
  subscribeHygieneChange,
  HYGIENE_PENDING_PRESENTATION_CAP,
} from '@/lib/database/services/hygiene-service';
import { getRecent } from '@/lib/database/services/persona-change-log-service';
import { runSanityAudit } from '@/lib/database/services/topic-sanity-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { getByFact } from '@/lib/database/services/topic-service';
import * as replacementService from '@/lib/database/services/topic-replacement-service';
import { ACTION_NAMES } from '@/lib/news-harness/persona-management/action-names';
import type { HygieneProposal } from '@/lib/news-harness/persona-management/fact-hygiene';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
} from '@/test/helpers';
import type { GatewayCall } from '@/test/helpers';

import {
  DAY,
  SUBJECTS,
  T0,
  isContaminated,
  quietLogger,
  resetCloudPersonaMemory,
  sanityModel,
  seedContaminated,
  seedFactOrdered,
  seedPersona,
  setMode,
  spyOnNotifications,
  systemMessage,
  userMessage,
} from './support';

const CRICKET = 'Follows the Indian national cricket team';
const BAD = 'Amsterdam cricket festival music tech';
const REPLACEMENT = 'Netherlands cricket diaspora broadcasts';

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;

/** The sanity model, plus a topic generator for the replacement call. */
const hygieneModel = (replacements: string[] = [REPLACEMENT]) => (call: GatewayCall) =>
  systemMessage(call).includes('combine the Fact') ? JSON.stringify(replacements) : sanityModel(isContaminated)(call);

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(hygieneModel()));
});
afterEach(() => {
  notified.restore();
  logs.restore();
});

const sweep = (opts: Parameters<typeof runHygieneSweep>[0] = { now: T0 }) => advanceUntilDone(runHygieneSweep(opts));
const accept = (id: string) => advanceUntilDone(acceptProposal(id));

describe('accept: invertible persona actions go through the executor', () => {
  it('downweights a too-broad fact, logs it as a digest change, clears the proposal and wakes subscribers', async () => {
    const [news] = await seedPersona(10);
    await sweep();
    const [proposal] = await getPendingProposals();
    expect(proposal.kind).toBe('too_broad_fact');
    const changed = jest.fn();
    const stop = subscribeHygieneChange(changed);

    const res = await accept(proposal.id);
    stop();

    expect(res).toEqual({ applied: true, ok: true });
    expect((await getFactSectionSnapshots()).find((f) => f.id === news.id)!.weight).toBeCloseTo(0.7);
    const log = await getRecent();
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ actionType: ACTION_NAMES.SET_FACT_WEIGHT, source: 'digest' });
    expect(await getPendingCount()).toBe(0);
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it('returns not-applied for an unknown id and changes nothing', async () => {
    await seedPersona(10);
    await sweep();
    const changed = jest.fn();
    const stop = subscribeHygieneChange(changed);

    expect(await accept('nope')).toEqual({ applied: false, ok: false });
    stop();

    expect(await getPendingCount()).toBe(1);
    expect(changed).not.toHaveBeenCalled();
  });
});

describe('accept: a destructive delete goes through the fact service', () => {
  /** Ten facts, two of which say the same thing. */
  async function withDuplicate() {
    jest.setSystemTime(T0 - 100 * DAY);
    const { addFact } = await import('@/lib/database/services/fact-service');
    const first = await addFact('Follows Indian cricket');
    jest.setSystemTime(T0 - 99 * DAY);
    const second = await addFact('Follows Indian cricket');
    for (const s of SUBJECTS.slice(1, 9)) await addFact(s);
    jest.setSystemTime(T0);
    return { first, second };
  }

  it('deletes the repeated fact, keeps the other, and logs the statement before it is gone', async () => {
    const { first, second } = await withDuplicate();
    await sweep();
    const proposal = (await getPendingProposals()).find((p) => p.kind === 'duplicate_facts')!;
    expect(proposal).toBeDefined();
    expect(proposal.invertible).toBe(false);
    const doomed = proposal.ops.find((op) => op.type === 'delete_fact') as { factId: string };
    expect([first.id, second.id]).toContain(doomed.factId);

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: true, ok: true });
    const remaining = (await getFacts()).map((f) => f.id);
    expect(remaining).not.toContain(doomed.factId);
    expect(remaining).toContain([first.id, second.id].find((id) => id !== doomed.factId));
    const log = (await getRecent()).filter((l) => l.actionType === ACTION_NAMES.HYGIENE_DELETE_FACT);
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe('digest');
    expect(JSON.parse(log[0].actionJson)).toEqual({ targetId: doomed.factId, statement: 'Follows Indian cricket' });
    expect((await getPendingProposals()).find((p) => p.id === proposal.id)).toBeUndefined();
  });

  it('an op that fails is reported not-ok, the proposal is still removed, and the failure is captured', async () => {
    await withDuplicate();
    await sweep();
    const proposal = (await getPendingProposals()).find((p) => p.kind === 'duplicate_facts')!;
    // The fact is already gone when the reader taps accept.
    const doomed = (proposal.ops.find((op) => op.type === 'delete_fact') as { factId: string }).factId;
    await deleteFact(doomed);

    const res = await accept(proposal.id);

    expect(res.applied).toBe(true);
    expect(res.ok).toBe(false);
    expect(logs.captureException).toHaveBeenCalled();
    expect((await getPendingProposals()).find((p) => p.id === proposal.id)).toBeUndefined();
  });
});

describe('reject', () => {
  it('remembers the fingerprint, drops it, and a forced re-sweep does not propose it again', async () => {
    await seedPersona(10);
    await sweep();
    const [proposal] = await getPendingProposals();
    const changed = jest.fn();
    const stop = subscribeHygieneChange(changed);

    await rejectProposal(proposal.id);
    stop();

    expect(await getPendingCount()).toBe(0);
    expect(JSON.parse((await getSetting('hygiene_rejected_fingerprints'))!)).toEqual([proposal.id]);
    expect(changed).toHaveBeenCalledTimes(1);

    const again = await sweep({ now: T0 + 10 * DAY, force: true });
    expect(again.proposalCount).toBe(0);
    expect(await getPendingProposals()).toEqual([]);
  });

  it('remembers a fingerprint once, and only the newest 200', async () => {
    await rejectProposal('same');
    await rejectProposal('same');
    expect(JSON.parse((await getSetting('hygiene_rejected_fingerprints'))!)).toEqual(['same']);

    for (let i = 0; i < 205; i++) await rejectProposal(`fp-${i}`);

    const kept = JSON.parse((await getSetting('hygiene_rejected_fingerprints'))!) as string[];
    expect(kept).toHaveLength(200);
    expect(kept[0]).toBe('fp-5');
    expect(kept[199]).toBe('fp-204');
  });
});

describe('subscribeHygieneChange', () => {
  it('stops calling a listener once it unsubscribes, and one throwing listener does not stop the rest', async () => {
    const calls: string[] = [];
    const stopBad = subscribeHygieneChange(() => {
      calls.push('bad');
      throw new Error('listener bug');
    });
    const stopGood = subscribeHygieneChange(() => calls.push('good'));

    await rejectProposal('a');
    stopBad();
    await rejectProposal('b');
    stopGood();
    await rejectProposal('c');

    expect(calls).toEqual(['bad', 'good', 'good']);
  });
});

describe('stored proposals are read defensively', () => {
  it('drops anything that is not a well-formed proposal, and unreadable JSON is an empty list', async () => {
    const ok = { id: 'x', kind: 'stale_fact', subject: { facts: [], topics: [] }, targetFactIds: [], targetTopicIds: [], ops: [], invertible: true };
    await setSetting('hygiene_pending_proposals', JSON.stringify([ok, { id: 7, ops: [] }, { id: 'no-ops' }, null, 'text']));
    expect((await getPendingProposals()).map((p) => p.id)).toEqual(['x']);

    await setSetting('hygiene_pending_proposals', '{not json');
    expect(await getPendingProposals()).toEqual([]);
    await setSetting('hygiene_pending_proposals', '{"id":"obj"}');
    expect(await getPendingProposals()).toEqual([]);
  });
});

describe('presentation cap and the backlog', () => {
  const TOTAL = HYGIENE_PENDING_PRESENTATION_CAP + 15;

  it('refills the window IMMEDIATELY on reject, not on the next sweep', async () => {
    await seedContaminated(TOTAL);
    await sweep();
    const before = await getPendingProposals();

    await rejectProposal(before[0].id);
    const after = await getPendingProposals();

    expect(after).toHaveLength(HYGIENE_PENDING_PRESENTATION_CAP);
    expect(after.map((p) => p.id)).not.toContain(before[0].id);
    expect(await getPendingCount()).toBe(TOTAL - 1);
  });

  it('deciding something that is not in the window leaves the full window alone', async () => {
    await seedContaminated(TOTAL);
    await sweep();
    const before = (await getPendingProposals()).map((p) => p.id);

    await rejectProposal('not-a-pending-proposal');

    expect((await getPendingProposals()).map((p) => p.id)).toEqual(before);
    expect(await getPendingCount()).toBe(TOTAL);
  });

  it('drains to empty without stranding backlog entries', async () => {
    await seedContaminated(13);
    await sweep();

    for (let guard = 0; guard < 40; guard += 1) {
      const [next] = await getPendingProposals();
      if (!next) break;
      await rejectProposal(next.id);
    }

    expect(await getPendingProposals()).toEqual([]);
    expect(await getPendingCount()).toBe(0);
  });

  it('is a no-op under the cap: nothing is parked, and deciding one leaves the others', async () => {
    await seedContaminated(3);
    await sweep();
    expect(await getPendingProposals()).toHaveLength(3);
    expect(await getPendingCount()).toBe(3);

    const [first] = await getPendingProposals();
    await rejectProposal(first.id);

    expect(await getPendingProposals()).toHaveLength(2);
  });
});

describe('addSanityProposals: the backfill entry point', () => {
  /** `n` facts with one contaminated topic each, as the verdicts the audit would hand back. */
  async function corpus(n: number) {
    const rows = await seedContaminated(n);
    return rows.map(({ fact, bad }) => ({ factId: fact.id, topicIds: [bad.id], fillTo: 3 }));
  }

  it('a corpus-wide pass cannot surface a wall of proposals', async () => {
    const verdicts = await corpus(15);

    const added = await addSanityProposals(verdicts);

    expect(added).toBe(15);
    expect(await getPendingProposals()).toHaveLength(HYGIENE_PENDING_PRESENTATION_CAP);
    expect(await getPendingCount()).toBe(15);
  });

  it('is additive across chunks and never duplicates a fingerprint', async () => {
    const verdicts = await corpus(6);

    await addSanityProposals(verdicts.slice(0, 3));
    await addSanityProposals(verdicts); // this chunk overlaps the previous one

    expect(await getPendingCount()).toBe(6);
    const ids = (await getPendingProposals()).map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('respects the rejected-fingerprint memory', async () => {
    const verdicts = await corpus(3);
    await rejectProposal(`incoherent_topics:${verdicts[0].factId}`);

    await addSanityProposals(verdicts);

    expect((await getPendingProposals()).map((p) => p.id)).not.toContain(`incoherent_topics:${verdicts[0].factId}`);
    expect(await getPendingCount()).toBe(2);
  });

  it('is a no-op for empty verdicts', async () => {
    expect(await addSanityProposals([], { notify: true })).toBe(0);
    expect(notified.calls()).toHaveLength(0);
  });

  it('notifies only when asked', async () => {
    const verdicts = await corpus(4);

    await addSanityProposals(verdicts.slice(0, 2), { notify: false });
    expect(notified.calls()).toHaveLength(0);

    await addSanityProposals(verdicts, { notify: true });
    expect(notified.calls()).toHaveLength(1);
  });

  it('stamps the outstanding total, not the number this call added', async () => {
    const verdicts = await corpus(2);
    await addSanityProposals(verdicts.slice(0, 1), { notify: false });

    const added = await addSanityProposals(verdicts, { notify: true });

    expect(added).toBe(1);
    expect(notified.calls()[0].context).toEqual({ count: 2 });
    expect(await getPendingCount()).toBe(2);
  });

  it('stamps the outstanding total past the presentation cap too', async () => {
    const verdicts = await corpus(15);

    expect(await addSanityProposals(verdicts, { notify: true })).toBe(15);

    expect(notified.calls()[0].context).toEqual({ count: 15 });
  });
});

describe('accept: an incoherent_topics proposal is one generate-then-retire unit', () => {
  /** The cricket fact (one contaminated, one good topic) inside a persona big enough for the full sweep. */
  async function contaminatedCricket() {
    await seedPersona(9);
    jest.setSystemTime(T0 - 100 * DAY);
    const { fact, topics } = await seedFactOrdered(CRICKET, [BAD, 'India cricket news', 'World Cup schedule']);
    jest.setSystemTime(T0);
    await sweep();
    const proposal = (await getPendingProposals()).find((p) => p.kind === 'incoherent_topics') as HygieneProposal;
    return { fact, bad: topics[0], good: topics[1], proposal };
  }

  /** The reader removes another topic of the fact after the sweep, so a replacement has room to be minted. */
  async function withRoomForReplacement() {
    const world = await contaminatedCricket();
    const { retire } = await import('@/lib/database/services/topic-service');
    await retire(world.good.id);
    return world;
  }
  const activeTexts = async (factId: string) =>
    (await getByFact(factId)).filter((t) => t.status === 'active').map((t) => t.text).sort();

  it('generates the replacement, then mints and retires in one unit; the whole proposal goes this way, not through the generic loop', async () => {
    const { fact, bad, proposal } = await withRoomForReplacement();
    const before = gatewayCalls('batch').length;

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: true, ok: true });
    const calls = gatewayCalls('batch').slice(before);
    expect(calls).toHaveLength(1); // ONE combo-only request, for the fact asked about
    expect(userMessage(calls[0])).toContain(CRICKET);
    expect(await activeTexts(fact.id)).toEqual(['World Cup schedule', REPLACEMENT].sort());
    expect((await getByFact(fact.id)).find((t) => t.id === bad.id)!.status).toBe('retired');
    // The retire is logged for the audit screen, once, as a digest change (the generic loop would log it twice or not at all).
    const log = (await getRecent()).filter((l) => l.actionType === ACTION_NAMES.RETIRE_TOPIC);
    expect(log).toHaveLength(1);
    expect(log[0].source).toBe('digest');
    expect(JSON.parse(log[0].actionJson)).toEqual({ targetId: bad.id });
    expect((await getPendingProposals()).find((p) => p.id === proposal.id)).toBeUndefined();
  });

  it('retires NOTHING when the replacement request fails: the proposal stays for another tap', async () => {
    const { fact, bad, proposal } = await withRoomForReplacement();
    server.use(
      ...mockGateway((call) =>
        systemMessage(call).includes('combine the Fact') ? { status: 400, body: { error: 'refused' } } : hygieneModel()(call),
      ),
    );

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: false, ok: false });
    expect((await getByFact(fact.id)).find((t) => t.id === bad.id)!.status).toBe('active');
    expect(await getRecent()).toEqual([]);
    expect((await getPendingProposals()).map((p) => p.id)).toContain(proposal.id);
    expect(logs.warn).toHaveBeenCalledWith(
      expect.stringContaining('replacement generation failed'),
      expect.objectContaining({ proposalId: proposal.id }),
    );
  });

  it('leaves the proposal pending and reports it when the replacement path throws', async () => {
    const { proposal } = await contaminatedCricket();
    const spy = jest.spyOn(replacementService, 'generateAndReplace').mockRejectedValueOnce(new Error('boom'));

    const res = await accept(proposal.id);
    spy.mockRestore();

    expect(res).toEqual({ applied: false, ok: false });
    expect((await getPendingProposals()).map((p) => p.id)).toContain(proposal.id);
    expect(logs.captureException).toHaveBeenCalledTimes(1);
    expect(logs.captureException.mock.calls[0][1]).toMatchObject({
      tags: { service: 'hygiene-service', method: 'acceptProposal.incoherent' },
    });
  });

  it('on-device: nothing runs, the proposal stays pending and the caller is told it needs the cloud', async () => {
    const { fact, proposal } = await contaminatedCricket();
    await setMode('on-device');
    const before = gatewayCalls().length;

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: false, ok: false, needsCloud: true });
    expect(gatewayCalls()).toHaveLength(before);
    expect(await activeTexts(fact.id)).toHaveLength(3);
    expect((await getPendingProposals()).map((p) => p.id)).toContain(proposal.id);
  });

  it('refills the window from the backlog after an accept settles a proposal', async () => {
    const rows = await seedContaminated(HYGIENE_PENDING_PRESENTATION_CAP + 2);
    await sweep();
    const [first] = await getPendingProposals();

    await accept(first.id);

    expect(await getPendingProposals()).toHaveLength(HYGIENE_PENDING_PRESENTATION_CAP);
    expect(await getPendingCount()).toBe(rows.length - 1);
  });

  // The floor: a fact whose ONLY topics are contaminated would go dark, so the retire is withheld.
  it('reports NOT-ok when the floor withheld the retire, and logs nothing', async () => {
    const [{ fact, bad }] = await seedContaminated(1);
    await sweep({ now: T0 });
    const [proposal] = await getPendingProposals();

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: true, ok: false });
    expect((await getByFact(fact.id)).find((t) => t.id === bad.id)!.status).toBe('active');
    expect(await getRecent()).toEqual([]);
  });

  // DATA-U11b-6 (OWNER): the same accept REMOVES the proposal although nothing was cleaned, and the audit
  // cursor has moved past the topic, so no sweep proposes it again. The screen's "retry" toast has nothing
  // to retry. Pinned, not judged.
  it('OWNER-D1 today: a floor-held accept still removes the proposal, so the contaminated topic is never offered again', async () => {
    await seedContaminated(1);
    await sweep({ now: T0 });
    const [proposal] = await getPendingProposals();

    await accept(proposal.id);

    expect(await getPendingProposals()).toEqual([]);
    expect((await sweep({ now: T0 + 30 * DAY })).proposalCount).toBe(0);
  });

  // DA29 (DATA-U11b-5): the audit hands the proposal `fillTo` = the fact's active-topic count BEFORE the
  // retire. generateAndReplace asks for `fillTo - active` replacements, and active still includes the topics
  // about to go, so the headroom is 0 and no request is ever made. "Replace, don't just delete" deletes.
  // Reached the way the backfill reaches it: the real audit's verdicts (its own `fillTo`) go through
  // addSanityProposals, and the reader accepts the stored proposal. Nothing is hand-fed.
  async function proposalFromTheBackfillPath() {
    await seedPersona(9);
    jest.setSystemTime(T0 - 100 * DAY);
    const { fact, topics } = await seedFactOrdered(CRICKET, [BAD, 'India cricket news', 'World Cup schedule']);
    jest.setSystemTime(T0);
    const audit = await advanceUntilDone(
      runSanityAudit({ facts: (await getFacts()).map((f) => ({ id: f.id, statement: f.statement })) }),
    );
    expect(audit.incoherentFacts).toEqual([{ factId: fact.id, topicIds: [topics[0].id], fillTo: 3 }]);
    expect(await addSanityProposals(audit.incoherentFacts)).toBe(1);
    const [proposal] = await getPendingProposals();
    expect(proposal.id).toBe(`incoherent_topics:${fact.id}`);
    return { fact, bad: topics[0], proposal };
  }

  test.failing('DA29: accepting a proposal from the backfill path restores the fact to the coverage it had, with a minted replacement', async () => {
    const { fact, proposal } = await proposalFromTheBackfillPath();

    await accept(proposal.id);

    const active = await activeTexts(fact.id);
    expect(active).toHaveLength(3);
    expect(active).toContain(REPLACEMENT);
  });

  it('DA29 today: accepting a proposal from the backfill path makes no replacement request, and the fact ends one topic short', async () => {
    const { fact, bad, proposal } = await proposalFromTheBackfillPath();
    const before = gatewayCalls().length;

    const res = await accept(proposal.id);

    expect(res).toEqual({ applied: true, ok: true });
    expect(gatewayCalls()).toHaveLength(before);
    expect(await activeTexts(fact.id)).toEqual(['India cricket news', 'World Cup schedule']);
    expect((await getByFact(fact.id)).find((t) => t.id === bad.id)!.status).toBe('retired');
  });
});
