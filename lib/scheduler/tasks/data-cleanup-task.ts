import { pruneOldJobs } from '../scheduler-persistence';
import { AppScheduler } from '../AppScheduler';
import { deleteOldSuggestions } from '@/lib/database/services/article-suggestion-service';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';

const SUGGESTION_TTL_MS = 48 * 60 * 60 * 1000;

AppScheduler.register({
  name: 'data-cleanup',
  displayName: 'Data Cleanup',
  frequency: 24 * 60 * 60 * 1000,
  triggers: [],
  conditions: [{ type: 'db-ready' }],
  timeout: 30_000,
  maxAttempts: 2,
  exclusive: true,
  handler: async (_input, ctx) => {
    await pruneOldJobs();

    const deletedCount = await deleteOldSuggestions(Date.now() - SUGGESTION_TTL_MS);
    if (deletedCount > 0) {
      ctx.log(`pruned ${deletedCount} suggestions older than 48h`);
      await refreshSuggestionsInStoreUnsafe();
    }
  },
});
