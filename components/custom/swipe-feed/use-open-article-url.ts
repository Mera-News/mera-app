// use-open-article-url — opens a suggestion's ORIGINAL publisher article URL in
// the in-app browser, recording a publication visit first. This mirrors the
// suggestion-detail screen's "Read on {publication}" button
// (ArticleSuggestionScreen.handleArticleUrlPress) so the Feed deck's read button
// takes the exact same action, reusing the shared browser + visit utils. No-op
// when the suggestion has no article URL.

import { useCallback } from 'react';
import { recordPublicationVisit } from '@/lib/database/services/publication-visit-service';
import { openArticleInAppBrowser } from '@/lib/web-browser-utils';
import logger from '@/lib/logger';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

export function useOpenArticleUrl() {
  return useCallback(async (suggestion: ForYouSuggestion) => {
    const url = suggestion.article_url;
    if (!url) return;
    recordPublicationVisit({
      publicationName: suggestion.publication_name,
      countryCode: suggestion.country_code,
      articleId: suggestion.articleId,
      articleSuggestionId: suggestion._id,
      articleUrl: url,
      titleEn: suggestion.title_en,
      languageCode: suggestion.language_code,
      imageUrl: suggestion.image_url,
      pubDate: suggestion.firstPubDate ?? suggestion.createdAt,
    }).catch(() => {});
    try {
      await openArticleInAppBrowser(url);
    } catch (err) {
      logger.captureException(err, {
        tags: { component: 'swipe-feed', method: 'openArticleUrl' },
      });
    }
  }, []);
}
