// useShareArticle — shares an article's title/URL/download link via the
// native share sheet. Picks the title the user actually sees on screen
// (original if the article is in the user's app language, otherwise the
// English title), matching the copy previously used by ShareArticleButton.

import { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Share } from 'react-native';
import { WEBSITE_URL } from '../config/branding';
import logger from '../logger';
import { useAppLanguage } from '../stores/app-language-store';
import { getArticleTranslatableStatus } from '../translation-service';
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
}

export function useShareArticle(params: ShareArticleParams | undefined): () => Promise<void> {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    return useCallback(async () => {
        if (!params?.url) return;

        const { url, titleEnglish, titleOriginal, sourceLanguage, displayedTitle } = params;
        const status = getArticleTranslatableStatus(sourceLanguage ?? null, appLanguage);
        // Prefer the title variant the user is actually looking at; otherwise
        // fall back to the status-based original/English pick.
        const title = displayedTitle
            ? displayedTitle
            : status === 'same-language'
                ? (titleOriginal ?? titleEnglish)
                : (titleEnglish ?? titleOriginal);
        // Attribute the shared link to Mera with a share-specific UTM medium.
        const shareUrl = url ? appendReferrer(url, 'share') : url;

        try {
            const message = [title, shareUrl, t('articleDetail.shareVia', { downloadUrl: WEBSITE_URL })]
                .filter(Boolean)
                .join('\n\n');
            await Share.share({ message }, { subject: title ?? undefined });
        } catch (err) {
            logger.captureException(err, { tags: { hook: 'useShareArticle' } });
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [params, appLanguage, t]);
}
