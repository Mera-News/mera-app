// Gaps the core/sync suites left: the hard-filter label refresh at the end of a store refresh is
// derived and non-fatal. If its persona read fails, the failure is captured and the refresh still
// lands the rows (SuggestionSyncService, the `refreshHardFilterLabels` catch).
//
// Fault at the DB seam: every read of persona_suppressions throws (the label refresh loads the
// persona snapshot), while the suggestions read the refresh does first is untouched.
import {
  __resetSuggestionsRefreshThrottleForTests,
  refreshSuggestionsInStoreUnsafe,
} from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';
import { useHardFilterLabelStore } from '@/lib/stores/hard-filter-label-store';
import { failAllReads, quietLogger, resetForYouStore, seedArticles, settleWrites } from './seed';

describe('store refresh: hard-filter label failure', () => {
  let logs: ReturnType<typeof quietLogger>;

  beforeEach(() => {
    logs = quietLogger();
    __resetSuggestionsRefreshThrottleForTests();
    resetForYouStore();
    useHardFilterLabelStore.getState().clear();
  });

  afterEach(async () => {
    await settleWrites();
    __resetSuggestionsRefreshThrottleForTests();
    logs.restore();
  });

  it('captures the failure with its tags and still puts the rows in the store', async () => {
    await seedArticles([{ id: 'a' }, { id: 'b' }]);
    const err = new Error('persona unavailable');
    const restore = failAllReads('persona_suppressions', err);

    try {
      await expect(refreshSuggestionsInStoreUnsafe()).resolves.toBeUndefined();
    } finally {
      restore();
    }

    expect(logs.captureException).toHaveBeenCalledWith(err, {
      tags: { service: 'SuggestionSyncService', method: 'refreshHardFilterLabels' },
    });
    expect(
      useForYouStore
        .getState()
        .suggestions.map((s) => s._id)
        .sort(),
    ).toEqual(['a', 'b']);
  });
});
