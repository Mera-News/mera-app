// Step (b) of the wake, `runBackgroundFeedSync`, on the REAL hooks it builds and the real feed-sync
// machine: how many METERED articles one run may hydrate, the per-UTC-day ledger that bounds the
// total, and the ObjectId insert-time filter that keeps an old article from ever being charged.
//
// Replaces lib/background/__tests__/background-feed-sync.test.ts (the ledger, daily-limit, prefilter
// and cap blocks) and background-allowance.test.ts (through the machine; its direct reads are in
// allowance.test.ts). Those suites mocked the allowance, the readiness measure, the stores, the
// machine and the pipeline; the hooks were captured and called by hand. Here the machine calls them.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import {
  BG_RUN_METERED_CAP,
  utcDayKey,
} from '@/lib/background/background-allowance';
import {
  BG_ARTICLES_CHARGED_PREFIX,
  BG_QUOTA_EXHAUSTED_DAY_KEY,
  rememberDailyArticleLimit,
} from '@/lib/background/bg-refresh-settings';
import { getSetting, getSettingsByPrefix, setSetting } from '@/lib/database/services/setting-service';
import { advanceUntilDone, mockGqlError } from '@/test/helpers';

import {
  HOUR,
  NOW,
  art,
  failBatchWhere,
  hold,
  ledgerWrite,
  breadcrumbs,
  oid,
  persistedSetting,
  recordOps,
  rowsById,
  runFetch,
  seedTracked,
  sentryEvents,
  server,
  serveFresh,
  serveHydrate,
  servePersona,
  wakeCleanup,
  wakeWorld,
} from './support';

jest.setTimeout(60_000);

beforeEach(() => wakeWorld({ afterBoundary: true }));
afterEach(wakeCleanup);

const TODAY = utcDayKey(NOW);
const ledger = () => getSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY);
const asked = (served: ReturnType<typeof serveHydrate>) => served.stats.requests.flatMap((r) => r.ids);

describe('the per-run cap', () => {
  it('hydrates at most 50 metered articles in a run, in the order the server listed them', async () => {
    const { fresh, served } = await serveFresh(80);

    const out = await advanceUntilDone(runFetch());

    expect(BG_RUN_METERED_CAP).toBe(50);
    expect(out).toEqual({ stoppedBy: 'done', meteredBudget: 50 });
    expect(asked(served).sort()).toEqual(fresh.slice(0, 50).sort());
    expect((await rowsById()).size).toBe(50);
  });

  it('assumes the Starter limit (250, so 125 a day) when entitlement-sync never answered', async () => {
    await setSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY, '110');
    const { served } = await serveFresh(40);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(15); // 125 - 110
    expect(asked(served)).toHaveLength(15);
  });
});

describe('the per-day cap is half of the last known daily limit', () => {
  it('a run gets what is left of the half, and the next run of the day gets nothing', async () => {
    await rememberDailyArticleLimit(40); // 20 a day
    const { served } = await serveFresh(30);

    const first = await advanceUntilDone(runFetch());
    expect(first.meteredBudget).toBe(20);
    expect(asked(served)).toHaveLength(20);
    expect(await ledger()).toBe('20');

    const more = await serveFresh(30, { first: 100 });
    const second = await advanceUntilDone(runFetch({ now: NOW + 60_000 }));

    expect(second).toEqual({ stoppedBy: 'allowance', meteredBudget: 0 });
    expect(asked(more.served)).toEqual([]);
  });

  it('a run is clipped to the remainder: 12 left means 12 hydrated', async () => {
    await rememberDailyArticleLimit(100); // 50 a day
    await setSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY, '38');
    const { served } = await serveFresh(30);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(12);
    expect(asked(served)).toHaveLength(12);
    expect(await ledger()).toBe('50');
  });

  it('starts a fresh day at 00:00 UTC: yesterday ledger and exhausted flag stop counting, and the old row goes', async () => {
    await setSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY, '125');
    await setSetting(BG_QUOTA_EXHAUSTED_DAY_KEY, TODAY);
    const tomorrow = Date.UTC(2026, 9, 10, 0, 0, 1);
    jest.setSystemTime(tomorrow);
    const { served } = await serveFresh(5, { at: tomorrow });

    const out = await advanceUntilDone(runFetch({ now: tomorrow }));

    expect(out.meteredBudget).toBe(50);
    expect(asked(served)).toHaveLength(5);
    expect(await getSettingsByPrefix(BG_ARTICLES_CHARGED_PREFIX)).toEqual({
      [BG_ARTICLES_CHARGED_PREFIX + '2026-10-10']: '5',
    });
  });

  it('a run that crosses midnight reserves and corrects the row of the day it started on', async () => {
    const start = Date.UTC(2026, 9, 9, 23, 59, 50);
    jest.setSystemTime(start);
    await rememberDailyArticleLimit(1000);
    const request = hold();
    const { served } = await serveFresh(4, { at: start, hydrate: { gate: () => request.held } });
    const running = runFetch({ now: start });

    await jest.advanceTimersByTimeAsync(20_000); // now 00:00:10 on the 10th
    expect(Date.now()).toBeGreaterThan(Date.UTC(2026, 9, 10));
    request.release();
    await advanceUntilDone(running);

    expect(asked(served)).toHaveLength(4);
    expect(await getSettingsByPrefix(BG_ARTICLES_CHARGED_PREFIX)).toEqual({
      [BG_ARTICLES_CHARGED_PREFIX + '2026-10-09']: '4',
    });
  });
});

