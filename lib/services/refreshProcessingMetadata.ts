import logger from '@/lib/logger';
import { AppScheduler } from '@/lib/scheduler/AppScheduler';
import { useForYouStore } from '@/lib/stores/for-you-store';

/**
 * Trigger a feed sync if the local store has no unscored suggestions.
 * Called on app start to ensure the feed is populated even when the
 * sync throttle is still warm from a prior session.
 */
export async function refreshProcessingMetadata(
  _userPersonaId: string,
): Promise<void> {
  try {
    const localUnscored = useForYouStore.getState().unscoredCount;
    const localArticleCount = useForYouStore.getState().articleCount;
    if (localArticleCount === 0 && localUnscored === 0) {
      logger.info('[refreshProcessingMetadata] local store empty — forcing feed-sync');
      void AppScheduler.trigger('feed-sync');
    }
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'refreshProcessingMetadata' },
    });
  }
}
