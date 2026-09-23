// The article actions that more than one surface performs, in ONE place.
//
// "Open on source" used to live inside each detail screen's
// `handleArticleUrlPress`, and the ••• menu now offers it from every card too.
// It carries two obligations that are easy to drop when copied: the https
// guard (never open a plaintext article URL) and the publication-visit record
// that backs History ("publishers you visited"). A card path that skipped the
// record would make History silently incomplete, so there is one function.

import type { NewsArticle } from '@/lib/generated/graphql-types';
import logger from '@/lib/logger';
import {
    recordPublicationVisit,
    type RecordPublicationVisitInput,
} from '@/lib/database/services/publication-visit-service';
import { secureUrlOrNull } from '@/lib/secure-url';
import type { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { buildGoogleTranslateUrl } from '@/lib/translation-service';
import { openArticleInAppBrowser, openInAppBrowser, appendReferrer } from '@/lib/web-browser-utils';

/** What a publication visit records, minus the URL (resolved at open time). */
export type VisitInput = Omit<RecordPublicationVisitInput, 'articleUrl'>;

/**
 * Open the article at its publisher. Refuses a non-https URL (returns false,
 * opens nothing, records nothing), records the publication visit that backs
 * History, then opens the in-app browser. Returns whether it opened.
 */
export async function openOnSource(
    rawUrl: string | null | undefined,
    visit?: VisitInput,
): Promise<boolean> {
    const url = secureUrlOrNull(rawUrl);
    if (!url) return false;
    if (visit) {
        recordPublicationVisit({ ...visit, articleUrl: url }).catch(() => {});
    }
    try {
        await openArticleInAppBrowser(url);
        return true;
    } catch (err) {
        logger.captureException(err, { tags: { module: 'article-actions', method: 'openOnSource' } });
        return false;
    }
}

/** Open the article through Google Translate in the reader's language. Same
 *  https refusal as {@link openOnSource}. Returns whether it opened. */
export async function openInGoogleTranslate(
    rawUrl: string | null | undefined,
    appLanguage: string,
): Promise<boolean> {
    const url = secureUrlOrNull(rawUrl);
    if (!url) return false;
    try {
        await openInAppBrowser(buildGoogleTranslateUrl(appendReferrer(url), appLanguage));
        return true;
    } catch (err) {
        logger.captureException(err, { tags: { module: 'article-actions', method: 'openInGoogleTranslate' } });
        return false;
    }
}

/** True when the article is NOT in the reader's language (primary subtag). An
 *  unknown article language counts as foreign: offering the translate route
 *  costs nothing when it turns out not to be needed. */
export function isForeignLanguage(
    languageCode: string | null | undefined,
    appLanguage: string | null | undefined,
): boolean {
    if (!languageCode || !appLanguage) return true;
    return languageCode.split('-')[0].toLowerCase() !== appLanguage.split('-')[0].toLowerCase();
}

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
