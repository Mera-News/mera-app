// The meta row's three spoken strings (publication, age, language), in ONE
// place: ArticleMetaRow draws them, and the card roots read them in their
// explicit accessibility label, so the two can never say different things.

import { getLocalizedLanguageName } from '@/lib/language-names';
import { useTimeTick } from '@/lib/time-tick';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { useTranslation } from 'react-i18next';

export interface ArticleMetaStrings {
    /** Shown EXACTLY as stored (owner decision). '' when absent. */
    publication: string;
    /** The relative age, on the shared 60s clock. */
    age: string;
    /** The article's language, named in the reader's language. '' when unknown. */
    language: string;
}

export function useArticleMetaStrings(
    pubDate: string | null | undefined,
    languageCode: string | null | undefined,
    publicationName: string | null | undefined,
): ArticleMetaStrings {
    const { t, i18n } = useTranslation();
    // The app language from i18n, which the language store keeps in step.
    // NOT the store hook: it pulls the settings service (and the database)
    // into every card's import graph, and a card suite dies on initializeJSI.
    const appLanguage = i18n?.language ?? 'en';
    // The shared 60s clock (lib/time-tick.ts): `formatTimeAgo` is pure, so the
    // age is only as fresh as the render that produced it. Subscribing here
    // keeps every consumer (the row, the card's label) ticking together.
    const now = useTimeTick();
    return {
        publication: (publicationName ?? '').trim(),
        age: formatTimeAgo(t, pubDate ?? '', { now, emptyLabel: t('feed.justNow'), absoluteAfterDays: 7 }),
        language: getLocalizedLanguageName(languageCode, appLanguage) ?? '',
    };
}

/** An explicit spoken label from its parts, in order, the way VoiceOver joins
 *  a container's children: ", " between the non-empty ones. */
export function composeSpokenLabel(parts: readonly (string | null | undefined | false)[]): string {
    return parts
        .map((p) => (typeof p === 'string' ? p.trim() : ''))
        .filter((p) => p.length > 0)
        .join(', ');
}
