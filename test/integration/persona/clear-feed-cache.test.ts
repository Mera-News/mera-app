// clearFeedCacheAndResync: the shared clear used by Observability's "Clear feed cache"
// and Your data's "Clear profile". The ORDER is the contract (see the module header):
// clearData, then the feed order reset, then the scoring-run abort, then the sync.

const mockCalls: string[] = [];
let mockFeedSyncRunning = false;

jest.mock('@/lib/stores', () => ({
  useForYouStore: {
    getState: () => ({
      clearData: jest.fn(async () => {
        mockCalls.push('clearData');
      }),
    }),
  },
}));
jest.mock('@/lib/stores/feed-order-store', () => ({
  useFeedOrderStore: { getState: () => ({ reset: () => mockCalls.push('feedOrderReset') }) },
}));
jest.mock('@/lib/services/scoring-pipeline', () => ({
  abortRun: jest.fn(async (reason: string) => {
    mockCalls.push(`abortRun:${reason}`);
  }),
}));
jest.mock('@/lib/scheduler/scheduler-store', () => ({
  useSchedulerStore: { getState: () => ({ isRunning: (task: string) => task === 'feed-sync' && mockFeedSyncRunning }) },
}));
jest.mock('@/lib/scheduler/AppScheduler', () => ({
  AppScheduler: {
    trigger: jest.fn(async (task: string) => {
      mockCalls.push(`trigger:${task}`);
    }),
  },
}));

import { clearFeedCacheAndResync } from '@/components/custom/config-mera/clear-feed-cache';

describe('clearFeedCacheAndResync', () => {
  beforeEach(() => {
    mockCalls.length = 0;
    mockFeedSyncRunning = false;
  });

  it('clears, resets the order, aborts the scoring run, then syncs, in that order', async () => {
    await clearFeedCacheAndResync();
    expect(mockCalls).toEqual(['clearData', 'feedOrderReset', 'abortRun:cache-clear', 'trigger:feed-sync']);
  });

  it('does not start a second feed sync while one is running', async () => {
    mockFeedSyncRunning = true;
    await clearFeedCacheAndResync();
    expect(mockCalls).toEqual(['clearData', 'feedOrderReset', 'abortRun:cache-clear']);
  });
});
