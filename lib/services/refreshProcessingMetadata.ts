import logger from '@/lib/logger';
import { syncFeed } from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';

/**
 * Trigger a feed sync if the local store has no unscored suggestions.
 * Called on app start to ensure the feed is populated even when the
 * sync throttle is still warm from a prior session.
 */
export async function refreshProcessingMetadata(
  userPersonaId: string,
): Promise<void> {
  try {
    const localUnscored = useForYouStore.getState().unscoredCount;
    const localArticleCount = useForYouStore.getState().articleCount;
    if (localArticleCount === 0 && localUnscored === 0) {
      logger.info('[refreshProcessingMetadata] local store empty — forcing syncFeed');
      void syncFeed(userPersonaId);
    }
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'refreshProcessingMetadata' },
      extra: { userPersonaId },
    });
  }
}
