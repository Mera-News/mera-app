// NOTE(app-rethink wave): the `card` variant is SUPERSEDED by
// components/custom/cards/ (ArticleCardBase + ArticleSuggestionCard). Nothing
// renders this component with variant="card" anymore. The `screen` variant is
// STILL LIVE — the article/suggestion detail screens use it — so leave the CARD
// path alone; new card work goes in components/custom/cards/.
//
// The screen path's rationale block is: priority chip on the LEFT, rationale
// text right-aligned and non-italic. A Mera glyph briefly lived in this block as
// the Ask-Mera affordance; it was removed again — the action row's Mera button
// (ArticleFeedbackPrompt / CardActionBar) is the single entry point.
import { ArticleMetaRow } from '@/components/custom/ArticleMetaRow';
import ExtractedMetadataPanel from '@/components/custom/news-detail/ExtractedMetadataPanel';
import {
    DETAIL_BACK_SIZE,
    DETAIL_BACK_TOP_OFFSET,
    DETAIL_TOP_BAR_HEIGHT,
} from '@/components/custom/news-detail/DetailTopBar';
import { GlassPanel } from '@/components/custom/GlassSurface';
import MeraLogo from '@/components/custom/MeraLogo';
import SmoothScrollView, { SmoothScrollViewRef } from '@/components/custom/SmoothScrollView';
import TranslatableDynamic, { type TranslatableDisplayState } from '@/components/custom/TranslatableDynamic';
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
import { useBlurImagesStore } from '@/lib/stores/blur-images-store';
import ReasonNote from '@/components/custom/cards/ReasonNote';
import { pendingSinceMs } from '@/components/custom/cards/pending-since';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { ArticleSuggestionStatus } from '@/lib/database/article-suggestion-status';
import React, { useCallback, useEffect, useRef, useState } from 'react';
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
    /** Fires once when the user scrolls near the bottom (re-arms after scrolling
     *  back up) — forwarded to SmoothScrollView's `onEndReached`. Used to grow
     *  lazily-rendered footer content (e.g. the related-articles list). */
    onEndReached?: () => void;
    contentTopInset?: number;
    /** M8/F31: fires when the meta row starts or stops scrolling under the
     *  detail top bar, so the host can solidify `DetailTopBar`. Only on
     *  crossings, never per frame. */
    onTopBarSolidChange?: (solid: boolean) => void;
    contentBottomInset?: number;
    footer?: React.ReactNode;
    // Screen-variant only — slot rendered between the title and the
    // reason box (or in its place when there's no reason, e.g. the
    // article-detail path).
    aboveReason?: React.ReactNode;
    /** Marks the article/suggestion as already-read — shows the meta row's
     *  NEW badge in the meta row. It draws no indicator of its own — the eye glyph
   *  it used to show was deliberately removed. Screen-variant only (detail
     *  screens); the card variant has no live consumers. Default false. */
    read?: boolean;
    /** Forwarded to the TITLE's TranslatableDynamic (the toggle-enabled screen
     *  instance) — fires whenever the displayed title variant changes so the
     *  detail screen can share whichever title the reader currently sees. */
    onTitleDisplayChange?: (state: TranslatableDisplayState) => void;
}

type SuggestionProps = BaseProps & { suggestion: ForYouSuggestion; article?: never };
type ArticleProps = BaseProps & { article: NewsArticle; suggestion?: never };

type ArticleSuggestionContainerProps = SuggestionProps | ArticleProps;

export const SCREEN_HEADER_HEIGHT = 240;
/** The content VStack's `p-5`. */
const CONTENT_PADDING = 20;

// Geometry of the detail screens' floating back button. Both ArticleDetailScreen
// and ArticleSuggestionScreen render it at `top: insets.top + 8` with `p-3`
// (12px) padding around a 24px icon ⇒ ~48px tall. With a hero image the parallax
// header sits under the button and the meta row clears it naturally; with NO
// image the meta row would otherwise start right under the button and collide
// with it. Push the content down by the button's own footprint + a comfortable
// gap, derived from these values rather than a magic number.
const BACK_BUTTON_TOP_OFFSET = DETAIL_BACK_TOP_OFFSET;
const BACK_BUTTON_SIZE = DETAIL_BACK_SIZE;
const NO_IMAGE_BREATHING_ROOM = 16;
/** Tint for the meta band's glass plate — dark so the band recedes into the
 *  page instead of reading as a lighter slab. See its call site. */
