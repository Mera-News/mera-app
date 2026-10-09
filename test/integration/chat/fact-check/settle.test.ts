// "Your fact check is ready": detected in ONE place (the store every server read goes through),
// announced once, and only for a check THIS device asked for. Replaces
// lib/fact-check/__tests__/fact-check-settled.test.ts, which mocked setting-service and the toast
// manager. Here the asked list is the persisted setting, the announcement is a real
// `fact_check_done` inbox row plus the toast the real manager hands the host.
import { upsertFactCheck } from '@/lib/database/services/fact-check-record-service';
import { setSetting } from '@/lib/database/services/setting-service';
import {
  ASKED_TTL_MS,
  listAskedFactChecks,
  NOTIFY_TITLE_MAX,
  outcomeFor,
  recordFactCheckAsked,
} from '@/lib/fact-check/fact-check-settled';
import {
  reconcileAskedFactChecks,
  requestFactCheck,
  stopAskedFactCheckPollerForTest,
} from '@/lib/fact-check/fact-check-graphql-client';
import { advanceUntilDone, signInFixtureAccount, useFakeClock as installFakeClock } from '@/test/helpers';
import { resetChatModules } from '@/test/integration/chat/_helpers';
import {
  ASKED_KEY,
  askedIds,
  checkRow,
  announced,
  spyNotified,
  opsOf,
  pendingRow,
  REREAD_OP,
  serveChecks,
  settled,
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

/** An ask this device made whose first answer was still in flight. */
async function askAndWait(articleId = 'a1', title: string | null = 'Fallback title') {
  await requestFactCheck(articleId, title ?? undefined);
  stopAskedFactCheckPollerForTest();
}

describe('a check that settles after the ask', () => {
  it('announces ONCE, with the outcome, the open action and the title the check was asked under', async () => {
    let answered = false;
    serveChecks({ ask: () => pendingRow(), reread: () => (answered ? checkRow({ articleTitle: 'A headline' }) : pendingRow()) });
    await askAndWait('a1');
    expect(announced(notified)).toEqual([]);

    answered = true;
    expect(await reconcileAskedFactChecks()).toBe(0);

    expect(announced(notified)).toEqual([
      {
        type: 'fact_check_done',
        source: 'fact-check',
        title: 'factCheck.notify.title',
        body: 'factCheck.notify.bodyNone',
        icon: 'fact-check',
        context: { articleId: 'a1', articleTitle: 'A headline', outcome: 'none', title: 'A headline' },
        actions: [{ id: 'open-fact-check', labelKey: 'factCheck.notify.open' }],
      },
    ]);
    // Settling takes the ask out of the list: that is the dedupe.
    expect(await askedIds()).toEqual([]);
  });

  it('the same change seen by a second path does not announce again', async () => {
    serveChecks({ ask: () => checkRow(), reread: () => checkRow() });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'T' });

    await requestFactCheck('a1'); // the panel poll lands it
    await reconcileAskedFactChecks(); // the foreground re-read sees it again
    await requestFactCheck('a1');

    expect(notified).toHaveBeenCalledTimes(1);
  });

  it('carries the suggestion the ask came from into the row context', async () => {
    serveChecks({ reread: () => checkRow() });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: 's1', title: 'T' });

    await reconcileAskedFactChecks();

    expect((announced(notified))[0].context).toMatchObject({ articleId: 'a1', suggestionId: 's1' });
  });

  it.each([
    ['found', { checkedBy: [{ organisation: 'Snopes', url: null, verdict: null, summary: null }] }, 'Found'],
    ['none', {}, 'None'],
    ['unavailable', { checkedByStatus: 'unavailable' }, 'Unavailable'],
    ['unavailable', { status: 'blocked' }, 'Unavailable'],
  ] as const)('a %s outcome uses its own body', async (outcome, over, key) => {
    serveChecks({ reread: () => checkRow(over as never) });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });

    await reconcileAskedFactChecks();

    const [row] = announced(notified);
    expect(row.context.outcome).toBe(outcome);
    expect(row.body).toBe(`factCheck.notify.body${key}`);
  });

  it.each([
    ['none', {}, 'factCheck.notify.bodyNoneUntitled'],
    ['unavailable', { checkedByStatus: 'unavailable' }, 'factCheck.notify.bodyUnavailableUntitled'],
  ] as const)('with no title at all, the %s outcome uses the body written without a title', async (_o, over, key) => {
    serveChecks({ reread: () => checkRow({ articleTitle: null, ...over } as never) });
    await upsertFactCheck({ articleId: 'a9', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a9', suggestionId: null, title: null });

    await reconcileAskedFactChecks();

    expect((announced(notified))[0].body).toBe(key);
  });

  it('a check that had failed counts as waiting, so it announces when it finally settles', async () => {
    serveChecks({ reread: () => checkRow() });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'failed', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'T' });

    await reconcileAskedFactChecks();

    expect(announced(notified)).toHaveLength(1);
  });

  it('cuts a long title for the notification context only; the stored row keeps it whole', async () => {
    const long = 'x'.repeat(90);
    serveChecks({ reread: () => checkRow({ articleTitle: long }) });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });

    await reconcileAskedFactChecks();

    const { context } = (announced(notified))[0];
    expect(context.articleTitle).toBe(long);
    expect(context.title).toHaveLength(NOTIFY_TITLE_MAX);
    expect(context.suggestionId).toBeUndefined();
    expect((await storedFor('a1'))[0].articleTitle).toBe(long);
  });
});

