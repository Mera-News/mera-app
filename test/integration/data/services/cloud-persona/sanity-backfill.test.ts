// The one-time topic-sanity backfill (r12 K-P5), on the real in-memory DB, the real topic-sanity audit,
// the real hygiene queue and the gateway mock (real E2EE).
//
// The two failure modes the pass must not have: re-running from scratch on every launch (re-audits and
// re-bills the corpus), and marking itself done having processed half of it (leaves the contamination
// behind a flag that says it is finished).
//
// Replaces sanity-backfill-service.test.ts (15 `it`). Carried: resets the cursor on the first run; does
// not reset it again; audits in bounded chunks; no facts neither starts nor finishes the pass; not done
// while chunks return work; done only when a chunk finds nothing left; a chunk that fails is not done
// (as DATA-U11b-1 and -2: runSanityAudit never rejects, so the legacy "audit throws" case cannot occur,
// and the real failures leave the pass open); resumes without rewinding; stops at the hard
// ceiling; every call after completion is cheap; verdicts go through the capped queue; notifies once for
// the whole pass; does not consume the notification when nothing was added; skips the queue when a
// chunk finds nothing wrong; on-device skips before touching any state.
// Not carried: nothing. `mockRunSanityAudit` and `mockAddSanityProposals` are replaced by the real audit
// and the real queue, so the assertions read stored settings, stored proposals and recorded gateway calls.
import { addFact } from '@/lib/database/services/fact-service';
import { getPendingCount, getPendingProposals, rejectProposal } from '@/lib/database/services/hygiene-service';
import {
  BACKFILL_CHUNK_TOPICS,
  SANITY_BACKFILL_MAX_TOPICS,
  isBackfillDone,
  runSanityBackfillChunk,
} from '@/lib/database/services/sanity-backfill-service';
import * as settingService from '@/lib/database/services/setting-service';
import { getSetting, setSetting } from '@/lib/database/services/setting-service';
import { SANITY_BATCH_SIZE } from '@/lib/news-harness/persona-management/topic-sanity';
import {
  advanceUntilDone,
  gatewayCalls,
  mockGateway,
  server,
  signInFixtureAccount,
  useFakeClock,
  useStrictClock as strictClockAt, // aliased: a use* name inside a plain function trips react-hooks/rules-of-hooks
} from '@/test/helpers';

import {
  T0,
  loseCredential,
  quietLogger,
  resetCloudPersonaMemory,
  sanityItems,
  sanityModel,
  sanityTexts,
  seedTopics,
  seedTopicsOverTime,
  setMode,
  spyOnNotifications,
} from './support';

const CURSOR = 'sanity_audited_through_ms';
const STARTED = 'sanity_backfill_started_at';
const DONE = 'sanity_backfill_done_at';
const AUDITED = 'sanity_backfill_audited_count';
const NOTIFIED = 'sanity_backfill_notified';
const BAD = 'Amsterdam cricket festival music tech';

let logs: ReturnType<typeof quietLogger>;
let notified: ReturnType<typeof spyOnNotifications>;

beforeEach(async () => {
  logs = quietLogger();
  notified = spyOnNotifications();
  resetCloudPersonaMemory();
  await signInFixtureAccount();
  useFakeClock(T0);
  server.use(...mockGateway(sanityModel()));
});
afterEach(() => {
  notified.restore();
  logs.restore();
});

let tick = 0;
/** One scheduler tick. `now` moves on each call so the stamps are told apart. */
const chunk = () => advanceUntilDone(runSanityBackfillChunk({ now: T0 + 1_000_000 + ++tick * 1000 }));
beforeEach(() => {
  tick = 0;
});
const nowOf = (n: number) => T0 + 1_000_000 + n * 1000;

/** A fact with `count` topics, 10 ms apart; topic i reads `cricket topic i`. */
async function seedCorpus(count: number, opts: { fact?: string; startMs?: number; text?: (i: number) => string } = {}) {
  const fact = await addFact(opts.fact ?? 'Follows Indian cricket');
  const rows = await seedTopicsOverTime(fact.id, count, opts);
  return { fact, rows };
}

