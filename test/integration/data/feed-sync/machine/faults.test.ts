// Faults injected into the machine's own bookkeeping, through call-through spies on two real module
// exports (R23): the status publisher on the done path, and the snapshot write on the failed path.
// Real machine, steps, in-memory DB, MSW and for-you store; only the clock, the logger and
// expo-keep-awake are faked. Added by data-U6d.
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

import * as persistence from '@/lib/scheduler/feed-sync/feed-sync-persistence';
import * as status from '@/lib/scheduler/feed-sync/feed-sync-status';
import { InvalidTransitionError } from '@/lib/scheduler/feed-sync/feed-sync-types';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { advanceUntilDone, mockGqlError, server } from '@/test/helpers';
import { cleanupFeedSync, ids, resetFeedSyncMemory, resetScoringWorld, spyOnExport } from '../steps/support';
import { feedSyncMachine, loadMachineSnapshot, serveNew, settleMachine, startMachine, watchScoring } from './support';

jest.setTimeout(60_000);

const store = () => useForYouStore.getState();
const run = () => advanceUntilDone(startMachine());

describe('FeedSyncMachine bookkeeping faults', () => {
  beforeEach(async () => {
    resetFeedSyncMemory();
    await resetScoringWorld();
    watchScoring();
  });
  afterEach(async () => {
    await settleMachine();
    cleanupFeedSync();
  });

  describe('a fault after the run reached done', () => {
    it('rethrows the fault itself and does not turn the finished run into a failed one', async () => {
      await serveNew(ids(4));
      const planted = new Error('done publish exploded');
      const original = status.publishSyncStatus;
      let thrown = false;
      spyOnExport(status, 'publishSyncStatus').mockImplementation((state, overrides) => {
        if (state === 'done' && !thrown) {
          thrown = true;
          throw planted;
        }
        return original(state, overrides);
      });

      const failure = await run().then(
        () => null,
        (e: unknown) => e,
      );

      expect(failure).toBe(planted);
      expect(failure).not.toBeInstanceOf(InvalidTransitionError);
      expect(feedSyncMachine.state).toBe('done');
      expect(store().syncStatusMessage?.state).not.toBe('failed');
      expect((await loadMachineSnapshot())?.state).not.toBe('failed');
    });
  });

  describe('DA19: a run that fails while its failed snapshot cannot be written', () => {
    // The persona query is refused with a non-retryable error whose message classifies to a code.
    const refusePersonaQuery = async () => {
      await serveNew(ids(3));
      server.use(mockGqlError('GetArticleIdsForPersona', 'BAD_USER_INPUT', { message: 'storage backend refused the persona query' }));
    };
    const failSnapshotWriteOnce = () => {
      const original = persistence.saveMachineSnapshot;
      let rejected = false;
      spyOnExport(persistence, 'saveMachineSnapshot').mockImplementation(async (snapshot) => {
        if (snapshot.state === 'failed' && !rejected) {
          rejected = true;
          throw new Error('snapshot write failed');
        }
        return original(snapshot);
      });
    };

    test.failing("DA19: a failed snapshot write does not replace the run's error", async () => {
      await refusePersonaQuery();
      failSnapshotWriteOnce();

      await expect(run()).rejects.toThrow('storage backend refused the persona query');

      expect(store().syncStatusMessage).toEqual(expect.objectContaining({ state: 'failed', errorCode: 'storage-error' }));
    });

    it('DA19 today: start() rejects with the snapshot error, after the run\'s own code was published', async () => {
      await refusePersonaQuery();
      failSnapshotWriteOnce();

      await expect(run()).rejects.toThrow('snapshot write failed');

      expect(store().syncStatusMessage).toEqual(expect.objectContaining({ state: 'failed', errorCode: 'storage-error' }));
    });
  });
});
