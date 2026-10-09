// The asked re-read (reconcileAskedFactChecks) and the in-session poller
// (ensureAskedFactCheckPoller). Every RE-READ goes through the read-only `cachedFactCheck`; a
// terminal row is never re-read; the asked list is the only thing that decides what is read. The
// wire log from `serveChecks` is the evidence. Replaces the re-read case of
// lib/fact-check/__tests__/fact-check-graphql-client.test.ts.
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import {
  ASKED_POLL_CEILING_MS,
  ASKED_POLL_INTERVAL_MS,
  reconcileAskedFactChecks,
  requestFactCheck,
  stopAskedFactCheckPollerForTest,
} from '@/lib/fact-check/fact-check-graphql-client';
import { recordFactCheckAsked } from '@/lib/fact-check/fact-check-settled';
import { graphql, HttpResponse, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, useStrictClock } from '@/test/integration/chat/_helpers';
import {
  advanceAnd,
  askedIds,
  ASK_OP,
  checkRow,
  announced,
  spyNotified,
  opsOf,
  pendingRow,
  REREAD_OP,
  serveChecks,
  storedFor,
} from './kit';

let notified: jest.SpyInstance;
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  notified = spyNotified();
});
afterEach(() => {
  stopAskedFactCheckPollerForTest();
  jest.restoreAllMocks();
});

// `order` keeps the asks oldest-first without ageing them anywhere near the 7 day expiry.
const ask = (articleId: string, order = 0) =>
  recordFactCheckAsked({ articleId, suggestionId: null, title: articleId }, Date.now() - 60_000 + order);

