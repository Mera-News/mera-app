import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import RelevanceChip from '@/components/custom/RelevanceChip';
import SmoothScrollView, { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import TranslatableDynamic from '@/components/custom/TranslatableDynamic';
import { Box } from '@/components/ui/box';
import { Card } from '@/components/ui/card';
import { HStack } from '@/components/ui/hstack';
import { Image } from '@/components/ui/image';
import { Pressable } from '@/components/ui/pressable';
import { Text } from '@/components/ui/text';
import { VStack } from '@/components/ui/vstack';
import { getFactsForTopicIds } from '@/lib/database/services/fact-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import AnimatedDots from '@/components/custom/AnimatedDots';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ArticleSuggestionContainerVariant = 'card' | 'screen';

interface BaseProps {
    variant: ArticleSuggestionContainerVariant;
    // card-only
    timestamp?: string;
    isNew?: boolean;
    onPress?: () => void;
    // screen-only
    scrollViewRef?: React.Ref<SmoothScrollViewRef>;
    onScrollPositionChange?: (y: number) => void;
    contentTopInset?: number;
    contentBottomInset?: number;
    footer?: React.ReactNode;
    // Screen-variant only — slot rendered between the title and the
    // reason box (or in its place when there's no reason, e.g. the
    // article-detail path).
    aboveReason?: React.ReactNode;
}

type SuggestionProps = BaseProps & { suggestion: ForYouSuggestion; article?: never };
type ArticleProps = BaseProps & { article: NewsArticle; suggestion?: never };

type ArticleSuggestionContainerProps = SuggestionProps | ArticleProps;

const SCREEN_HEADER_HEIGHT = 240;

export const ArticleSuggestionContainer: React.FC<ArticleSuggestionContainerProps> = (props) => {
    const {
        variant,
        timestamp,
        isNew = false,
        onPress,
        scrollViewRef,
        onScrollPositionChange,
        contentTopInset = 0,
        contentBottomInset = 0,
        footer,
        aboveReason,
    } = props;

    const suggestion = 'suggestion' in props ? props.suggestion : undefined;
    const article = 'article' in props ? props.article : undefined;
    const isSuggestion = !!suggestion;

    const { t } = useTranslation();

    const [facts, setFacts] = useState<Fact[]>([]);
    useEffect(() => {
        const topicIds = suggestion?.userTopicIds ?? [];
        if (topicIds.length === 0) {
            setFacts([]);
            return;
        }
        getFactsForTopicIds(topicIds)
            .then(setFacts)
            .catch(() => setFacts([]));
    }, [suggestion?.userTopicIds]);

    // Common view model derived from whichever source was provided.
    const imageUrl = suggestion?.image_url ?? article?.image_url ?? null;
    const titleEnglish = suggestion?.title_en
        ?? article?.title_en_internal_only
        ?? article?.title
        ?? null;
    const sourceLanguage = (suggestion?.language_code ?? article?.original_language_code) ?? undefined;
    const metaPubDate = timestamp
        ?? suggestion?.firstPubDate
        ?? suggestion?.createdAt
        ?? article?.pubDate
        ?? '';
    const metaLanguageCode = suggestion?.language_code ?? article?.original_language_code ?? null;
    const metaPublicationName = suggestion?.publication_name
        ?? article?.publicationSource?.publication_name
        ?? null;
    const metaCountryCode = suggestion?.country_code
        ?? article?.publicationSource?.country_code
        ?? null;

    const [imageFailed, setImageFailed] = useState(false);
    const showImage = !!imageUrl && !imageFailed;

    // Relevance/reason only apply to the suggestion path.
    const relevanceReady = !!suggestion?.relevanceGenerationCompleted;
    const reasonReady = !!suggestion?.reasonGenerationCompleted;
    const relevance = suggestion?.relevance ?? 0;
    const reason = relevanceReady ? suggestion?.reason ?? '' : '';
    const reasonLoading = relevanceReady && !reasonReady && !reason;

    const isCard = variant === 'card';
    const displayTitle = titleEnglish || (isCard ? t('feed.newsCluster') : 'Article');

    const metaRow = (
        <Box>
            <ArticleMetaRow
                pubDate={metaPubDate}
                languageCode={metaLanguageCode}
                publicationName={metaPublicationName}
                countryCode={metaCountryCode}
                variant={variant}
                isNew={isNew}
            />
            {isCard && __DEV__ && relevanceReady ? (
                <Box className="self-end mt-1 px-2 py-0.5 rounded bg-background-800">
                    <Text size="xs" className="text-typography-400 font-mono">
                        {relevance.toFixed(2)}
                    </Text>
                </Box>
            ) : null}
        </Box>
    );

    const titleEl = (
        <TranslatableDynamic
            as="heading"
            text={displayTitle}
            originalText={titleEnglish ?? undefined}
            originalLanguage={sourceLanguage}
            size={isCard ? 'md' : 'xl'}
            className={isCard ? 'leading-6' : 'text-white'}
            style={isCard ? undefined : { paddingTop: 8 }}
        />
    );

    const factChipsEl = isSuggestion && reasonReady && !reason && facts.length > 0 ? (
        <HStack className="flex-wrap justify-end" space="xs">
            {facts.map((fact) => (
                <Box
                    key={fact.id}
                    className="px-2.5 py-1 rounded-full mb-1"
                    style={{ backgroundColor: reasonBoxColors.backgroundColor }}
                >
                    <Text
                        size="xs"
                        style={{ color: reasonBoxColors.textColor, fontWeight: '600', fontSize: 11 }}
                        numberOfLines={1}
                    >
                        {fact.statement}
                    </Text>
                </Box>
            ))}
        </HStack>
    ) : null;

    const reasonBoxEl = isSuggestion && relevanceReady && (reason || reasonLoading) ? (
        <Box
            className="rounded-lg p-3 flex-row items-center"
            style={{ backgroundColor: reasonBoxColors.backgroundColor }}
        >
            <RelevanceChip relevance={relevance} />
            {reason ? (
                <TranslatableDynamic
                    text={reason}
                    size="sm"
                    italic
                    bold
                    className="ml-3 flex-1 text-right"
                    style={{ color: reasonBoxColors.textColor }}
                />
            ) : (
                <Box className="ml-3 flex-1 items-end">
                    <AnimatedDots color={reasonBoxColors.textColor} />
                </Box>
            )}
        </Box>
    ) : null;

    if (isCard) {
        return (
            <Pressable onPress={onPress}>
                <Card variant="elevated" size="md" className="mb-4 overflow-hidden">
                    {showImage && (
                        <Box className="w-full h-48 overflow-hidden rounded-t-lg">
                            <Image
                                source={{ uri: imageUrl! }}
                                alt={displayTitle}
                                className="w-full h-full"
                                resizeMode="cover"
                                onError={() => setImageFailed(true)}
                            />
                        </Box>
                    )}
                    <VStack className="p-4" space="sm">
                        {metaRow}
                        {titleEl}
                        {factChipsEl}
                        {reasonBoxEl}
                    </VStack>
                </Card>
            </Pressable>
        );
    }

    return (
        <SmoothScrollView
            ref={scrollViewRef}
            style={{ flex: 1 }}
            contentContainerStyle={{ paddingTop: contentTopInset }}
            headerHeight={SCREEN_HEADER_HEIGHT}
            onScrollPositionChange={onScrollPositionChange}
            parallaxHeader={
                showImage ? (
                    <Box className="w-full h-full">
                        <Image
                            source={{ uri: imageUrl! }}
                            alt={displayTitle}
                            className="w-full h-full"
                            resizeMode="cover"
                            onError={() => setImageFailed(true)}
                        />
                    </Box>
                ) : undefined
            }
        >
            <VStack className="p-5" space="lg">
                <Box className="mt-10">{metaRow}</Box>
                {titleEl}
                {aboveReason}
                {reasonBoxEl}
                {footer}
                <Box style={{ height: contentBottomInset }} />
            </VStack>
        </SmoothScrollView>
    );
};

export default ArticleSuggestionContainer;
