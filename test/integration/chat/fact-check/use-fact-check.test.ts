// useFactCheck (live observer + asked-only poll) and useStoredFactCheck (one-shot local read), under
// renderHook with the real DB, the real asked list and the mock GraphQL server. New coverage: both
// hooks had no test. The wire log says which operation each poll used; the hook's own poll is the one
// documented place a billed `factCheck` re-ask happens, and only for an ASKED article.
import { act, renderHook } from '@testing-library/react-native';
import * as records from '@/lib/database/services/fact-check-record-service';
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import {
  requestFactCheck,
  stopAskedFactCheckPollerForTest,
} from '@/lib/fact-check/fact-check-graphql-client';
import { recordFactCheckAsked } from '@/lib/fact-check/fact-check-settled';
import { PROGRESS_DELAY_MS, POLL_CEILING_MS, POLL_INTERVAL_MS } from '@/lib/fact-check/fact-check-state';
import { useFactCheck } from '@/lib/fact-check/use-fact-check';
import { useStoredFactCheck } from '@/lib/fact-check/use-stored-fact-check';
import { graphql, HttpResponse, mockGqlError, server, signInFixtureAccount } from '@/test/helpers';
import { resetChatModules, useStrictClock as installStrictClock } from '@/test/integration/chat/_helpers';
import {
  advanceAnd,
  announced,
  ASK_OP,
  askedIds,
  checkRow,
  opsOf,
  pendingRow,
  realTurn,
  REREAD_OP,
  serveChecks,
  spyNotified,
  storedFor,
} from './kit';

let notified: jest.SpyInstance;
beforeEach(async () => {
  resetChatModules();
  await signInFixtureAccount();
  notified = spyNotified();
  installStrictClock(Date.now());
});
afterEach(() => {
  stopAskedFactCheckPollerForTest();
  jest.restoreAllMocks();
});

/** Lets the live subscription, the asked-list read and any answered request land, inside act. */
const flush = (turns = 40) =>
  act(async () => {
    await jest.advanceTimersByTimeAsync(0);
    for (let i = 0; i < turns; i++) await realTurn();
  });

/** Advances the fake clock inside act, then lets the network answer. */
const tick = (ms: number) =>
  act(async () => {
    await advanceAnd(ms, () => true, 40);
  });

const seedStored = (id: string, status: string, extra: Partial<records.UpsertFactCheckInput> = {}) =>
  upsertFactCheck({ articleId: id, factCheckId: `fc-${id}`, status, payload: null, ...extra });
const seedAsked = (id: string) => recordFactCheckAsked({ articleId: id, suggestionId: null, title: id });

describe('useFactCheck: what it shows', () => {
  it('is absent, with no rows and no request, without an article id', async () => {
    const wire = serveChecks({ ask: () => checkRow() });
    const { result } = renderHook(() => useFactCheck(null));
    await flush();
    expect(result.current).toMatchObject({ phase: 'absent', showProgress: false, rows: [] });
    expect(wire).toEqual([]);
  });

  it('is absent when nobody here asked about the article, and costs zero requests', async () => {
    const wire = serveChecks({ ask: () => checkRow() });
    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(10 * POLL_INTERVAL_MS);
    expect(result.current.phase).toBe('absent');
    expect(wire).toEqual([]);
  });

  it('shows a stored terminal row as terminal with its payload, and never fetches it', async () => {
    const wire = serveChecks({ ask: () => checkRow() });
    await seedStored('a1', 'complete', { verdict: 'supported', payload: checkRow() });

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(5 * POLL_INTERVAL_MS);

    expect(result.current.phase).toBe('terminal');
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0]).toMatchObject({ articleId: 'a1', status: 'complete', verdict: 'supported' });
    expect(result.current.rows[0].payload).toMatchObject({ summary: expect.any(String) });
    expect(wire).toEqual([]);
  });

  it('shows only the rows of the article it was given, and follows a change of article', async () => {
    await seedStored('a1', 'complete');
    await seedStored('a2', 'blocked');
    const { result, rerender } = renderHook(({ id }: { id: string }) => useFactCheck(id), { initialProps: { id: 'a1' } });
    await flush();
    expect(result.current.rows.map((r) => r.articleId)).toEqual(['a1']);

    rerender({ id: 'a2' });
    await flush();

    expect(result.current.rows.map((r) => [r.articleId, r.status])).toEqual([['a2', 'blocked']]);
    expect(result.current.phase).toBe('terminal');
  });

  it('flips an unasked row to terminal live when something finishes it in place', async () => {
    await seedStored('a1', 'pending');
    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    expect(result.current.phase).toBe('stalled');

    await act(async () => {
      await seedStored('a1', 'complete', { verdict: 'disputed', payload: checkRow({ verdict: 'disputed' }) });
    });
    await flush();

    expect(result.current.phase).toBe('terminal');
    expect(result.current.rows).toHaveLength(1);
    expect(result.current.rows[0].verdict).toBe('disputed');
  });
});

