import { deleteOldSuggestions } from '@/lib/database/services/article-suggestion-service';
import { deleteOlderThan as deleteOldImpressions } from '@/lib/database/services/story-impression-service';
import { deleteOlderThan as deleteOldNotifications } from '@/lib/database/services/notification-service';
import { deleteExpiredFactChecks } from '@/lib/database/services/fact-check-record-service';
import { deleteOrphanedRetention } from '@/lib/database/services/saved-article-suggestion-service';
import { refreshSuggestionsInStoreUnsafe } from '@/lib/services/SuggestionSyncService';
import { AppScheduler } from '../AppScheduler';
import { backgroundWorkIsIdle } from '../background-idle';
import { pruneOldJobs } from '../scheduler-persistence';

const SUGGESTION_TTL_MS = 48 * 60 * 60 * 1000;
const IMPRESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOTIFICATION_TTL_MS = 90 * 24 * 60 * 60 * 1000;
// Fact checks with an EMPTY checkedBy (nobody has published on the claim
// yet) are pruned 7 days after request — matching the server's re-check
// window, past which nobody is verifying that "nobody published" is still
// true. See `deleteExpiredFactChecks` in fact-check-record-service.ts for the
// full reasoning and why this is not a plain age sweep.
const FACT_CHECK_UNATTRIBUTED_TTL_MS = 7 * 24 * 60 * 60 * 1000;
// And an outer cap that applies to EVERY fact check, attributed or not, set to
// the server's own retention so the device never holds a verdict the server has
// already forgotten. Attributed rows were previously kept forever, which quietly
// assumed a published rating never changes — fact-checkers do revise and retract,
// and a stale verdict still carries the organisation's name.
const FACT_CHECK_MAX_TTL_MS = 90 * 24 * 60 * 60 * 1000;

AppScheduler.register({
  name: 'data-cleanup',
  displayName: 'Data Cleanup',
  frequency: 24 * 60 * 60 * 1000,
  triggers: [],
  // db-ready + idle: a low-priority sweep that defers to the feed sync /
  // inference queue and re-checks on the next tick when the app is busy.
  conditions: [{ type: 'db-ready' }, { type: 'custom', check: backgroundWorkIsIdle }],
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

    const factCheckCount = await deleteExpiredFactChecks(
      Date.now() - FACT_CHECK_UNATTRIBUTED_TTL_MS,
      Date.now() - FACT_CHECK_MAX_TTL_MS,
    );
    if (factCheckCount > 0) {
      ctx.log(`pruned ${factCheckCount} fact checks (unattributed >7d, any >90d)`);
    }

    // After the fact-check sweep: drop retention snapshots in
    // saved_article_suggestions that NO reason still holds — neither a
    // fact_checks row nor an active followed story's member snapshots. This is
    // the ONLY sweep those rows get; it also catches rows orphaned by a backup
    // restore, since the saved table is backed up and fact_checks and tracked
    // stories are not necessarily in step with it.
    const retentionCount = await deleteOrphanedRetention();
    if (retentionCount > 0) {
      ctx.log(`released ${retentionCount} unreferenced retained article snapshots`);
    }
  },
});