describe('reconcileAskedFactChecks', () => {
  it('reads ONLY asked checks, only through the read-only operation, and counts the ones still waiting', async () => {
    const wire = serveChecks({
      reread: (id) => ({ a1: checkRow(), a2: pendingRow(), a3: null })[id as 'a1'] ?? null,
    });
    await ask('a1', 1);
    await ask('a2', 2);
    await ask('a3', 3);
    // A row stored before the community lookup went: on this phone, never asked for.
    await upsertFactCheck({ articleId: 'a9', factCheckId: 'x', status: 'pending', payload: null });

    const waiting = await reconcileAskedFactChecks();

    expect(waiting).toBe(2);
    expect(wire.map((e) => `${e.op}:${e.articleId}`)).toEqual([
      `${REREAD_OP}:a1`,
      `${REREAD_OP}:a2`,
      `${REREAD_OP}:a3`,
    ]);
    expect(opsOf(wire, ASK_OP)).toEqual([]);
    // A server miss writes nothing: nothing to store, nothing billed.
    expect((await storedFor('a1')).map((r) => r.status)).toEqual(['complete']);
    expect((await storedFor('a2')).map((r) => r.status)).toEqual(['pending']);
    expect(await storedFor('a3')).toEqual([]);
    expect((await storedFor('a9')).map((r) => r.status)).toEqual(['pending']);
  });

  it('returns zero and touches the wire not at all when nothing was asked', async () => {
    const wire = serveChecks({ reread: () => checkRow() });
    expect(await reconcileAskedFactChecks()).toBe(0);
    expect(wire).toEqual([]);
  });

  it('is bounded: 21 asks make 20 reads, oldest first', async () => {
    const wire = serveChecks({ reread: () => pendingRow() });
    for (let i = 1; i <= 21; i++) await ask(`a${String(i).padStart(2, '0')}`, i);

    const waiting = await reconcileAskedFactChecks();

    expect(waiting).toBe(20);
    const read = opsOf(wire, REREAD_OP);
    expect(read).toHaveLength(20);
    expect(read[0]).toBe('a01');
    expect(read).not.toContain('a21');
  });

  it('never throws: a failed read counts as still waiting and the rest are still read', async () => {
    const wire = serveChecks({ reread: () => checkRow() });
    // Registered after, so it answers first; for any other article it falls through.
    server.use(
      graphql.operation(({ operationName, variables }) =>
        operationName === REREAD_OP && variables.articleId === 'a1'
          ? HttpResponse.json({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
          : undefined,
      ),
    );
    await ask('a1', 1);
    await ask('a2', 2);

    const waiting = await reconcileAskedFactChecks();

    expect(waiting).toBe(1);
    expect(opsOf(wire, REREAD_OP)).toEqual(['a2']);
    expect((await storedFor('a2'))[0].status).toBe('complete');
    expect(await askedIds()).toEqual(['a1']);
  });

  it('a settled check is never read again: its ask is spent', async () => {
    const wire = serveChecks({ reread: () => checkRow() });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await ask('a1');

    await reconcileAskedFactChecks();
    await reconcileAskedFactChecks();

    expect(opsOf(wire, REREAD_OP)).toEqual(['a1']);
    expect(announced(notified)).toHaveLength(1);
  });
});

describe('ensureAskedFactCheckPoller', () => {
  /** The ask that arms the poller. Awaited without advancing the clock: the 6s cadence counts from it. */
  async function firstAsk(id: string) {
    await requestFactCheck(id, id);
  }
  const rereads = (wire: ReturnType<typeof serveChecks>) => opsOf(wire, REREAD_OP).length;

  beforeEach(() => useStrictClock(Date.now()));

  it('re-reads the asked check every 6s, through the read-only operation', async () => {
    const wire = serveChecks({ ask: () => pendingRow(), reread: () => pendingRow() });
    await firstAsk('a1');
    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
    expect(rereads(wire)).toBe(0);

    await advanceAnd(ASKED_POLL_INTERVAL_MS - 1);
    expect(rereads(wire)).toBe(0);

    await advanceAnd(1, () => rereads(wire) === 1);
    await advanceAnd(ASKED_POLL_INTERVAL_MS, () => rereads(wire) === 2);

    expect(opsOf(wire, REREAD_OP)).toEqual(['a1', 'a1']);
    // The billed operation was only ever the first ask.
    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
  });

  it('stops at the 10 minute ceiling and reads nothing after it', async () => {
    const wire = serveChecks({ ask: () => pendingRow(), reread: () => pendingRow() });
    await firstAsk('a1');

    const ticks = ASKED_POLL_CEILING_MS / ASKED_POLL_INTERVAL_MS;
    for (let k = 1; k <= ticks; k++) await advanceAnd(ASKED_POLL_INTERVAL_MS, () => rereads(wire) === k);
    expect(rereads(wire)).toBe(ticks);

    await advanceAnd(5 * ASKED_POLL_INTERVAL_MS);
    expect(rereads(wire)).toBe(ticks);
    // The ask is still on the list: the foreground task takes over from here.
    expect(await askedIds()).toEqual(['a1']);
  });

  it('stops once nothing is waiting, and announces the settle once', async () => {
    const wire = serveChecks({ ask: () => pendingRow(), reread: (_id, n) => (n >= 3 ? checkRow() : pendingRow()) });
    await firstAsk('a1');

    for (let k = 1; k <= 3; k++) await advanceAnd(ASKED_POLL_INTERVAL_MS, () => rereads(wire) === k);
    await advanceAnd(10 * ASKED_POLL_INTERVAL_MS);

    expect(rereads(wire)).toBe(3);
    expect(await askedIds()).toEqual([]);
    expect(announced(notified)).toHaveLength(1);
  });

  it('is one poller at a time: a second ask joins the same cadence', async () => {
    const wire = serveChecks({ ask: () => pendingRow(), reread: () => pendingRow() });
    await firstAsk('a1');
    await firstAsk('a2');

    await advanceAnd(ASKED_POLL_INTERVAL_MS, () => rereads(wire) === 2);
    await advanceAnd(ASKED_POLL_INTERVAL_MS, () => rereads(wire) === 4);

    expect(opsOf(wire, REREAD_OP)).toEqual(['a1', 'a2', 'a1', 'a2']);
  });
});
