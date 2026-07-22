// NOTE(app-rethink wave): the `card` variant is SUPERSEDED by
// components/custom/cards/ (ArticleCardBase + ArticleSuggestionCard). Nothing
// renders this component with variant="card" anymore. The `screen` variant is
// STILL LIVE — the article/suggestion detail screens use it — so this file stays
// as-is; do not change its behavior. New card work goes in components/custom/cards/.
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
import { getFactsForTopicTexts } from '@/lib/database/services/fact-service';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import type { Fact } from '@/lib/mera-protocol-toolkit/types';
import { reasonBoxColors } from '@/lib/relevance-utils';
import StreamingIndicator from '@/components/custom/chat/StreamingIndicator';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ArticleSuggestionContainerVariant = 'card' | 'screen';

interface BaseProps {
    variant: ArticleSuggestionContainerVariant;
    // card-only
    timestamp?: string;
    isNew?: boolean;
    // card-only — number of additional source publications collapsed into this
    // story card, rendered as the "+N sources" chip in the meta row.
    moreSourcesCount?: number;
    onPress?: () => void;
    // screen-only
    scrollViewRef?: React.Ref<SmoothScrollViewRef>;
    onScrollPositionChange?: (y: number) => void;
    /** Fires once when the user scrolls near the bottom (re-arms after scrolling
     *  back up) — forwarded to SmoothScrollView's `onEndReached`. Used to grow
     *  lazily-rendered footer content (e.g. the related-articles list). */
    onEndReached?: () => void;
    contentTopInset?: number;
    contentBottomInset?: number;
    footer?: React.ReactNode;
    // Screen-variant only — slot rendered between the title and the
    // reason box (or in its place when there's no reason, e.g. the
    // article-detail path).
    aboveReason?: React.ReactNode;
    /** Marks the article/suggestion as already-read — shows the meta row's
     *  small eye icon next to the time group. Screen-variant only (detail
     *  screens); the card variant has no live consumers. Default false. */
    read?: boolean;
    /** Forwarded to the TITLE's TranslatableDynamic (the toggle-enabled screen
     *  instance) — fires whenever the displayed title variant changes so the
     *  detail screen can share whichever title the reader currently sees. */
    onTitleDisplayChange?: (state: { showingOriginal: boolean; displayedText: string }) => void;
}

type SuggestionProps = BaseProps & { suggestion: ForYouSuggestion; article?: never };
type ArticleProps = BaseProps & { article: NewsArticle; suggestion?: never };

type ArticleSuggestionContainerProps = SuggestionProps | ArticleProps;

const SCREEN_HEADER_HEIGHT = 240;

// Geometry of the detail screens' floating back button. Both ArticleDetailScreen
// and ArticleSuggestionScreen render it at `top: insets.top + 8` with `p-3`
// (12px) padding around a 24px icon ⇒ ~48px tall. With a hero image the parallax
// header sits under the button and the meta row clears it naturally; with NO
// image the meta row would otherwise start right under the button and collide
// with it. Push the content down by the button's own footprint + a comfortable
// gap, derived from these values rather than a magic number.
const BACK_BUTTON_TOP_OFFSET = 8;
const BACK_BUTTON_SIZE = 48;
const NO_IMAGE_BREATHING_ROOM = 16;
const NO_IMAGE_META_CLEARANCE =
    BACK_BUTTON_TOP_OFFSET + BACK_BUTTON_SIZE + NO_IMAGE_BREATHING_ROOM; // 72

// Module-level LRU cache (insertion-order eviction, cap 100) for topic→facts
// lookups. Cards that share the same topic set (common within a fact section)
// resolve from here instead of re-querying WatermelonDB on mount (perf A5).
// Keyed by the SORTED, joined topic ids so ordering doesn't matter.
const FACTS_CACHE_MAX = 100;
const factsCache = new Map<string, Fact[]>();

function getCachedFacts(key: string): Fact[] | undefined {
    const hit = factsCache.get(key);
    if (hit !== undefined) {
        // Refresh recency: re-insert so it becomes most-recently-used.
        factsCache.delete(key);
        factsCache.set(key, hit);
    }
    return hit;
}

function setCachedFacts(key: string, value: Fact[]): void {
    if (factsCache.has(key)) factsCache.delete(key);
    factsCache.set(key, value);
    if (factsCache.size > FACTS_CACHE_MAX) {
        const oldest = factsCache.keys().next().value;
        if (oldest !== undefined) factsCache.delete(oldest);
    }
}

