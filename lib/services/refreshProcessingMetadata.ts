import { ArticleService } from '@/lib/article-service';
import logger from '@/lib/logger';
import { syncFeed } from '@/lib/services/SuggestionSyncService';
import { useForYouStore } from '@/lib/stores/for-you-store';

/**
 * Fetch system-wide + per-user processing metadata and write the system-wide
 * article count into the For You store. Called on every app start, decoupled
 * from the syncFeed throttle so the protocol-status counter reflects fresh
 * server state even when the cached id-set is still warm.
 *
 * When the server reports unscored cluster suggestions but the local store
 * has nothing to process, force a syncFeed so the user isn't stuck staring
 * at an empty feed because the 1-hour id-set throttle is still warm.
 */
export async function refreshProcessingMetadata(
  userPersonaId: string,
): Promise<void> {
  try {
    const metadata =
      await ArticleService.getServerProcessingMetadataForUser(userPersonaId);
    useForYouStore.setState({ articleCount: metadata.totalArticlesToday });
    logger.info(
      `[refreshProcessingMetadata] totalArticlesToday=${metadata.totalArticlesToday} articleSuggestionCountForUser=${metadata.articleSuggestionCountForUser}`,
    );

    const localUnscored = useForYouStore.getState().unscoredCount;
    if (metadata.articleSuggestionCountForUser > 0 && localUnscored === 0) {
      logger.info(
        `[refreshProcessingMetadata] server has ${metadata.articleSuggestionCountForUser} suggestions but local unscored=0 — forcing syncFeed`,
      );
      void syncFeed(userPersonaId, { force: true });
    }
  } catch (error) {
    logger.captureException(error, {
      tags: { service: 'refreshProcessingMetadata' },
      extra: { userPersonaId },
    });
  }
}
