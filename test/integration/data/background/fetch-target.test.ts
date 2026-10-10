// Step (b) decides whether to fetch at all and how much: the 24h last-foreground rule, the open-ready
// target (50 relevant articles from the last 6h, pending rows counted at the measured yield), and
// the stores it hydrates first. Everything runs on the real `runBackgroundFeedSync`, the in-memory
// DB (rows seeded through the sync and scoring writers) and the real machine.
//
// Replaces lib/background/__tests__/background-feed-sync.test.ts ("when it does not fetch at all"
// and the prerequisite-hydration and budget-sizing cases). Those mocked the readiness measure, the
// allowance and the stores; the numbers here are read from real rows.
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import { NO_FOREGROUND_SKIP_MS } from '@/lib/background/background-feed-sync';
import { LAST_FOREGROUND_AT_KEY } from '@/lib/background/bg-refresh-settings';
import {
  loadFeedMetadata,
  persistFeedMetadata,
} from '@/lib/database/services/article-suggestion-lifecycle';
import { deleteSetting, setSetting } from '@/lib/database/services/setting-service';
import { ProcessingMode } from '@/lib/generated/graphql-types';
import { useDatabaseStore } from '@/lib/stores/database-store';
import { useMeraProtocolStore } from '@/lib/stores/mera-protocol-store';
import { advanceUntilDone, gatewayCalls } from '@/test/helpers';

import {
  HOUR,
  NOW,
  recordOps,
  rowsById,
  runFetch,
  seedScored,
  seedUnscored,
  serveFresh,
  wakeCleanup,
  wakeWorld,
} from './support';

jest.setTimeout(60_000);

beforeEach(() => wakeWorld({ afterBoundary: true }));
afterEach(wakeCleanup);

describe('the reader has to have opened the app within 24h', () => {
  it('skips a reader who opened it 25h ago, and asks the server nothing', async () => {
    await setSetting(LAST_FOREGROUND_AT_KEY, String(NOW - 25 * HOUR));
    const ops = recordOps();
    await serveFresh(3);

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'no-foreground', meteredBudget: 0 });
    expect(await ops.all()).toEqual([]);
    expect(await rowsById()).toEqual(new Map());
  });

  it('keeps fetching at exactly 24h and skips a millisecond past it', async () => {
    expect(NO_FOREGROUND_SKIP_MS).toBe(24 * HOUR);
    await serveFresh(3);
    await setSetting(LAST_FOREGROUND_AT_KEY, String(NOW - 24 * HOUR));
    expect((await advanceUntilDone(runFetch())).stoppedBy).toBe('done');

    await setSetting(LAST_FOREGROUND_AT_KEY, String(NOW - 24 * HOUR - 1));
    expect((await advanceUntilDone(runFetch({ now: NOW }))).stoppedBy).toBe('no-foreground');
  });

  it('skips a device that never recorded a foreground', async () => {
    await deleteSetting(LAST_FOREGROUND_AT_KEY);
    const ops = recordOps();

    expect(await advanceUntilDone(runFetch())).toEqual({ stoppedBy: 'no-foreground', meteredBudget: 0 });

    expect(await ops.all()).toEqual([]);
  });
});

describe('the open-ready target: 50 relevant articles from the last 6h', () => {
  it('hydrates no metered article when 50 relevant fresh articles are already there (followed stories still run)', async () => {
    await seedScored(50);
    const { served } = await serveFresh(3);

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'done', meteredBudget: 0 });
    expect(served.stats.requests).toEqual([]);
  });

  it('does not count an article published more than 6h ago, however well it scored', async () => {
    await seedScored(50, { ageMs: 7 * HOUR });
    await serveFresh(3);

    expect((await advanceUntilDone(runFetch())).stoppedBy).toBe('done');
  });

  it('does not count an article that scored below the render gate', async () => {
    await seedScored(50, { relevance: 0.2 });
    await serveFresh(3);

    expect((await advanceUntilDone(runFetch())).stoppedBy).toBe('done');
  });

  it('counts pending rows at the default yield (0.33): 10 relevant + 122 pending is expected to cover it', async () => {
    await seedScored(10);
    await seedUnscored(122);
    const { served } = await serveFresh(3);

    const out = await advanceUntilDone(runFetch());

    expect(out).toEqual({ stoppedBy: 'done', meteredBudget: 0 });
    expect(served.stats.requests).toEqual([]);
  });

  it('fetches for the remaining gap when pending rows fall just short: 120 pending leaves 0.4 of an article, so 2', async () => {
    await seedScored(10);
    await seedUnscored(120);
    await serveFresh(30);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(2); // ceil(0.4 / 0.33)
  });

  it('uses 0.33 as the yield until 20 rows are scored: 19 scored sizes the fetch at the 50 cap, not at the gap of 31', async () => {
    await seedScored(19);
    await serveFresh(60);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(50); // min(50, ceil(31 / 0.33) = 94)
  });

  it("from 20 scored rows on, uses this device's own pass ratio: 20 of 20 pass, so the gap of 30 is fetched as 30", async () => {
    await seedScored(20);
    await serveFresh(60);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(30);
  });

  it('a weaker device asks for more: 30 of 40 passing (0.75) with a gap of 20 fetches 27', async () => {
    await seedScored(30);
    await seedScored(10, { relevance: 0.1, prefix: 'miss' });
    await serveFresh(60);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(27); // ceil(20 / 0.75)
  });

  it('never fetches more than the day allowance has left, whatever the gap', async () => {
    await seedScored(40); // gap 10 at yield 1
    await setSetting('bg_articles_charged:2026-10-09', '120'); // 5 left of the Starter half
    await serveFresh(60);

    const out = await advanceUntilDone(runFetch());

    expect(out.meteredBudget).toBe(5);
  });
});

describe('what a run hydrates first, unless the foreground boot already did', () => {
  const OLD_METADATA = {
    articleCount: 40,
    relevantArticleCount: 12,
    hasGeneratedTopics: true,
    lastProcessingRunFinishedAt: 1_234_000,
    lastNewArticlesAt: 1_235_000,
  };

  it('reads the saved feed metadata before the run writes any, so the setters do not replace it with defaults', async () => {
    await persistFeedMetadata(OLD_METADATA);
    await serveFresh(3);

    await advanceUntilDone(runFetch());

    const after = await loadFeedMetadata();
    expect(after?.lastProcessingRunFinishedAt).toBe(1_234_000);
    expect(after?.hasGeneratedTopics).toBe(true);
  });

  it('treats an on-device reader as on-device: the processing mode is read from the DB, so the run submits nothing to the cloud', async () => {
    await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.Cloud); // an unhydrated store
    await serveFresh(4);

    await advanceUntilDone(runFetch());

    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.OnDevice);
    expect((await rowsById()).size).toBe(4); // fetched and persisted
    expect(gatewayCalls('job')).toEqual([]); // scoring needs the local model
  });

  it('hydrates nothing when the foreground boot already did (database-store is ready)', async () => {
    useDatabaseStore.setState({ ready: true });
    await setSetting('mera_processing_mode', ProcessingMode.OnDevice);
    await persistFeedMetadata(OLD_METADATA);
    await serveFresh(4);

    await advanceUntilDone(runFetch());

    // The stores are as the boot left them: the DB was not read for either. (An unhydrated
    // for-you store is exactly what overwrites the saved metadata, which is why the run hydrates
    // them first when the boot has not.)
    expect(useMeraProtocolStore.getState().processingMode).toBe(ProcessingMode.Cloud);
    expect((await loadFeedMetadata())?.lastProcessingRunFinishedAt ?? null).toBeNull();
  });
});
