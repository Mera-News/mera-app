// local-article-snapshot — the article-detail screen's fallbacks for when the
// live `articleById` query has nothing to give.
//
// Why this exists at all: an external news URL may now be opened from exactly
// ONE place, a detail screen, because that is where the read/translate block
// (ReadTranslateActions) lives. Every list surface — compact cards, the
// per-publication read history, Explore, story timelines — navigates here
// instead of opening the publisher page itself, so that a reader whose language
// differs from the article's always has the translate options in reach.
//
// That makes a dead-ended detail screen expensive: it costs the reader the
// article AND the translation. And dead ends are the common case for old
// stories — server articles are deleted after 48h (`v3_ingestedAt_ttl` on
// NewsArticle) while this device's read history keeps 30 days, so most rows in
// the per-publication history point at an article the server no longer has.
//
// Two local snapshots can stand in, tried in order of fidelity:
//   'saved' — a "save for later" row (a standalone article's saved row is keyed
//             by the article's own server id, see saved-article-suggestion-service).
//   'visit' — the publication-visit log, written every time the reader opened an
//             article. Its snapshot columns carry the title (both variants),
//             source language, image, publisher and — the two that actually
//             matter here — the article URL and its language.
//
// A VISIT row without an `article_url` is treated as no snapshot at all: that
// row exists only so the read/translate block stays reachable, and without a URL
// that block has nothing to act on. A SAVED row is kept regardless — it is the
// offline-reading path, where the title and description are the point.

import { getSavedSuggestionByServerId } from '@/lib/database/services/saved-article-suggestion-service';
import {
    getVisitedArticleById,
    type VisitedArticle,
} from '@/lib/database/services/publication-visit-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';

/** Where a rendered article came from when it did not come from the server. */
export type SnapshotSource = 'saved' | 'visit';

export interface LocalArticleSnapshot {
    readonly article: NewsArticle;
    readonly source: SnapshotSource;
}

/** Map a saved-suggestion snapshot (ForYouSuggestion) to the NewsArticle shape
 *  the detail screen renders. */
export const savedSuggestionToNewsArticle = (s: ForYouSuggestion): NewsArticle => ({
    _id: s.articleId,
    title: s.title_en ?? s.title_original ?? '',
    title_en_internal_only: s.title_en ?? undefined,
    description: s.description_en ?? undefined,
    description_en_internal_only: s.description_en ?? undefined,
    pubDate: s.firstPubDate ?? s.createdAt,
    article_url: s.article_url ?? undefined,
    image_url: s.image_url ?? undefined,
    original_language_code: s.language_code ?? undefined,
    publicationSource: s.publication_name || s.country_code
        ? ({
            _id: s.articleId,
            publication_name: s.publication_name,
            country_code: s.country_code,
        } as NewsArticle['publicationSource'])
        : undefined,
} as NewsArticle);

/** Map a publication-visit row to the same NewsArticle shape. */
export const visitToNewsArticle = (
    v: VisitedArticle,
    fallbackId: string,
): NewsArticle => ({
    _id: v.articleId ?? fallbackId,
    title: v.titleOriginal ?? v.titleEn ?? '',
    title_en_internal_only: v.titleEn ?? undefined,
    pubDate: v.pubDate != null ? new Date(v.pubDate).toISOString() : '',
    article_url: v.articleUrl ?? undefined,
    image_url: v.imageUrl ?? undefined,
    original_language_code: v.languageCode ?? undefined,
    publicationSource: v.publicationName || v.countryCode
        ? ({
            _id: v.articleId ?? fallbackId,
            publication_name: v.publicationName,
            country_code: v.countryCode,
        } as NewsArticle['publicationSource'])
        : undefined,
} as NewsArticle);

/**
 * Best local stand-in for `articleId`, or null when this device holds none.
 *
 * Never throws for a missing row — only a genuinely broken lookup propagates,
 * which the caller reports and treats as "no snapshot".
 */
export async function findLocalArticleSnapshot(
    articleId: string,
): Promise<LocalArticleSnapshot | null> {
    const saved = await getSavedSuggestionByServerId(articleId);
    if (saved) {
        return { article: savedSuggestionToNewsArticle(saved), source: 'saved' };
    }

    const visited = await getVisitedArticleById(articleId);
    if (visited?.articleUrl) {
        return { article: visitToNewsArticle(visited, articleId), source: 'visit' };
    }

    return null;
}