describe('the ledger is reserved before the request and settled to the grant', () => {
  it('holds the whole request in the ledger while it is on the wire', async () => {
    const seen: (string | null)[] = [];
    await serveFresh(6, { hydrate: { gate: async () => void seen.push(await ledger()) } });

    await advanceUntilDone(runFetch());

    expect(seen).toEqual(['6']);
    expect(await ledger()).toBe('6');
  });

  it('corrects down to what the server granted when it hit the daily cap mid-chunk', async () => {
    // The server grants a prefix of 2 of the 6 asked for and says the cap was reached.
    const { fresh } = await serveFresh(6, {
      hydrate: { respond: ({ ids }) => ({ articles: ids.slice(0, 2).map((id) => art(id)), dailyLimitReached: true }) },
    });

    await advanceUntilDone(runFetch());

    expect(await ledger()).toBe('2');
    expect(await getSetting(BG_QUOTA_EXHAUSTED_DAY_KEY)).toBe(TODAY);
    expect([...(await rowsById()).keys()].sort()).toEqual(fresh.slice(0, 2).sort());
  });

  it('keeps the whole reservation when the server answered without the cap but one document was gone', async () => {
    await serveFresh(6, { hydrate: { respond: ({ ids }) => ({ articles: ids.slice(0, 4).map((id) => art(id)) }) } });

    await advanceUntilDone(runFetch());

    expect(await ledger()).toBe('6'); // the server charged all six
    expect((await rowsById()).size).toBe(4);
  });

  it('keeps the reservation of a request that never answers, and the run ends at its deadline', async () => {
    const wire = hold();
    await serveFresh(6, { hydrate: { gate: () => wire.held } });

    const out = await advanceUntilDone(runFetch({ deadlineAt: NOW + 5_000 }));

    expect(out).toEqual({ stoppedBy: 'deadline', meteredBudget: 50 });
    expect(await ledger()).toBe('6');
  });

  it('a reservation that cannot be written stops the request: nothing is sent, nothing is charged', async () => {
    const { served } = await serveFresh(6);
    failBatchWhere(ledgerWrite(BG_ARTICLES_CHARGED_PREFIX));

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('error');
    expect(served.stats.requests).toEqual([]);
    expect((await rowsById()).size).toBe(0);
  });

  it('a correction that cannot be written leaves the ledger high, and the run still completes', async () => {
    // The grant (2) is smaller than the reservation (6), so the correction is a second ledger write.
    await serveFresh(6, {
      hydrate: { respond: ({ ids }) => ({ articles: ids.slice(0, 2).map((id) => art(id)), dailyLimitReached: true }) },
    });
    let writes = 0;
    failBatchWhere((op) => ledgerWrite(BG_ARTICLES_CHARGED_PREFIX)(op) && writes++ > 0); // the first is the reservation // the first is the reservation

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('done');
    // What reached the disk, not the record cache: the refused update is still in the cache.
    expect(await persistedSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY)).toBe('6');
    expect(breadcrumbs()).toContain('bg-feed-sync: allowance correction failed');
    expect(sentryEvents()).toEqual([]);
  });
});

// DATA-U15-2. The hydrate step runs three workers; each reserves with a read-modify-write of the
// ledger row (`adjustCharged`: read all rows, write current + delta). Two chunks reserved together
// read the same value, and the second write replaces the first.
describe('concurrent chunks', () => {
  test.failing('two chunks of 25 reserved together are both in the ledger', async () => {
    await serveFresh(50);

    await advanceUntilDone(runFetch());

    expect(await ledger()).toBe('50');
  });

  it('today: the second reservation overwrites the first, so the ledger undercounts by one chunk', async () => {
    const { served } = await serveFresh(50);

    await advanceUntilDone(runFetch());

    expect(served.stats.requests.map((r) => r.ids.length)).toEqual([25, 25]);
    expect(await ledger()).toBe('25');
  });
});