describe('a check that does not announce', () => {
  it('waits while the check is still running: nothing written, the ask stays', async () => {
    serveChecks({ reread: () => checkRow({ status: 'running', verdict: null }) });
    await upsertFactCheck({ articleId: 'a1', factCheckId: 'x', status: 'pending', payload: null });
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: null });

    expect(await reconcileAskedFactChecks()).toBe(1);

    expect(announced(notified)).toEqual([]);
    expect(await askedIds()).toEqual(['a1']);
  });

  it('an answer that was already there on the FIRST ask is not announced, and spends the ask', async () => {
    serveChecks({ ask: () => checkRow() });

    const outcome = await requestFactCheck('a1', 'T');
    stopAskedFactCheckPollerForTest();

    expect(outcome.terminal).toBe(true);
    expect(announced(notified)).toEqual([]);
    expect(notified).not.toHaveBeenCalled();
    expect(await askedIds()).toEqual([]);
  });

  it('a check this device did not ask for never announces, even when it settles under the poll', async () => {
    // An older row stored before the community lookup was removed: no entry on the asked list.
    await upsertFactCheck({ articleId: 'a2', factCheckId: 'x', status: 'pending', payload: null });
    serveChecks({ ask: () => checkRow() });

    await requestFactCheck('a2');

    expect(announced(notified)).toEqual([]);
    expect(notified).not.toHaveBeenCalled();
  });
});

describe('the asked list', () => {
  it('is a persisted setting, so it survives the JS reload every return to the app causes', async () => {
    await recordFactCheckAsked({ articleId: 'a1', suggestionId: null, title: 'T' });
    // A reload loses every module variable and keeps the settings table: read it fresh.
    const asked = await listAskedFactChecks();
    expect(asked.map((a) => a.articleId)).toEqual(['a1']);
  });

  it('lists oldest first and drops asks past their age, writing the pruned list back', async () => {
    await recordFactCheckAsked({ articleId: 'old', suggestionId: null, title: null }, 0);
    await recordFactCheckAsked({ articleId: 'new', suggestionId: null, title: null }, ASKED_TTL_MS);
    await recordFactCheckAsked({ articleId: 'mid', suggestionId: null, title: null }, ASKED_TTL_MS - 10);

    const now = ASKED_TTL_MS + 1000;
    expect((await listAskedFactChecks(now)).map((a) => a.articleId)).toEqual(['mid', 'new']);
    expect(await askedIds()).toEqual(expect.arrayContaining(['mid', 'new']));
    expect(await askedIds()).not.toContain('old');
  });

  it('drops a malformed entry instead of failing the whole list', async () => {
    await setSetting(ASKED_KEY, JSON.stringify({ bad: { articleId: 'bad' }, ok: { articleId: 'ok', suggestionId: null, title: null, askedAt: Date.now() } }));
    expect((await listAskedFactChecks()).map((a) => a.articleId)).toEqual(['ok']);
  });

  it('survives a corrupt setting: an empty list, not a throw', async () => {
    await setSetting(ASKED_KEY, '{not json');
    expect(await listAskedFactChecks()).toEqual([]);
  });

  it('expires an ask on the clock: a re-read after the TTL reads nothing and returns zero', async () => {
    const start = Date.now();
    installFakeClock(start);
    const wire = serveChecks({ reread: () => pendingRow() });
    await advanceUntilDone(askAndWait('a1'), 60_000, 100);
    expect(await askedIds()).toEqual(['a1']);

    jest.setSystemTime(start + ASKED_TTL_MS + 1000);
    const waiting = await advanceUntilDone(reconcileAskedFactChecks(), 60_000, 100);

    expect(waiting).toBe(0);
    expect(opsOf(wire, REREAD_OP)).toEqual([]);
    expect(await askedIds()).toEqual([]);
  });
});

describe('outcomeFor', () => {
  it('maps the external-checks line onto three bodies', () => {
    expect(outcomeFor(checkRow({ checkedBy: [{ organisation: 'Snopes', url: null, verdict: null, summary: null }] as never }))).toBe('found');
    expect(outcomeFor(checkRow({ checkedBy: [] }))).toBe('none');
    expect(outcomeFor(checkRow({ checkedBy: [], checkedByStatus: 'unavailable' }))).toBe('unavailable');
    expect(outcomeFor(checkRow({ status: 'blocked' }))).toBe('unavailable');
  });
});

describe('settling reads back through the DB', () => {
  it('stores the settled row in place of the waiting one (one row, new status)', async () => {
    serveChecks({ ask: () => pendingRow(), reread: () => checkRow() });
    await askAndWait('a1');
    expect((await storedFor('a1')).map((r) => r.status)).toEqual(['pending']);

    await reconcileAskedFactChecks();

    const rows = await settled(() => storedFor('a1'), (r) => r[0]?.status === 'complete');
    expect(rows.map((r) => r.status)).toEqual(['complete']);
  });
});
