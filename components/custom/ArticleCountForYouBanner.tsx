import { SkeletonText } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { Tooltip, TooltipContent, TooltipText } from '@/components/ui/tooltip';
import { useThemeColors } from '@/lib/theme/tokens';
import React, { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, Text as RNText } from 'react-native';

interface ArticleCountForYouBannerProps {
    articlesProcessed: number;
    articlesAnalysed: number;
    articlesImpactful: number;
    /** Number of decoy clusters dropped by the noise-removal step. Renders a
     *  second line under the analysed-count text. Omit / pass 0 to hide. */
    articlesNoiseRemoved?: number;
    /** Whether the inject-noise setting is currently on. Used to gate the
     *  decoy-count line so non-beta users never see it even if a stale count
     *  is in the store. */
    injectNoiseEnabled?: boolean;
    className?: string;
    lastSuccessfulCompletedAt?: string | null;
    isLoading?: boolean;
}

function formatDateTime(dateStr: string): string {
    const date = new Date(dateStr);
    const hours = date.getHours();
    const minutes = date.getMinutes().toString().padStart(2, '0');
    const ampm = hours >= 12 ? 'pm' : 'am';
    const displayHours = hours % 12 || 12;
    const day = date.getDate();
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const suffix = day === 1 || day === 21 || day === 31 ? 'st'
        : day === 2 || day === 22 ? 'nd'
        : day === 3 || day === 23 ? 'rd' : 'th';
    return `Last processed: ${displayHours}:${minutes} ${ampm}, ${day}${suffix} ${months[date.getMonth()]}`;
}

const ArticleCountForYouBanner: React.FC<ArticleCountForYouBannerProps> = ({
    articlesProcessed,
    articlesAnalysed,
    articlesImpactful,
    articlesNoiseRemoved = 0,
    injectNoiseEnabled = false,
    className = "text-typography-500 leading-6",
    lastSuccessfulCompletedAt,
    isLoading = false,
}) => {
    const colors = useThemeColors();
    const isRecent = useMemo(() => {
        if (!lastSuccessfulCompletedAt) return false;
        return Date.now() - new Date(lastSuccessfulCompletedAt).getTime() <= 60 * 60 * 1000;
    }, [lastSuccessfulCompletedAt]);

    const formattedTime = useMemo(() => {
        if (!lastSuccessfulCompletedAt) return null;
        return formatDateTime(lastSuccessfulCompletedAt);
    }, [lastSuccessfulCompletedAt]);

    const { t } = useTranslation();

    if (isLoading) {
        return (
            <SkeletonText
                _lines={2}
                className="h-4 w-full rounded"
                startColor="bg-background-100"
                gap={2}
            />
        );
    }

    const dotColor = isRecent ? colors.success : colors.warning;

    const showNoise = injectNoiseEnabled && articlesNoiseRemoved > 0;

    return (
        <>
            <Text size="md" className={className}>
                {articlesAnalysed === 0
                    ? t('feed.analysedArticlesPending', { processed: articlesProcessed, articleWord: articlesProcessed === 1 ? t('feed.articleSingular') : t('feed.articlePlural') })
                    : t('feed.analysedArticles', { processed: articlesProcessed, articleWord: articlesProcessed === 1 ? t('feed.articleSingular') : t('feed.articlePlural'), analysed: articlesAnalysed, impactful: articlesImpactful })}
                {formattedTime && (
                    <RNText>{' '}
                        <Tooltip
                            placement="top"
                            trigger={(triggerProps) => (
                                <Pressable {...triggerProps} hitSlop={8}>
                                    <RNText style={{ color: dotColor, fontSize: 8, lineHeight: 14 }}>{'⬤'}</RNText>
                                </Pressable>
                            )}
                        >
                            <TooltipContent className="bg-background-100 py-1.5 px-3 rounded-md">
                                <TooltipText className="text-xs" style={{ color: dotColor }}>{formattedTime}</TooltipText>
                            </TooltipContent>
                        </Tooltip>
                    </RNText>
                )}
            </Text>
            {showNoise && (
                <Text size="xs" className="text-typography-500 leading-5">
                    {t('feed.noiseRemovedSummary', {
                        count: articlesNoiseRemoved,
                        articleWord: articlesNoiseRemoved === 1
                            ? t('feed.articleSingular')
                            : t('feed.articlePlural'),
                    })}
                </Text>
            )}
        </>
    );
};

export default ArticleCountForYouBanner;
