// buildOverlayContext — the on-device LocalFeedbackContext the modal feedback
// tree (FeedbackTreeOverlay) gates and resolves against, built from a
// FeedbackSubject.
//
// Shared by ArticleActionsRow and CompactActionsSheet, which had two verbatim
// copies of the publication-visit lookup and both stopped there — so the gated
// nodes (`cluster_size_gte`, `from_context_geo`, `from_context_category`,
// `from_context_eventType`) were dead on those surfaces even though every field
// they need was already sitting on the local suggestion row. This is the same
// derivation the Feed's inline tree does in `InlineFeedbackTree.buildLocalContext`.

import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';

export async function buildOverlayContext(
  subject: FeedbackSubject,
): Promise<LocalFeedbackContext> {
  let publicationVisits = 0;
  const pub = subject.publicationName?.trim();
  if (pub) {
    try {
      publicationVisits = await getVisitCountForPublication(pub, subject.countryCode ?? null);
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'buildOverlayContext', method: 'visitCount' },
      });
    }
  }

  // Category / cluster size / place come off the local suggestion row when one
  // exists. A standalone article simply has none, and the tree gates out the
  // nodes that need them (evaluateCondition / resolveLeafActions tolerate it).
  let category = subject.category ?? null;
  let clusterSize: number | null = null;
  let geoText: string | null = null;
  try {
    // Dynamic: the suggestion service reaches the WatermelonDB singleton, and
    // this module is imported by the card action rows — which render in suites
    // (and on surfaces) that have no business standing up the database just to
    // draw a row of buttons.
    const { getSuggestionFeedbackContext } = await import(
      '@/lib/database/services/article-suggestion-service'
    );
    const fb = await getSuggestionFeedbackContext({
      suggestionId: subject.suggestionId,
      articleId: subject.articleId,
    });
    if (fb) {
      category = category ?? fb.category;
      clusterSize = fb.clusterSize ?? null;
      geoText = fb.geoText ?? null;
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'buildOverlayContext', method: 'feedbackContext' },
    });
  }

  return {
    publicationName: subject.publicationName,
    countryCode: subject.countryCode,
    articleTitle: subject.title,
    matchedTopics: subject.matchedTopics ?? [],
    publicationVisits,
    ...(category ? { category } : {}),
    ...(subject.eventType ? { eventType: subject.eventType } : {}),
    ...(clusterSize != null ? { clusterSize } : {}),
    ...(geoText ? { geoText } : {}),
  };
}

export default buildOverlayContext;
