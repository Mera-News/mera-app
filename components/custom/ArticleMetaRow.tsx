import { Box } from '@/components/ui/box';
import { HStack } from '@/components/ui/hstack';
import { SourceFlag } from '@/components/custom/SourceFlag';
import { Text } from '@/components/ui/text';
import { useAppLanguage } from '@/lib/stores/app-language-store';
import { getArticleTranslatableStatus, getNativeLanguageName } from '@/lib/translation-service';
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
}) => {
    const { t } = useTranslation();
    const appLanguage = useAppLanguage();

    const formatAge = (dateString: string | null | undefined) => {
        if (!dateString) return t('feed.justNow');
        try {
            const date = new Date(dateString);
            const diffMs = Date.now() - date.getTime();
            const mins = Math.floor(diffMs / 60000);
            const hours = Math.floor(diffMs / 3600000);
            const days = Math.floor(diffMs / 86400000);
            if (mins < 1) return t('feed.justNow');
            if (mins < 60) return t('feed.minutesAgo', { count: mins });
            if (hours < 24) return t('feed.hoursAgo', { count: hours });
            if (days < 7) return t('feed.daysAgo', { count: days });
            return date.toLocaleDateString();
        } catch {
            return t('feed.justNow');
        }
    };

    const isCard = variant === 'card';
    const ageColor = isCard ? 'text-typography-600' : 'text-gray-400';
    const secondaryColor = isCard ? 'text-typography-500' : 'text-gray-400';
    const iconColor = isCard ? '#6B7280' : '#9CA3AF';

    const age = formatAge(pubDate);
    const language = getNativeLanguageName(languageCode) ?? '';
    const publication = publicationName ?? '';

    const translateStatus = getArticleTranslatableStatus(languageCode, appLanguage);
    const translateColor = translateStatus === 'not-translatable' ? '#FCA5A5' : '#86EFAC';
    const showLanguageSlot = !!languageCode;
    const showPublicationSlot = !!publication;

    return (
        <HStack className="items-center justify-between">
            {/* 1. Age (+ optional NEW badge) */}
            <HStack className="items-center" space="xs">
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
                {isCard && isNew ? (
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
                <HStack className="items-center flex-shrink" space="xs">
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
            ) : <Box />}

            {/* 3. Newspaper icon + publication name */}
            {showPublicationSlot ? (
                <HStack className="items-center flex-shrink" space="xs">
                    <MaterialIcons name="newspaper" size={12} color={iconColor} />
                    <Text
                        size="xs"
                        className={`${secondaryColor} flex-shrink`}
                        numberOfLines={1}
                    >
                        {publication}
                    </Text>
                </HStack>
            ) : <Box />}

            {/* 4. Country flag */}
            <SourceFlag countryCode={countryCode} size="sm" iconClassName={isCard ? 'text-typography-500' : 'text-gray-400'} />
        </HStack>
    );
};

export default ArticleMetaRow;