describe('useFactCheck: an older row nobody here asked for', () => {
  it('renders as stalled, never as absent or processing, with zero requests', async () => {
    const wire = serveChecks({ ask: () => checkRow(), reread: () => checkRow() });
    await seedStored('a1', 'pending');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(10 * POLL_INTERVAL_MS);

    expect(result.current.phase).toBe('stalled');
    expect(result.current.rows).toHaveLength(1);
    expect(wire).toEqual([]);
  });

  it("the reader's own tap on it records the ask, so the open panel starts polling", async () => {
    const wire = serveChecks({ ask: (_id, n) => (n >= 3 ? checkRow() : pendingRow()) });
    await seedStored('a1', 'pending');
    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    expect(result.current.phase).toBe('stalled');
    expect(wire).toEqual([]);

    await act(async () => {
      await requestFactCheck('a1', 'T', undefined, true);
    });
    stopAskedFactCheckPollerForTest(); // the in-session re-reader is covered elsewhere
    await flush();

    expect(await askedIds()).toEqual(['a1']);
    // The tap's own ask, then the hook's immediate poll.
    expect(opsOf(wire, ASK_OP).length).toBeGreaterThanOrEqual(2);
    expect(result.current.phase).toBe('processing');

    await tick(POLL_INTERVAL_MS);
    await flush();
    expect(result.current.phase).toBe('terminal');
  });
});

describe('useFactCheck: the asked-only poll', () => {
  it('polls an asked article with a waiting row at once and every 6s, re-asking through the billed query', async () => {
    const wire = serveChecks({ ask: () => pendingRow(), reread: () => pendingRow() });
    await seedStored('a1', 'pending');
    await seedAsked('a1');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    expect(result.current.phase).toBe('processing');
    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);

    await tick(POLL_INTERVAL_MS - 1);
    expect(opsOf(wire, ASK_OP)).toHaveLength(1);
    await tick(1);
    await flush();
    expect(opsOf(wire, ASK_OP)).toHaveLength(2);
    // The panel poll never uses the read-only operation.
    expect(opsOf(wire, REREAD_OP)).toEqual([]);
  });

  it('lands the answer, flips to terminal, announces once and stops polling', async () => {
    const wire = serveChecks({ ask: (_id, n) => (n >= 3 ? checkRow() : pendingRow()) });
    await seedStored('a1', 'pending');
    await seedAsked('a1');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(POLL_INTERVAL_MS);
    await flush();
    await tick(POLL_INTERVAL_MS);
    await flush();

    expect(result.current.phase).toBe('terminal');
    expect(result.current.rows[0].status).toBe('complete');
    expect(announced(notified)).toHaveLength(1);
    const polls = opsOf(wire, ASK_OP).length;
    expect(polls).toBe(3);

    await tick(10 * POLL_INTERVAL_MS);
    expect(opsOf(wire, ASK_OP)).toHaveLength(polls);
  });

  it('counts a failed row as still processing: the server re-drives it', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    await seedStored('a1', 'failed');
    await seedAsked('a1');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();

    expect(result.current.phase).toBe('processing');
    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
  });

  it('gives up at the ceiling as stalled (never absent) and then asks nothing more', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    await seedStored('a1', 'pending');
    await seedAsked('a1');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(POLL_CEILING_MS - POLL_INTERVAL_MS);
    await flush();
    expect(result.current.phase).toBe('processing');

    await tick(POLL_INTERVAL_MS);
    await flush();
    expect(result.current.phase).toBe('stalled');
    // Every poll up to and including the one that gave up: t = 0, 6 ... 180s.
    const polls = opsOf(wire, ASK_OP).length;
    expect(polls).toBe(POLL_CEILING_MS / POLL_INTERVAL_MS + 1);

    await tick(10 * POLL_INTERVAL_MS);
    expect(opsOf(wire, ASK_OP)).toHaveLength(polls);
    expect(result.current.rows).toHaveLength(1);
  });

  it('retries after a failed poll instead of giving up', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    await seedStored('a1', 'pending');
    await seedAsked('a1');
    server.use(
      graphql.operation(
        ({ operationName }) =>
          operationName === ASK_OP
            ? HttpResponse.json({ errors: [{ message: 'boom', extensions: { code: 'INTERNAL_SERVER_ERROR' } }] })
            : undefined,
        { once: true },
      ),
    );

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    expect(opsOf(wire, ASK_OP)).toEqual([]); // the first poll was the one that failed
    expect(result.current.phase).toBe('processing');

    await tick(POLL_INTERVAL_MS);
    await flush();

    expect(opsOf(wire, ASK_OP)).toEqual(['a1']);
    expect(result.current.phase).toBe('processing');
  });

  it('stops polling when the panel unmounts', async () => {
    const wire = serveChecks({ ask: () => pendingRow() });
    await seedStored('a1', 'pending');
    await seedAsked('a1');
    const { unmount } = renderHook(() => useFactCheck('a1'));
    await flush();
    const polls = opsOf(wire, ASK_OP).length;

    unmount();
    await tick(10 * POLL_INTERVAL_MS);

    expect(opsOf(wire, ASK_OP)).toHaveLength(polls);
  });

  it('shows progress only after a processing row has been in flight a moment', async () => {
    serveChecks({ ask: () => pendingRow() });
    await seedStored('a1', 'pending');
    await seedAsked('a1');

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    expect(result.current.phase).toBe('processing');
    expect(result.current.showProgress).toBe(false);

    await tick(PROGRESS_DELAY_MS);
    await flush();

    expect(result.current.showProgress).toBe(true);
  });
});