const topicNumber = (text: string) => Number(text.replace('cricket topic ', ''));

describe('starting the pass and walking the corpus', () => {
  it('audits the OLDEST 60 topics in one batch request of 15-topic prompts and moves the cursor to the 60th', async () => {
    await seedCorpus(150);

    const res = await chunk();

    expect(res).toEqual({ ran: true, audited: BACKFILL_CHUNK_TOPICS, proposalsAdded: 0, done: false });
    const calls = gatewayCalls('batch');
    expect(calls).toHaveLength(BACKFILL_CHUNK_TOPICS / SANITY_BATCH_SIZE);
    expect(sanityTexts(calls)).toEqual(Array.from({ length: 60 }, (_, i) => `cricket topic ${i}`));
    expect(await getSetting(CURSOR)).toBe(String(T0 + 59 * 10));
    expect(await getSetting(AUDITED)).toBe('60');
    expect(await getSetting(STARTED)).toBe(String(nowOf(1)));
    expect(await isBackfillDone()).toBe(false);
  });

  it('resets the audit cursor on the FIRST run, so topics the weekly sweep already judged are re-judged', async () => {
    await seedCorpus(150);
    await setSetting(CURSOR, String(T0 + 100_000)); // the weekly sweep had already walked past every topic

    await chunk();

    expect(sanityTexts(gatewayCalls('batch'))[0]).toBe('cricket topic 0');
    expect(await getSetting(CURSOR)).toBe(String(T0 + 59 * 10));
  });

  it('does NOT rewind on later runs: the second chunk continues where the first stopped', async () => {
    await seedCorpus(150);

    await chunk();
    const afterFirst = gatewayCalls('batch').length;
    await chunk();

    // Failure mode 1: a relaunch must not rewind and re-audit from scratch.
    expect(sanityTexts(gatewayCalls('batch').slice(afterFirst))).toEqual(
      Array.from({ length: 60 }, (_, i) => `cricket topic ${60 + i}`),
    );
    expect(await getSetting(STARTED)).toBe(String(nowOf(1)));
    expect(await getSetting(CURSOR)).toBe(String(T0 + 119 * 10));
    expect(await getSetting(AUDITED)).toBe('120');
  });

  it('is done only when a chunk finds nothing left to audit, and the flag flips exactly once', async () => {
    await seedCorpus(150);

    const outcomes = [];
    const doneAfter = [];
    for (let i = 0; i < 4; i++) {
      outcomes.push(await chunk());
      doneAfter.push(await isBackfillDone());
    }

    expect(outcomes.map((o) => o.audited)).toEqual([60, 60, 30, 0]);
    expect(outcomes.map((o) => o.done)).toEqual([false, false, false, true]);
    expect(doneAfter).toEqual([false, false, false, true]);
    expect(await getSetting(DONE)).toBe(String(nowOf(4)));
    expect(await getSetting(AUDITED)).toBe('150');
    // The empty chunk asked no model: 60 + 60 + 30 topics are 4 + 4 + 2 prompts.
    expect(gatewayCalls('batch')).toHaveLength(10);

    // Every call after completion is a settings read: no model, no stamp rewritten.
    const callsBefore = gatewayCalls().length;
    const again = await chunk();
    expect(again).toEqual({ ran: false, reason: 'already_done', audited: 0, proposalsAdded: 0, done: false });
    expect(gatewayCalls()).toHaveLength(callsBefore);
    expect(await getSetting(DONE)).toBe(String(nowOf(4)));
  });

  // The pass has judged 540 topics (nine chunks) when the chunk under test starts: the counter is the
  // service's own persisted state, so seeding it reaches the ceiling without minting 600 topics.
  it('stops at the hard ceiling rather than running unbounded, leaving the rest to the weekly rhythm', async () => {
    await seedCorpus(70);
    await setSetting(AUDITED, String(SANITY_BACKFILL_MAX_TOPICS - BACKFILL_CHUNK_TOPICS));

    const last = await chunk();

    expect(last).toMatchObject({ ran: true, audited: BACKFILL_CHUNK_TOPICS, done: true });
    expect(await isBackfillDone()).toBe(true);
    expect(await getSetting(AUDITED)).toBe(String(SANITY_BACKFILL_MAX_TOPICS));
    // Topics beyond the chunk were left alone: the pass ends with them unjudged.
    expect(new Set(sanityTexts(gatewayCalls('batch')).map(topicNumber)).size).toBe(BACKFILL_CHUNK_TOPICS);
    expect((await chunk()).reason).toBe('already_done');
  });

  it('one topic short of the ceiling the pass is still open', async () => {
    await seedCorpus(70);
    await setSetting(AUDITED, String(SANITY_BACKFILL_MAX_TOPICS - BACKFILL_CHUNK_TOPICS - 1));

    const res = await chunk();

    expect(res).toMatchObject({ audited: BACKFILL_CHUNK_TOPICS, done: false });
    expect(await isBackfillDone()).toBe(false);
  });

  it('with no facts it neither audits nor finishes, and a later fact starts the pass normally', async () => {
    const res = await chunk();

    expect(res).toMatchObject({ ran: false, reason: 'no_facts', done: false });
    expect(await isBackfillDone()).toBe(false);
    expect(gatewayCalls()).toHaveLength(0);

    await seedCorpus(5);
    expect(await chunk()).toMatchObject({ ran: true, audited: 5, done: false });
  });
});

