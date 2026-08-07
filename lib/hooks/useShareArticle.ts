// useShareArticle — shares an article's title/URL/download link via the
// native share sheet. Picks the title the user actually sees on screen
// (original if the article is in the user's app language, otherwise the
// English title), matching the copy previously used by ShareArticleButton.
// Only that ONE title ships — the variant currently displayed — never a
// second, original-language line alongside it.
//
// The "Shared via" footer goes out in the LANGUAGE OF THAT TITLE, not the
// sharer's UI language — a German headline followed by a Hindi footer reads as
// a bug to whoever receives it.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Share } from 'react-native';
import { WEBSITE_URL } from '../config/branding';
import logger from '../logger';
import { secureUrlOrNull } from '../secure-url';
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
 * Resolves the single title that goes in a shared article's message: the
 * title the sharer was actually looking at. That's the exact on-screen
 * variant (`displayedTitle`) when the caller supplies one (detail screens,
 * which track the original/translation toggle), otherwise the same
 * status-based original/English pick a toggle-less surface (e.g. a feed
 * card) would have rendered. Only ever one language ships — never the
 * original-language title alongside it.
 */
export function resolveShareTitles(params: {
    titleEnglish: string | null;
    titleOriginal?: string | null;
    status: TranslatableStatus;
    displayedTitle?: string | null;
}): { primary: string | null } {
    const {
        titleEnglish, titleOriginal, status, displayedTitle,
    } = params;
    const primary = displayedTitle
        ? displayedTitle
        : status === 'same-language'
            ? (titleOriginal ?? titleEnglish)
            : (titleEnglish ?? titleOriginal);
    return { primary: primary ?? null };
}

/**
 * Assembles the final share message: the title, the URL, then the "Shared
 * via" footer, each block separated by a blank line.
 */
export function buildShareMessage(params: {
    primaryTitle: string | null;
    url: string | null | undefined;
    footer: string;
}): string {
    const { primaryTitle, url, footer } = params;
    return [primaryTitle, url, footer].filter(Boolean).join('\n\n');
}

export function useShareArticle(params: ShareArticleParams | undefined): () => Promise<void> {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    return useCallback(async () => {
        // Backstop for the https guard (item 16). The detail screens already
        // refuse to render a share affordance for an insecure URL, so this only
        // fires for a stale local row that slipped past them — sharing one would
        // push a plaintext link out to somebody else's device, which is strictly
        // worse than opening it on this one.
        if (!params?.url) return;
        if (!secureUrlOrNull(params.url)) return;

        const {
            url, titleEnglish, titleOriginal, sourceLanguage, displayedTitle, displayedLanguage,
        } = params;
        const status = getArticleTranslatableStatus(sourceLanguage ?? null, appLanguage);
        const { primary: title } = resolveShareTitles({
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
                primaryTitle: title, url: shareUrl, footer,
            });
            await Share.share({ message }, { subject: title ?? undefined });
        } catch (err) {
            logger.captureException(err, { tags: { hook: 'useShareArticle' } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params, appLanguage, t]);
}
