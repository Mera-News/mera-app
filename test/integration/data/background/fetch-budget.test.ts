// Step (b) of the wake, `runBackgroundFeedSync`, on the REAL hooks it builds and the real feed-sync
// machine: how many articles one run may hydrate (BG_RUN_CAP), the ObjectId insert-time filter that
// keeps an old article from ever being fetched, and a server that still caps downloads.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { BG_RUN_CAP } from '@/lib/background/open-ready-target';
import { advanceUntilDone, mockGqlError } from '@/test/helpers';

import {
  HOUR,
  NOW,
  art,
  hold,
  oid,
  rowsById,
  runFetch,
  seedScored,
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

const asked = (served: ReturnType<typeof serveHydrate>) => served.stats.requests.flatMap((r) => r.ids);

describe('the per-run cap', () => {
  it('hydrates at most 50 articles in a run, in the order the server listed them', async () => {
    const { fresh, served } = await serveFresh(80);

    const out = await advanceUntilDone(runFetch());

    expect(BG_RUN_CAP).toBe(50);
    expect(out).toEqual({ stoppedBy: 'done', fetchBudget: 50 });
    expect(asked(served).sort()).toEqual(fresh.slice(0, 50).sort());
    expect((await rowsById()).size).toBe(50);
  });

  it('a second run the same day gets the same cap: there is no day ledger', async () => {
    await serveFresh(10);
    expect((await advanceUntilDone(runFetch())).fetchBudget).toBe(50);

    const more = await serveFresh(10, { first: 100 });
    const second = await advanceUntilDone(runFetch({ now: NOW + 60_000 }));

    expect(second.fetchBudget).toBe(50);
    expect(asked(more.served)).toHaveLength(10);
  });

  it('a request that never answers ends the run at its deadline', async () => {
    const wire = hold();
    await serveFresh(6, { hydrate: { gate: () => wire.held } });

    const out = await advanceUntilDone(runFetch({ deadlineAt: NOW + 5_000 }));

    expect(out).toEqual({ stoppedBy: 'deadline', fetchBudget: 50 });
  });
});

// Until the server's download cap is switched off, articlesForTopicsByIds may answer a granted
// prefix, possibly empty. The app reads that as a shorter answer and nothing else.
describe('a server that still caps downloads', () => {
  it('keeps what arrived, ends normally and reports nothing', async () => {
    const { fresh } = await serveFresh(6, {
      hydrate: { respond: ({ ids }) => ({ articles: ids.slice(0, 2).map((id) => art(id)), dailyLimitReached: true }) },
    });

    const out = await advanceUntilDone(runFetch());

    expect(out.stoppedBy).toBe('done');
    expect([...(await rowsById()).keys()].sort()).toEqual(fresh.slice(0, 2).sort());
    expect(sentryEvents()).toEqual([]);
  });

  it('an empty answer does not close background fetching: the next run asks again', async () => {
    await serveFresh(6);
    const capped = serveHydrate({ respond: () => ({ articles: [], dailyLimitReached: true }) });
    server.use(...capped.handlers);

    const first = await advanceUntilDone(runFetch());
    expect(first.stoppedBy).toBe('done');
    expect(await rowsById()).toEqual(new Map());
    expect(asked(capped)).toHaveLength(6);

    const again = await advanceUntilDone(runFetch({ now: NOW + HOUR }));
    expect(again.fetchBudget).toBe(50);
    expect(asked(capped)).toHaveLength(12);
  });
});

describe('the ObjectId insert-time filter', () => {
  it('an id inserted before the 6h window is never requested', async () => {
    const { fresh, old, served } = await serveFresh(3, { old: 2 });

    await advanceUntilDone(runFetch());

    expect(asked(served).sort()).toEqual([...fresh].sort());
    expect(asked(served).some((id) => old.includes(id))).toBe(false);
  });

  it('keeps an id inserted exactly 6h ago and drops one a second older', async () => {
    const edge = oid(1, NOW - 6 * HOUR);
    const past = oid(2, NOW - 6 * HOUR - 1000);
    const served = serveHydrate();
    await serveFresh(0);
    server.use(servePersona({ topics: { 'formula 1': [edge, past] } }), ...served.handlers);

    await advanceUntilDone(runFetch());

    expect(asked(served)).toEqual([edge]);
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
    const headlines = [0, 1, 2, 3].map((n) => oid(2000 + n, NOW - 60_000));
    const { fresh, served } = await serveFresh(48, { headlines });

    const out = await advanceUntilDone(runFetch());

    expect(out.fetchBudget).toBe(50);
    expect(asked(served).sort()).toEqual([...fresh, headlines[0], headlines[1]].sort());
  });
});

describe('followed stories when the open-ready target is already met (OWNER-F4)', () => {
  it('still hydrates the story ids, bound by the per-run cap, and sends no persona hydrate', async () => {
    await seedScored(50); // 50 relevant fresh rows: the target is met, the persona budget is 0
    await seedTracked('local election');
    const fresh = Array.from({ length: 60 }, (_, n) => oid(3000 + n, NOW - 60_000));
    const old = oid(3100, NOW - 8 * HOUR);
    const served = serveHydrate();
    server.use(servePersona({ topics: { 'local election': [old, ...fresh] } }), ...served.handlers);

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'done', fetchBudget: 0 });
    expect(served.stats.requests.every((r) => r.op === 'GetArticlesForStories')).toBe(true);
    expect(asked(served)).toEqual(fresh.slice(0, BG_RUN_CAP));
    expect(asked(served)).not.toContain(old);
  });
});

describe('a failed run', () => {
  it("is reported as 'error', never thrown", async () => {
    await serveFresh(3);
    server.use(mockGqlError('GetArticleIdsForPersona', 'INTERNAL_SERVER_ERROR', { httpStatus: 500 }));

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'error', fetchBudget: 50 });
  });
});