describe('proposals and the one notification', () => {
  /** Three facts of 60 topics each, one contaminated topic apiece: each chunk judges exactly one fact. */
  async function threeFacts() {
    const facts = [];
    for (let f = 0; f < 3; f++) {
      const fact = await addFact(`Follows Indian cricket ${f}`);
      await seedTopicsOverTime(fact.id, 60, {
        startMs: T0 + f * 10_000,
        text: (i) => (i === 5 ? `${BAD} ${f}` : `cricket topic ${f}-${i}`),
      });
      facts.push(fact);
    }
    return facts;
  }

  it('feeds the verdicts through the capped review queue, one proposal per fact, and notifies with the outstanding count', async () => {
    const [a] = await threeFacts();

    const res = await chunk();

    expect(res).toMatchObject({ ran: true, audited: 60, proposalsAdded: 1, done: false });
    const pending = await getPendingProposals();
    expect(pending.map((p) => p.id)).toEqual([`incoherent_topics:${a.id}`]);
    expect(pending[0].ops).toContainEqual({ type: 'generate_replacements', factId: a.id, fillTo: 60 });
    expect(notified.calls()).toHaveLength(1);
    expect(notified.calls()[0]).toMatchObject({ type: 'hygiene', source: 'hygiene', context: { count: 1 } });
    expect(await getSetting(NOTIFIED)).toBe('1');
  });

  it('notifies ONCE for the whole pass, not once per chunk', async () => {
    await threeFacts();

    await chunk();
    await chunk();
    await chunk();

    expect(await getPendingCount()).toBe(3);
    expect(notified.calls()).toHaveLength(1);
    expect(notified.calls()[0].context).toEqual({ count: 1 });
  });

  it('does not consume the notification when nothing was added (the fact was already rejected)', async () => {
    const [a] = await threeFacts();
    await rejectProposal(`incoherent_topics:${a.id}`);

    const first = await chunk();
    expect(first.proposalsAdded).toBe(0);
    expect(notified.calls()).toHaveLength(0);
    expect(await getSetting(NOTIFIED)).toBeNull();

    const second = await chunk();
    expect(second.proposalsAdded).toBe(1);
    expect(notified.calls()).toHaveLength(1);
  });

  it('skips the queue entirely when a chunk finds nothing wrong', async () => {
    await seedCorpus(60);

    const res = await chunk();

    expect(res.proposalsAdded).toBe(0);
    expect(await getPendingCount()).toBe(0);
    expect(notified.calls()).toHaveLength(0);
  });
});

