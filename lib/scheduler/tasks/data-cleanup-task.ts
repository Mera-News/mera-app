import { deleteOldSuggestions } from '@/lib/database/services/article-suggestion-service';
import { deleteOlderThan as deleteOldImpressions } from '@/lib/database/services/story-impression-service';
import { deleteOlderThan as deleteOldNotifications } from '@/lib/database/services/notification-service';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';
import { AppScheduler } from '../AppScheduler';
import { pruneOldJobs } from '../scheduler-persistence';

const SUGGESTION_TTL_MS = 48 * 60 * 60 * 1000;
const IMPRESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;

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

    const impressionCount = await deleteOldImpressions(Date.now() - IMPRESSION_TTL_MS);
    if (impressionCount > 0) {
      ctx.log(`pruned ${impressionCount} story impressions older than 30d`);
    }

    const notificationCount = await deleteOldNotifications(Date.now() - NOTIFICATION_TTL_MS);
    if (notificationCount > 0) {
      ctx.log(`pruned ${notificationCount} notifications older than 90d`);
    }
  },
});