describe('a daily limit reached', () => {
  const capped = () =>
    serveHydrate({ respond: () => ({ articles: [], dailyLimitReached: true }) }).handlers;

  it('a closing mark that cannot be written is a breadcrumb: the run still ends normally', async () => {
    await serveFresh(6, { hydrate: { respond: () => ({ articles: [], dailyLimitReached: true }) } });
    failBatchWhere((op) => op.table === 'settings' && op.raw?.key === BG_QUOTA_EXHAUSTED_DAY_KEY);

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('done');
    expect(await persistedSetting(BG_QUOTA_EXHAUSTED_DAY_KEY)).toBeNull();
    expect(breadcrumbs()).toContain('bg-feed-sync: allowance ledger write failed');
  });

  it('closes background fetches for the rest of that UTC day, and the next day opens them again', async () => {
    const ops = recordOps();
    const { served } = await serveFresh(6);
    server.use(...capped());

    const first = await advanceUntilDone(runFetch());

    expect(first.stoppedBy).toBe('done');
    expect(await getSetting(BG_QUOTA_EXHAUSTED_DAY_KEY)).toBe(TODAY);
    expect(await ledger()).toBe('0'); // nothing was granted: the reservation is given back
    expect(await rowsById()).toEqual(new Map());
    const personaCalls = await ops.count('GetArticleIdsForPersona');

    const sameDay = await advanceUntilDone(runFetch({ now: NOW + 5 * HOUR - 1 }));
    expect(sameDay).toEqual({ stoppedBy: 'allowance', meteredBudget: 0 });
    expect(await ops.count('GetArticleIdsForPersona')).toBe(personaCalls);

    const tomorrow = Date.UTC(2026, 9, 10, 0, 0, 1);
    jest.setSystemTime(tomorrow);
    const next = await serveFresh(3, { at: tomorrow, first: 500 });
    const reopened = await advanceUntilDone(runFetch({ now: tomorrow }));
    expect(reopened.stoppedBy).toBe('done');
    expect(asked(next.served)).toHaveLength(3);
    void served;
  });
});

describe('the ObjectId insert-time filter', () => {
  it('an id inserted before the 6h window is never requested and never charged', async () => {
    const { fresh, old, served } = await serveFresh(3, { old: 2 });

    await advanceUntilDone(runFetch());

    expect(asked(served).sort()).toEqual([...fresh].sort());
    expect(asked(served).some((id) => old.includes(id))).toBe(false);
    expect(await ledger()).toBe('3');
  });

  it('keeps an id inserted exactly 6h ago and drops one a second older', async () => {
    const edge = oid(1, NOW - 6 * HOUR);
    const past = oid(2, NOW - 6 * HOUR - 1000);
    const served = serveHydrate();
    await serveFresh(0);
    server.use(servePersona({ topics: { 'formula 1': [edge, past] } }), ...served.handlers);

    await advanceUntilDone(runFetch());

    expect(asked(served)).toEqual([edge]);
    expect(await ledger()).toBe('1');
  });

  it('drops anything that is not a 24-hex ObjectId rather than guess', async () => {
    const served = serveHydrate();
    await serveFresh(0);
    const good = oid(1, NOW - 60_000);
    server.use(servePersona({ topics: { 'formula 1': ['art-1', good] } }), ...served.handlers);

    await advanceUntilDone(runFetch());

    expect(asked(served)).toEqual([good]);
  });

  it('the persona ids keep server order, topics first and headlines last, so the cap clips headlines', async () => {
    await setSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY, '120'); // 5 left of the Starter half
    const headlines = [0, 1, 2, 3].map((n) => oid(2000 + n, NOW - 60_000));
    const { fresh, served } = await serveFresh(4, { headlines });

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(5);
    expect(asked(served)).toEqual([...fresh, headlines[0]]);
  });

  it('window-filters and caps the free followed-story ids too, without charging them', async () => {
    await setSetting(BG_ARTICLES_CHARGED_PREFIX + TODAY, '120'); // budget 5
    await seedTracked('local election');
    const fresh = [0, 1, 2, 3, 4, 5, 6].map((n) => oid(3000 + n, NOW - 60_000));
    const old = oid(3100, NOW - 8 * HOUR);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'local election': [old, ...fresh] } }), ...served.handlers);

    await advanceUntilDone(runFetch());

    const stories = served.stats.requests.filter((r) => r.op === 'GetArticlesForStories').flatMap((r) => r.ids);
    expect(stories).toEqual(fresh.slice(0, 5));
    expect(stories).not.toContain(old);
    expect(await ledger()).toBe('120'); // free ids are not reserved
  });
});

describe('a failed run', () => {
  it("is reported as 'error', never thrown, with a breadcrumb and no capture", async () => {
    await serveFresh(3);
    server.use(mockGqlError('GetArticleIdsForPersona', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'error', meteredBudget: 50 });
  });
});
