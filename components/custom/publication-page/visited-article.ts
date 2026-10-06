// A visit row (`publication_visits`) as the article shape the compact card
// draws. Visits keep a snapshot of what the reader opened, so a story older
// than the server's 48h TTL still renders, and article-detail falls back to
// the same row when the server no longer has it.

import type { VisitedArticle } from '@/lib/database/services/publication-visit-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';

export function visitedToNewsArticle(v: VisitedArticle): NewsArticle {
    return {
        _id: v.articleId ?? v.articleUrl ?? '',
        title: v.titleOriginal ?? v.titleEn ?? '',
        title_en_internal_only: v.titleEn ?? undefined,
        pubDate: v.pubDate != null ? new Date(v.pubDate).toISOString() : '',
        image_url: v.imageUrl ?? undefined,
        article_url: v.articleUrl ?? undefined,
        original_language_code: v.languageCode ?? undefined,
        publicationSource:
            v.publicationName || v.countryCode
                ? ({
                      _id: v.articleId ?? v.articleUrl ?? '',
                      publication_name: v.publicationName,
                      country_code: v.countryCode,
                  } as NewsArticle['publicationSource'])
                : undefined,
    } as NewsArticle;
}
