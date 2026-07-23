import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { SourceCountryFlag } from '@/components/custom/SourceCountryFlag';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Text } from '@/components/ui/text';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { getArticleTranslatableStatus, getNativeLanguageName } from '@/lib/translation-service';
import { formatTimeAgo } from '@/lib/utils/time-ago';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

export type ArticleMetaRowVariant = 'card' | 'screen';

interface ArticleMetaRowProps {
    pubDate?: string | null;
    languageCode?: string | null;
    publicationName?: string | null;
    countryCode?: string | null;
    variant: ArticleMetaRowVariant;
    isNew?: boolean;
    /** Number of additional source publications collapsed into this story card;
     *  renders a "+N sources" pill next to the NEW badge (card variant only). */
    moreSourcesCount?: number;
    /** Marks the article as already-read — renders a small eye icon immediately
     *  after the time group. Default false — no visual change when omitted. */
    read?: boolean;
    /** Whether to render the trailing country flag. Default true. The compact
     *  card sets this false and shows the flag in its footer instead. */
    showFlag?: boolean;
}

export const ArticleMetaRow: React.FC<ArticleMetaRowProps> = ({
    pubDate,
    languageCode,
    publicationName,
    countryCode,
    variant,
    isNew = false,
    moreSourcesCount,
    read = false,
    showFlag = true,
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    const isCard = variant === 'card';
    const ageColor = isCard ? 'text-typography-600' : 'text-gray-400';
    const secondaryColor = isCard ? 'text-typography-500' : 'text-gray-400';
    const iconColor = isCard ? '#6B7280' : '#9CA3AF';

    const age = formatTimeAgo(t, pubDate, { emptyLabel: t('feed.justNow'), absoluteAfterDays: 7 });
    const language = getNativeLanguageName(languageCode) ?? '';
    const publication = publicationName ?? '';

    const translateStatus = getArticleTranslatableStatus(languageCode, appLanguage);
    const translateColor = translateStatus === 'not-translatable' ? '#FCA5A5' : '#86EFAC';
    const showLanguageSlot = !!languageCode;
    const showPublicationSlot = !!publication;

    return (
        // `justify-between` spreads the slots evenly: time anchors at the start,
        // the flag at the end, and the language (+ optional publication) slots
        // distribute across the free space between them. Time and flag are
        // fixed-width (`flex-shrink-0`); the language and publication slots may
        // shrink (single-line, truncating) so a long publication name truncates
        // instead of bleeding across / pushing the flag off-row.
        <HStack className="items-center justify-between" space="sm">
            {/* 1. Age (+ optional read eye / NEW badge / +N sources) */}
            <HStack className="items-center flex-shrink-0" space="xs">
                <MaterialIcons name="schedule" size={14} color={iconColor} />
                <Text size="sm" className={ageColor}>
                    {age}
                </Text>
                {read ? (
                    <MaterialIcons
                        name="visibility"
                        size={14}
                        color={iconColor}
                        accessibilityLabel="read"
                    />
                ) : null}
                {/* A read card never shows NEW — read wins. */}
                {isCard && isNew && !read ? (
                    <Box className="px-2 py-0.5 rounded-full" style={{ backgroundColor: '#10B981' }}>
                        <Text size="xs" style={{ color: '#FFFFFF', fontWeight: '600' }}>
                            {t('feed.newBadge')}
                        </Text>
                    </Box>
                ) : null}
                {isCard && moreSourcesCount && moreSourcesCount > 0 ? (
                    <Box className="px-2 py-0.5 rounded-full" style={{ backgroundColor: '#6366F1' }}>
                        <Text size="xs" style={{ color: '#FFFFFF', fontWeight: '600' }}>
                            {t('feed.moreSources', { count: moreSourcesCount })}
                        </Text>
                    </Box>
                ) : null}
            </HStack>

            {/* 2. Translate icon + language name */}
            {showLanguageSlot ? (
                <HStack className="items-center flex-shrink" space="xs" style={{ minWidth: 0 }}>
                    <MaterialIcons name="translate" size={12} color={translateColor} />
                    {language ? (
                        <Text
                            size="xs"
                            className={`${secondaryColor} flex-shrink`}
                            numberOfLines={1}
                        >
                            {language}
                        </Text>
                    ) : null}
                </HStack>
            ) : null}

            {/* 3. Newspaper icon + publication name — natural width, truncating a
                long name instead of bleeding when the row runs tight. */}
            {showPublicationSlot ? (
                <HStack className="items-center flex-shrink" space="xs" style={{ minWidth: 0 }}>
                    <MaterialIcons name="newspaper" size={12} color={iconColor} />
                    <Text
                        size="xs"
                        className={`${secondaryColor} flex-shrink`}
                        numberOfLines={1}
                    >
                        {publication}
                    </Text>
                </HStack>
            ) : null}

            {/* 4. Country flag — tappable on the detail screen to name the country.
                Hidden when `showFlag` is false (compact card shows it in its footer). */}
            {showFlag ? (
                <Box className="flex-shrink-0">
                    {isCard ? (
                        <SourceFlag countryCode={countryCode} size="sm" iconClassName="text-typography-500" />
                    ) : (
                        <SourceCountryFlag countryCode={countryCode} iconClassName="text-gray-400" />
                    )}
                </Box>
            ) : null}
        </HStack>
    );
};

export default ArticleMetaRow;
