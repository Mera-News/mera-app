// useShareArticle — shares an article's title/URL/download link via the
// native share sheet. Picks the title the user actually sees on screen
// (original if the article is in the user's app language, otherwise the
// English title), matching the copy previously used by ShareArticleButton.
// When that title differs from the article's original-language title, BOTH
// are included (see resolveShareTitles) — otherwise a translated headline
// ships next to an untranslated-language link with nothing to connect the
// two for the recipient.
//
// The "Shared via" footer goes out in the LANGUAGE OF THAT TITLE, not the
// sharer's UI language — a German headline followed by a Hindi footer reads as
// a bug to whoever receives it.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Share } from 'react-native';
import { WEBSITE_URL } from '../config/branding';
import logger from '../logger';
import { useAppLanguage } from '../stores/app-language-store';
import {
    getArticleTranslatableStatus, resolveUiLocale, type TranslatableStatus,
} from '../translation-service';
import { appendReferrer } from '../web-browser-utils';

export interface ShareArticleParams {
    url: string | null | undefined;
    titleEnglish: string | null;
    titleOriginal?: string | null;
    sourceLanguage?: string | null;
    /** The exact title variant the user currently sees on screen (original vs
     *  translated). When non-empty, it is shared verbatim — so a shared article
     *  carries whichever title the reader was looking at. Falls back to the
     *  status-based original/English pick when absent. */
    displayedTitle?: string | null;
    /** Language of {@link displayedTitle}. Drives the footer's language so the
     *  attribution line matches the headline above it. Absent (feed cards, which
     *  have no original/translation toggle) ⇒ footer stays in the app language. */
    displayedLanguage?: string | null;
}

/**
 * Resolves which title(s) go in a shared article's message.
 *
 * `primary` is the title the sharer was actually looking at: the exact
 * on-screen variant (`displayedTitle`) when the caller supplies one (detail
 * screens, which track the original/translation toggle), otherwise the same
 * status-based original/English pick a toggle-less surface (e.g. a feed
 * card) would have rendered.
 *
 * `secondary` is the article's original-language title — included ONLY when
 * it's a different string from `primary`. An English article, or a reader
 * who was already viewing the original, therefore still produces a single
 * title line: today's payload shape for those cases is unchanged. This is
 * the fix for the cross-language share bug: previously a translated title
 * went out paired with the untranslated-language link and nothing tied the
 * two together for the recipient; now the original-language title rides
 * along whenever it would read as a mismatch.
 */
export function resolveShareTitles(params: {
    titleEnglish: string | null;
    titleOriginal?: string | null;
    status: TranslatableStatus;
    displayedTitle?: string | null;
}): { primary: string | null; secondary: string | null } {
    const {
        titleEnglish, titleOriginal, status, displayedTitle,
    } = params;
    const primary = displayedTitle
        ? displayedTitle
        : status === 'same-language'
            ? (titleOriginal ?? titleEnglish)
            : (titleEnglish ?? titleOriginal);
    const primaryTrimmed = (primary ?? '').trim();
    const secondary =
        titleOriginal && titleOriginal.trim() && titleOriginal.trim() !== primaryTrimmed
            ? titleOriginal
            : null;
    return { primary: primary ?? null, secondary };
}

/**
 * Assembles the final share message: title line(s), the URL, then the
 * "Shared via" footer, each block separated by a blank line. The optional
 * secondary (original-language) title sits directly under the primary title
 * — no label, so the two-title case needs no new copy to translate.
 */
export function buildShareMessage(params: {
    primaryTitle: string | null;
    secondaryTitle: string | null;
    url: string | null | undefined;
    footer: string;
}): string {
    const {
        primaryTitle, secondaryTitle, url, footer,
    } = params;
    const titleBlock = primaryTitle && secondaryTitle
        ? `${primaryTitle}\n${secondaryTitle}`
        : (primaryTitle ?? secondaryTitle ?? null);
    return [titleBlock, url, footer].filter(Boolean).join('\n\n');
}

export function useShareArticle(params: ShareArticleParams | undefined): () => Promise<void> {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    return useCallback(async () => {
        if (!params?.url) return;

        const {
            url, titleEnglish, titleOriginal, sourceLanguage, displayedTitle, displayedLanguage,
        } = params;
        const status = getArticleTranslatableStatus(sourceLanguage ?? null, appLanguage);
        const { primary: title, secondary: secondaryTitle } = resolveShareTitles({
            titleEnglish, titleOriginal, status, displayedTitle,
        });
        // Attribute the shared link to Mera with a share-specific UTM medium.
        const shareUrl = url ? appendReferrer(url, 'share') : url;

        // Falls back to the sharer's own language when the app ships no strings
        // for the title's language — most feed source languages have no bundle,
        // and `fallbackLng: 'en'` would silently hand back English otherwise.
        const footerLng = resolveUiLocale(displayedLanguage) ?? appLanguage;

        try {
            const footer = t('articleDetail.shareVia', {
                downloadUrl: WEBSITE_URL,
                lng: footerLng,
            });
            const message = buildShareMessage({
                primaryTitle: title, secondaryTitle, url: shareUrl, footer,
            });
            await Share.share({ message }, { subject: title ?? undefined });
        } catch (err) {
            logger.captureException(err, { tags: { hook: 'useShareArticle' } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params, appLanguage, t]);
}
