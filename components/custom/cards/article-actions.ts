// What a card's publication visit records, built from either article shape.
// The ••• menu reads the publication from it when its subject names none.

import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { RecordPublicationVisitInput } from '@/lib/database/services/publication-visit-service';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** What a publication visit records, minus the URL (resolved at open time). */
export type VisitInput = Omit<RecordPublicationVisitInput, 'articleUrl'>;

export function visitFromSuggestion(s: ForYouSuggestion): VisitInput {
    return {
        publicationName: s.publication_name,
        countryCode: s.country_code,
        articleId: s.articleId,
        articleSuggestionId: s._id,
        titleEn: s.title_en,
        languageCode: s.language_code,
        imageUrl: s.image_url,
        pubDate: s.firstPubDate ?? s.createdAt,
    };
}

export function visitFromArticle(a: NewsArticle): VisitInput {
    return {
        publicationName: a.publicationSource?.publication_name ?? null,
        countryCode: a.publicationSource?.country_code ?? null,
        articleId: a._id,
        titleEn: a.title_en_internal_only ?? a.title ?? null,
        titleOriginal: a.title ?? null,
        languageCode: a.original_language_code ?? null,
        imageUrl: a.image_url ?? null,
        pubDate: a.pubDate ?? null,
    };
}