describe('on-device mode', () => {
  const keys = [CURSOR, STARTED, DONE, AUDITED, NOTIFIED];
  const stateRows = async () => Promise.all(keys.map((k) => getSetting(k)));

  it('skips the chunk before touching the cursor, the started stamp or the audit, and does not finish the pass', async () => {
    await seedCorpus(10);
    await setMode('on-device');

    const out = await chunk();

    expect(out).toEqual({ ran: false, reason: 'on_device', audited: 0, proposalsAdded: 0, done: false });
    expect(gatewayCalls()).toHaveLength(0);
    expect(await stateRows()).toEqual([null, null, null, null, null]);
    expect(await isBackfillDone()).toBe(false);

    // Back on the cloud, the pass starts normally.
    await setMode('cloud');
    expect(await chunk()).toMatchObject({ ran: true, audited: 10 });
  });

  it('also skips when only the persisted row says on-device (the store still holds its cloud default)', async () => {
    await seedCorpus(10);
    await setSetting('mera_processing_mode', 'ON_DEVICE');

    const out = await chunk();

    expect(out.reason).toBe('on_device');
    expect(gatewayCalls()).toHaveLength(0);
    expect(await stateRows()).toEqual([null, null, null, null, null]);
  });
});

// ---------------------------------------------------------------------------------------------------
// Bugs. The backfill's completion is "a chunk audited nothing" (`result.audited === 0`), but
// runSanityAudit also reports 0 for a gateway failure and for a lost credential. Its contract is that
// it never throws, so the "failed chunk is retried next tick" catch in the backfill can never run.
// ---------------------------------------------------------------------------------------------------
describe('a chunk that could not run must not finish the pass', () => {
  // DATA-U11b-1: sanity-backfill-service.ts:~119 (`exhausted = result.audited === 0`) with
  // topic-sanity-service.ts:~191 (the catch returns EMPTY). A refused gateway call on the FIRST chunk
  // stamps `sanity_backfill_done_at` having audited nothing.
  const refuse = () => server.use(...mockGateway(() => ({ status: 400, body: { error: 'refused' } })));

  it('DATA-U11b-1: a refused gateway call leaves the pass open, and the next chunk retries the same topics', async () => {
    await seedCorpus(150);
    refuse();

    const res = await chunk();
    expect(res.done).toBe(false);
    expect(await isBackfillDone()).toBe(false);

    server.use(...mockGateway(sanityModel()));
    const retry = await chunk();
    expect(retry).toMatchObject({ ran: true, audited: 60 });
    expect(sanityTexts(gatewayCalls('batch'))[0]).toBe('cricket topic 0');
  });

  // DATA-U11b-2: the same line, reached by a device that lost its credential mid-run
  // (runSanityAudit answers `skipped: true`, which the backfill never reads).
  it('DATA-U11b-2: a credential lost mid-run leaves the pass open', async () => {
    await seedCorpus(150);
    await loseCredential();

    const res = await chunk();

    expect(res).toEqual({ ran: false, audited: 0, proposalsAdded: 0, done: false });
    expect(await isBackfillDone()).toBe(false);
    expect(await getSetting(AUDITED)).toBeNull();
  });
});