const META_BAND_TINT = 'rgba(0,0,0,0.30)';

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
        onPress,
        scrollViewRef,
        onScrollPositionChange,
        onEndReached,
        contentTopInset = 0,
        onTopBarSolidChange,
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

    // Extraction metadata for the transparency panel (screen variant only —
    // see ExtractedMetadataPanel). `entities`/`eventType` are reachable from
    // both a live article and a local suggestion row; `geoTags` is NOT — the
    // suggestion mapper (`toForYouSuggestion` in article-suggestion-service.ts)
    // never carries `geo_tags_json` onto `ForYouSuggestion`, so a
    // suggestion-sourced screen shows no places even when the server has them.
    const metaEventType = suggestion?.eventType ?? article?.event_type ?? null;
    const metaEntities = suggestion?.entities ?? article?.entities ?? null;
    const metaGeoTags = article?.geo_tags ?? null;

    const [imageFailed, setImageFailed] = useState(false);
    const blurImages = useBlurImagesStore((s) => s.blurImages);
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
            size={isCard ? 'lg' : '2xl'}
            className={isCard ? '' : 'text-white'}
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
        <ReasonNote
            relevance={relevance}
            reason={reason}
            pendingSinceMs={pendingSinceMs(suggestion)}
            testID="detail-reason"
        />
    ) : null;

    // Where the meta row starts in scroll content, and so how far the reader
    // scrolls before it passes under the top bar. With a hero the content has
    // no top inset (the hero bleeds under the status-bar scrim, M7); without
    // one it starts below the inset and clears the back button.
    const metaTop = showImage
        ? SCREEN_HEADER_HEIGHT + CONTENT_PADDING
        : contentTopInset + CONTENT_PADDING + NO_IMAGE_META_CLEARANCE;
    const solidAfter = Math.max(0, metaTop - (contentTopInset + DETAIL_TOP_BAR_HEIGHT));
    const topBarSolid = useRef(false);
    const handleScrollPosition = useCallback(
        (y: number) => {
            onScrollPositionChange?.(y);
            const solid = y > solidAfter;
            if (solid !== topBarSolid.current) {
                topBarSolid.current = solid;
                onTopBarSolidChange?.(solid);
            }
        },
        [onScrollPositionChange, onTopBarSolidChange, solidAfter],
    );

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
                                blurRadius={blurImages ? 24 : undefined}
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
            // M7: a hero starts at the very top, under the status-bar scrim;
            // the inset only pads a screen with no hero.
            contentContainerStyle={{ paddingTop: showImage ? 0 : contentTopInset }}
            headerHeight={SCREEN_HEADER_HEIGHT}
            onScrollPositionChange={handleScrollPosition}
            onEndReached={onEndReached}
            parallaxHeader={
                showImage ? (
                    <Box className="w-full h-full">
                        <Image
                            source={{ uri: imageUrl! }}
                            alt={displayTitle}
                            className="w-full h-full"
                            resizeMode="cover"
                            // N14: "Blur images" covers the detail hero too, not
                            // only the cards that led here.
                            blurRadius={blurImages ? 24 : undefined}
                            testID="detail-hero-image"
                            onError={() => setImageFailed(true)}
                        />
                    </Box>
                ) : undefined
            }
        >
            <VStack className="p-5" space="lg">
                {/* With an image the meta row follows the hero at the VStack's
                    own padding (M7: an extra `mt-10` left ~60pt of dead space);
                    with no image, it clears the floating back button instead.

                    NO BACKGROUND, deliberately. This row used to carry its own
                    `bg-background-50` fill, then a glass plate, to occlude the
                    parallax hero: SmoothScrollView uses Reanimated's default
                    EXTEND extrapolation on translateY, so while scrolling there
                    is a window where the header's semi-transparent image sits
                    right behind this row. Both treatments read as a band pasted
                    across the page now that the root is the
                    AbstractGradientBackdrop rather than a flat fill, so the fill
                    is gone entirely and the row sits directly on the page like
                    the no-image branch below. The parallax overlap is accepted:
                    it is brief, partial, and less objectionable than a permanent
                    slab. Reworking the parallax math is the real fix if it ever
                    becomes a problem — SmoothScrollView is shared, so that is
                    not a change to make casually. */}
                {showImage ? (
                    <Box testID="detail-meta">{metaRow}</Box>
                ) : (
                    <Box style={{ marginTop: NO_IMAGE_META_CLEARANCE }}>{metaRow}</Box>
                )}
                {titleEl}
                {aboveReason}
                {reasonBoxEl}
                <ExtractedMetadataPanel
                    eventType={metaEventType}
                    entities={metaEntities}
                    geoTags={metaGeoTags}
                />
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
