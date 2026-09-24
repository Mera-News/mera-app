// buildOverlayContext — the on-device LocalFeedbackContext the ••• sheet's feedback
// tree levels (FeedbackTreeLevel) gate and resolves against, built from a
// FeedbackSubject.
//
// Used by useArticleActions. It replaced two verbatim copies (the actions row
// and the old compact sheet) of the publication-visit lookup that both stopped there — so the gated
// nodes (`cluster_size_gte`, `from_context_geo`, `from_context_category`,
// `from_context_eventType`) were dead on those surfaces even though every field
// they need was already sitting on the local suggestion row. The Feed card and
// the detail screen use it too, so it also carries the article's own tags
// (primary entity, place filter value): without them the v5 tag leaves
// ("Show less of {{entity}}", "Less from this place") drop out silently.

import type { FeedbackSubject } from '@/components/custom/cards/feedback-subject';
import { getVisitCountForPublication } from '@/lib/database/services/publication-visit-service';
import logger from '@/lib/logger';
import type { LocalFeedbackContext } from '@/lib/news-harness/feedback-tree';

const firstNonBlank = (xs: readonly (string | null | undefined)[]): string | null =>
  xs.map((x) => x?.trim()).find((x) => !!x) ?? null;

/**
 * @param fallback what the host knows and the local row cannot supply: a
 *   standalone article on the detail screen has no row at all. The row always
 *   wins; the fallback only fills gaps.
 */
export async function buildOverlayContext(
  subject: FeedbackSubject,
  fallback?: Partial<LocalFeedbackContext>,
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
  let rowEntities: string[] = [];
  let rowPlaceValue: string | null = null;
  try {
    // Required at call time: the suggestion service reaches the WatermelonDB
    // singleton, and this module is reached from every card, which has no
    // business standing up the database just to draw a row of buttons. A
    // `require`, not `await import()`: jest cannot run a bare dynamic import.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { getSuggestionFeedbackContext } = require('@/lib/database/services/article-suggestion-service') as typeof import('@/lib/database/services/article-suggestion-service');
    const fb = await getSuggestionFeedbackContext({
      suggestionId: subject.suggestionId,
      articleId: subject.articleId,
    });
    if (fb) {
      category = category ?? fb.category;
      clusterSize = fb.clusterSize ?? null;
      geoText = fb.geoText ?? null;
      rowEntities = fb.entities ?? [];
      rowPlaceValue = fb.placeValue ?? null;
    }
  } catch (err) {
    logger.captureException(err, {
      tags: { component: 'buildOverlayContext', method: 'feedbackContext' },
    });
  }

  category = category ?? fallback?.category ?? null;
  clusterSize = clusterSize ?? fallback?.clusterSize ?? null;
  geoText = geoText ?? fallback?.geoText ?? null;
  // The PRIMARY entity (the server emits them most-central-first), so the
  // label and the filter it mints can never name different things. NOT
  // `geoText` for the place: that is display prose, a `place` filter needs
  // the tag's own field.
  const entity = firstNonBlank(rowEntities) ?? firstNonBlank(subject.entities ?? []) ?? fallback?.entity ?? null;
  const placeValue = rowPlaceValue ?? fallback?.placeValue ?? null;

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
    ...(entity ? { entity } : {}),
    ...(placeValue ? { placeValue } : {}),
  };
}

export default buildOverlayContext;
