// for-you-store.hydrateMetadataFromDb beside a REAL scoring run in flight: a first sync hands
// articles to the real pipeline, which submits them to the gateway mock, and the mock leaves the
// jobs unfinished (`pendingPolls`). The header's phase and progress must come back from that
// persisted run after a cold start, and read idle once the run is over.
// The success path crosses `await import('@/lib/services/scoring-pipeline')`, which the legacy suite
// could only run into its catch.
jest.mock('@/lib/logger', () => ({
  __esModule: true,
  default: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    captureException: jest.fn(),
    captureMessage: jest.fn(),
    addBreadcrumb: jest.fn(),
  },
}));
jest.mock('expo-keep-awake', () => ({
  activateKeepAwakeAsync: jest.fn(async () => undefined),
  deactivateKeepAwake: jest.fn(),
}));

import logger from '@/lib/logger';
import { getPipelineUiState } from '@/lib/services/scoring-pipeline';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone, assertNoGatewayViolations } from '@/test/helpers';
import { cleanupFeedSync, ids, resetFeedSyncMemory, resetScoringWorld, tick, tickUntilScored } from '../../feed-sync/steps/support';
import { buildRunningPipeline, serveNew, settleMachine, startMachine, watchScoring } from '../../feed-sync/machine/support';
import { resetStore } from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();

/** The header fields the run drives, as the live pipeline last pushed them. */
const headerFields = () => {
  const s = store();
  return {
    asyncJobPhase: s.asyncJobPhase,
    asyncJobProcessedCount: s.asyncJobProcessedCount,
    asyncJobTotalCount: s.asyncJobTotalCount,
    batchProgress: s.batchProgress,
    chunkStates: s.chunkStates,
    reasonsInFlightIds: [...s.reasonsInFlightIds].sort(),
  };
};

describe('hydrateMetadataFromDb with a scoring run in flight', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
    assertNoGatewayViolations();
  });

  it('reads the relevance phase, the article and batch progress and the chunk strip from the persisted run', async () => {
    await buildRunningPipeline(6);
    resetStore(useForYouStore); // a cold start: nothing in memory

    await store().hydrateMetadataFromDb();

    expect(store().asyncJobPhase).toBe('relevance');
    expect(store().asyncJobTotalCount).toBe(6);
    expect(store().asyncJobProcessedCount).toBe(0); // relevance is not known for any of them yet
    expect(store().batchProgress).toEqual({ done: 0, total: 6 });
    expect(store().chunkStates).toEqual({ chunks: ['in-flight', 'queued'], ready: 0, total: 2 });
    // the import ran: a failed one would have been swallowed into the catch and reported
    expect((logger.captureException as jest.Mock).mock.calls.filter((c) => c[1]?.tags?.method === 'hydrateMetadataFromDb')).toEqual([]);
  });

  it('shows after a cold start exactly what the live run last showed', async () => {
    await buildRunningPipeline(6);
    const live = headerFields();
    expect(live.asyncJobPhase).not.toBe('idle'); // the live pipeline did push progress
    resetStore(useForYouStore);
    expect(headerFields().asyncJobPhase).toBe('idle');

    await store().hydrateMetadataFromDb();

    expect(headerFields()).toEqual(live);
  });

  it('agrees with the pipeline\'s own question about the run', async () => {
    await buildRunningPipeline(6);
    const { phase, processedCount, totalCount } = await getPipelineUiState();
    resetStore(useForYouStore);

    await store().hydrateMetadataFromDb();

    expect(store().asyncJobPhase).toBe(phase);
    expect(store().asyncJobProcessedCount).toBe(processedCount);
    expect(store().asyncJobTotalCount).toBe(totalCount);
  });

  it('reads idle with no batch progress and no strip once the run has finished', async () => {
    await serveNew(ids(5)); // the default gateway answers every job
    await advanceUntilDone(startMachine());
    await advanceUntilDone(tickUntilScored(5));
    for (let i = 0; i < 30 && (await getPipelineUiState()).phase !== 'idle'; i++) await advanceUntilDone(tick());
    expect((await getPipelineUiState()).phase).toBe('idle');
    resetStore(useForYouStore);
    useForYouStore.setState({ asyncJobPhase: 'relevance', asyncJobProcessedCount: 3, asyncJobTotalCount: 5, batchProgress: { done: 3, total: 5 } });

    await store().hydrateMetadataFromDb();

    expect(store()).toMatchObject({
      asyncJobPhase: 'idle',
      asyncJobProcessedCount: 0,
      asyncJobTotalCount: 0,
      batchProgress: null,
      chunkStates: null,
    });
    expect(store().reasonsInFlightIds.size).toBe(0);
  });
});