const ArticleSuggestionContainerImpl: React.FC<ArticleSuggestionContainerProps> = (props) => {
    const {
        variant,
        timestamp,
        isNew = false,
        moreSourcesCount,
        onPress,
        scrollViewRef,
        onScrollPositionChange,
        onEndReached,
        contentTopInset = 0,
        contentBottomInset = 0,
        footer,
        aboveReason,
        read = false,
        onTitleDisplayChange,
    } = props;

    const suggestion = 'suggestion' in props ? props.suggestion : undefined;
    const article = 'article' in props ? props.article : undefined;
    const isSuggestion = !!suggestion;

    const { t } = useTranslation();

    const [facts, setFacts] = useState<Fact[]>([]);

    // Common view model derived from whichever source was provided.
    const imageUrl = suggestion?.image_url ?? article?.image_url ?? null;
    // English source used as the base for on-device translation.
    const titleEnglish = suggestion?.title_en
        ?? article?.title_en_internal_only
        ?? article?.title
        ?? null;
    // Original-language version shown directly when appLanguage matches the article language.
    const titleOriginal: string | undefined = suggestion
        ? (suggestion.title_original ?? undefined)
        : (article?.title ?? undefined);
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

    // Relevance/reason only apply to the suggestion path. Driven by the
    // article-suggestion status state machine.
    const status = suggestion?.status;
    const relevanceReady = !!status && status !== ArticleSuggestionStatus.Unscored;
    const reasonReady = status === ArticleSuggestionStatus.Complete;
    const relevance = suggestion?.relevance ?? 0;
    const reason = relevanceReady ? suggestion?.reason ?? '' : '';
    const reasonLoading =
        status === ArticleSuggestionStatus.ReasonPending && !reason;

    // Fact chips only render on a complete, reason-less suggestion — the
    // `factChipsEl` branch below gates on `isSuggestion && reasonReady &&
    // !reason`. Fetching facts for any other card is wasted DB work on every
    // row mount, so mirror that exact gate here and only query when the chips
    // can actually appear. The module-level LRU cache lets cards sharing a topic
    // set skip the query entirely (perf A5).
    const canRenderFactChips = isSuggestion && reasonReady && !reason;
    // Primitive dep — `suggestion.userTopicIds` is a fresh array each render, so
    // key the effect on its joined contents instead of the unstable ref.
    const topicIdsKey = (suggestion?.userTopicIds ?? []).join(' ');
    useEffect(() => {
        const topicIds = suggestion?.userTopicIds ?? [];
        if (!canRenderFactChips || topicIds.length === 0) {
            setFacts([]);
            return;
        }
        const cacheKey = [...topicIds].sort().join(' ');
        const cached = getCachedFacts(cacheKey);
        if (cached) {
            setFacts(cached);
            return;
        }
        let cancelled = false;
        getFactsForTopicTexts(topicIds)
            .then((f) => {
                if (cancelled) return;
                setCachedFacts(cacheKey, f);
                setFacts(f);
            })
            .catch(() => {
                if (!cancelled) setFacts([]);
            });
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [canRenderFactChips, topicIdsKey]);

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
                moreSourcesCount={moreSourcesCount}
                read={read}
            />
            {isCard && __DEV__ && relevanceReady ? (
                <Box className="self-end mt-1 px-2 py-0.5 rounded bg-background-50">
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
            originalText={titleOriginal}
            originalLanguage={sourceLanguage}
            size={isCard ? 'md' : 'xl'}
            className={isCard ? 'leading-6' : 'text-white'}
            style={isCard ? undefined : { paddingTop: 8 }}
            showToggle={!isCard}
            onDisplayChange={onTitleDisplayChange}
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
                    <StreamingIndicator compact color={reasonBoxColors.textColor} />
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
                                recyclingKey={suggestion?._id ?? article?._id}
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
            onEndReached={onEndReached}
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
                {/* With an image, `mt-10` spaces the meta row below the hero;
                    with no image, clear the floating back button instead. */}
                <Box
                    className={showImage ? 'mt-10' : undefined}
                    style={showImage ? undefined : { marginTop: NO_IMAGE_META_CLEARANCE }}
                >
                    {metaRow}
                </Box>
                {titleEl}
                {aboveReason}
                {reasonBoxEl}
                {footer}
                <Box style={{ height: contentBottomInset }} />
            </VStack>
        </SmoothScrollView>
    );
};

// Memoized (default shallow compare) so a row bails out of re-rendering when its
// props are referentially unchanged. The feed sync's identity-preserving merge
// keeps the same `suggestion` object reference for untouched rows, so shallow
// compare short-circuits the whole card subtree on unrelated store ticks (A2).
export const ArticleSuggestionContainer = React.memo(ArticleSuggestionContainerImpl);

export default ArticleSuggestionContainer;