describe('useFactCheck: a failed first ask', () => {
  // A failed FIRST ask leaves the article on the asked list and writes no local row, and the panel
  // poll only runs while a local non-terminal row exists. The chat skill documents the poll as the
  // retry for a failed first ask ("a failed first ask is retried that way"); nothing does. The
  // in-session re-reader and the foreground task read `cachedFactCheck`, which never creates a row,
  // so the check never starts until the ask expires after 7 days.
  async function failedFirstAsk() {
    server.use(mockGqlError(ASK_OP, 'INTERNAL_SERVER_ERROR'));
    const outcome = await requestFactCheck('a1', 'T', undefined, true);
    stopAskedFactCheckPollerForTest();
    expect(outcome).toEqual({ terminal: false, row: null });
    expect(await askedIds()).toEqual(['a1']);
    expect(await storedFor('a1')).toEqual([]);
  }

  test.failing('the panel poll re-asks an article whose first ask failed', async () => {
    await failedFirstAsk();
    const wire = serveChecks({ ask: () => pendingRow() });

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(2 * POLL_INTERVAL_MS);
    await flush();

    expect(opsOf(wire, ASK_OP).length).toBeGreaterThanOrEqual(1);
    expect(result.current.phase).not.toBe('absent');
  });

  it('today: the panel shows absent and never re-asks (pins the bug above)', async () => {
    await failedFirstAsk();
    const wire = serveChecks({ ask: () => pendingRow() });

    const { result } = renderHook(() => useFactCheck('a1'));
    await flush();
    await tick(10 * POLL_INTERVAL_MS);
    await flush();

    expect(result.current.phase).toBe('absent');
    expect(opsOf(wire, ASK_OP)).toEqual([]);
    expect(await askedIds()).toEqual(['a1']);
  });
});

describe('useStoredFactCheck', () => {
  it('reads nothing without an article id or while disabled', async () => {
    await seedStored('a1', 'complete');
    const read = jest.spyOn(records, 'listFactChecksForArticle');

    const none = renderHook(() => useStoredFactCheck(null, true));
    const off = renderHook(() => useStoredFactCheck('a1', false));
    await flush();

    expect(none.result.current).toEqual([]);
    expect(off.result.current).toEqual([]);
    expect(read).not.toHaveBeenCalled();
  });

  it('reads every stored row for the article once enabled: the legacy slot and each claim', async () => {
    await seedStored('a1', 'complete', { payload: checkRow() });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'fc-claim', status: 'complete', payload: null, claim: 'A claim', claimKey: 'k1' });
    await seedStored('a2', 'complete');

    const { result } = renderHook(() => useStoredFactCheck('a1', true));
    await flush();

    expect(result.current).toHaveLength(2);
    expect(result.current.map((r) => r.claimKey)).toEqual(expect.arrayContaining(['k1', null]));
    expect(result.current.every((r) => r.articleId === 'a1')).toBe(true);
  });

  it('does not read until the screen knows the article failed to load, then reads once', async () => {
    await seedStored('a1', 'blocked');
    const { result, rerender } = renderHook(({ on }: { on: boolean }) => useStoredFactCheck('a1', on), { initialProps: { on: false } });
    await flush();
    expect(result.current).toEqual([]);

    rerender({ on: true });
    await flush();

    expect(result.current.map((r) => r.status)).toEqual(['blocked']);
  });

  it('is local only: no request ever leaves', async () => {
    const wire = serveChecks({ ask: () => checkRow(), reread: () => checkRow() });
    await seedStored('a1', 'complete');
    renderHook(() => useStoredFactCheck('a1', true));
    await flush();
    expect(wire).toEqual([]);
  });
});