describe('the audit cursor never skips a topic it did not judge', () => {
  // DATA-U11b-3: topic-sanity-service.ts:~172 advances the cursor to the newest topic PLANNED, as soon as
  // any one prompt decoded. A prompt that failed upstream (a per-item error) is the OLDEST fifteen of the
  // chunk, so those topics fall behind the cursor and are never judged again. `audited` also counts them.
  const failFirstPromptOnce = () => {
    let failed = false;
    server.use(
      ...mockGateway((call) => {
        if (!failed && call.index === 0) {
          failed = true;
          return { status: 502, body: { error: 'upstream' }, perItem: true };
        }
        return sanityModel()(call);
      }),
    );
  };

  async function walkToTheEnd() {
    for (let i = 0; i < 6; i++) if ((await chunk()).reason === 'already_done') break;
  }

  it('DATA-U11b-3: a prompt that failed upstream is judged again on a later chunk', async () => {
    await seedCorpus(60);
    failFirstPromptOnce();

    await walkToTheEnd();

    const judged = new Set(sanityTexts(gatewayCalls('batch').slice(4)).map(topicNumber));
    for (let i = 0; i < 15; i++) expect(judged.has(i)).toBe(true);
  });

  // DATA-U11b-4: planSanityBatches selects `createdAtMs > cursor`. Topics minted in ONE createTopics call
  // share a millisecond, so a chunk boundary inside such a group leaves its tail behind the cursor.
  const sameMillisecondGroup = async () => {
    strictClockAt(T0); // time moves only when driven: one createTopics call gets one created_at
    const fact = await addFact('Follows Indian cricket');
    await seedTopics(
      fact.id,
      Array.from({ length: 70 }, (_, i) => `cricket topic ${i}`),
    );
  };

  it('DATA-U11b-4: topics minted in the same millisecond are all judged when a chunk boundary falls inside them', async () => {
    await sameMillisecondGroup();

    await walkToTheEnd();

    const judged = new Set(sanityTexts(gatewayCalls('batch')));
    expect(judged.size).toBe(70);
  });
});

describe('a prompt that refuses every time must not pin the cursor forever', () => {
  // DA49: since DA27 the cursor stops one millisecond short of a failed prompt's oldest topic, so a prompt
  // that the model refuses on every attempt (the same fifteen topics each time) holds the cursor there:
  // each run re-sends the same chunk, re-bills the fifteen that failed, and nothing ever moves on.
  const refuseFirstPromptAlways = () =>
    server.use(
      ...mockGateway((call) =>
        sanityItems(call).some((i) => i.text === 'cricket topic 0') ? { status: 502, body: { error: 'refused' }, perItem: true } : sanityModel()(call),
      ),
    );
  const timesSent = (n: number) => sanityTexts(gatewayCalls('batch')).filter((t) => t === `cricket topic ${n}`).length;

  it('DA49: a prompt that refuses every time is skipped after the third stalled run, and the pass finishes', async () => {
    await seedCorpus(60);
    refuseFirstPromptAlways();

    for (let i = 0; i < 6; i++) if ((await chunk()).reason === 'already_done') break;

    // Run 1 moves the cursor to just below the refused topics; runs 2 to 4 stall on them (the third
    // stalled run gives up on them); run 5 finds nothing left.
    expect(timesSent(0)).toBe(4);
    expect(await getSetting(CURSOR)).toBe(String(T0 + 59 * 10));
    expect(await isBackfillDone()).toBe(true);
  });
});

describe('a chunk that dies between the audit and the queue', () => {
  // DATA-U11b-7: the audit advances the cursor as soon as verdicts decode (topic-sanity-service.ts:~172),
  // then the backfill stores the proposals. A write that fails (or a process killed) in between leaves the
  // cursor past topics whose verdicts were never kept. The file header promises "a chunk killed
  // mid-flight is retried, not skipped".
  const failQueueWriteOnce = () => {
    const real = settingService.setSetting;
    let armed = true;
    return jest.spyOn(settingService, 'setSetting').mockImplementation(async (key, value) => {
      if (armed && key === 'hygiene_pending_proposals') {
        armed = false;
        throw new Error('disk full');
      }
      return real(key, value);
    });
  };
  const contaminatedCorpus = () =>
    seedCorpus(60, { text: (i) => (i === 7 ? BAD : `cricket topic ${i}`) });

  it('DATA-U11b-7: the verdicts of a chunk whose queue write failed are found on the retry', async () => {
    const { fact } = await contaminatedCorpus();
    const spy = failQueueWriteOnce();

    const failed = await chunk();
    expect(failed).toEqual({ ran: false, audited: 0, proposalsAdded: 0, done: false });
    const retry = await chunk();
    spy.mockRestore();

    expect(retry.proposalsAdded).toBe(1);
    expect((await getPendingProposals()).map((p) => p.id)).toEqual([`incoherent_topics:${fact.id}`]);
  });
});
