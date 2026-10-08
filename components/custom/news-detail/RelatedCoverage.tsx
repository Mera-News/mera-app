import { ArticleStandaloneCompactCard } from '@/components/custom/cards/ArticleStandaloneCompactCard';
import RelatedErrorRow from '@/components/custom/news-detail/RelatedErrorRow';
import { leadWithOrigin } from '@/components/custom/news-detail/merge-related-entries';
import { Shimmer } from '@/components/ui/shimmer';
import { Spinner } from '@/components/ui/spinner';
import { Text } from '@/components/ui/text';
import type { NewsArticle } from '@/lib/generated/graphql-types';
import { MOTION } from '@/lib/motion';
import { useColors } from '@/lib/theme/tokens';
import { router } from 'expo-router';
import React, { useReducer } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import Animated, { FadeInUp } from 'react-native-reanimated';

export interface RelatedRow {
    /** The article id. */
    id: string;
    article: NewsArticle;
    /** A local sibling opens the richer suggestion page. */
    suggestionId?: string;
}

/** Related rows opened this session: they read "Opened" (FinalRead #12).
 *  Memory only; nothing about what was opened is stored. */
const openedThisSession = new Set<string>();
/** Grey cards while the first page loads (FinalRead #7). */
const SKELETON_CARDS = 3;
/** Only the first rows rise in one by one; the rest just appear. */
const STAGGERED = 4;

function SkeletonCard() {
    const colors = useColors();
    return (
        <View
            style={{
                flexDirection: 'row',
                gap: 12,
                padding: 12,
                marginBottom: 10,
                borderRadius: 12,
                borderWidth: 1,
                borderColor: colors.line,
                backgroundColor: colors.surface,
            }}
        >
            <View style={{ flex: 1, gap: 8, paddingTop: 4 }}>
                <Shimmer width="40%" height={10} />
                <Shimmer width="95%" height={14} />
                <Shimmer width="70%" height={14} />
            </View>
            <Shimmer width={64} height={64} radius={12} />
        </View>
    );
}

/** The sort's user-facing labels: what the reader gets, not the mode's
 *  internal name ("relevance" describes the algorithm). */
export const RELATED_SORT_LABEL = {
    relevance: 'relatedSort.relevance',
    oldest: 'relatedSort.oldest',
    newest: 'relatedSort.newest',
} as const;

interface RelatedCoverageProps {
    rows: readonly RelatedRow[];
    /** The article on screen: what a page opened from here came from. */
    selfArticleId: string;
    /** The article THIS page was opened from (its Related list leads with it,
     *  "You came from here", and tapping it goes back). */
    fromArticleId?: string | null;
    loading: boolean;
    loadingMore: boolean;
    error: boolean;
    onRetry: () => void;
    /** Drawn at the end of the heading row: the sort chip (InlineChoiceChip). */
    headerAccessory?: React.ReactNode;
}

/**
 * Related coverage on both article pages: a plain list of compact cards. Grey
 * cards hold the place until the first page lands, then the rows rise 8 pt in
 * one by one, 120 ms apart. A row opens its story as a NESTED article page on
 * the same stack; that page lists the story you came from first, and tapping
 * it goes back rather than opening a copy.
 */
const RelatedCoverage: React.FC<RelatedCoverageProps> = ({
    rows,
    selfArticleId,
    fromArticleId,
    loading,
    loadingMore,
    error,
    onRetry,
    headerAccessory,
}) => {
    const { t } = useTranslation();
    const colors = useColors();
    const [, rerender] = useReducer((n: number) => n + 1, 0);
    if (!loading && rows.length === 0 && !error) return null;

    const open = (row: RelatedRow) => {
        if (row.id === fromArticleId) {
            router.back();
            return;
        }
        openedThisSession.add(row.id);
        rerender();
        // `stableClusterId` is deliberately NOT forwarded: the next hop is in
        // the same cluster, and that id is also the read-dimming key, so the
        // chained article would render as already read the moment it opens.
        router.push(
            row.suggestionId
                ? {
                      pathname: '/logged-in/suggestion-detail',
                      params: { articleSuggestionId: row.suggestionId, from: selfArticleId },
                  }
                : { pathname: '/logged-in/article-detail', params: { articleId: row.id, from: selfArticleId } },
        );
    };

    const { duration, stagger, rise } = MOTION.relatedStagger;
    return (
        <View testID="related-coverage">
            <View
                style={{
                    flexDirection: 'row',
                    alignItems: 'center',
                    justifyContent: 'space-between',
                    gap: 8,
                    marginBottom: 10,
                }}
            >
                <Text
                    accessibilityRole="header"
                    style={{ flexShrink: 1, color: colors.ink3, fontSize: 13, fontWeight: '600' }}
                >
                    {t('articleDetail.relatedArticles')}
                </Text>
                {headerAccessory}
            </View>
            {loading && rows.length === 0
                ? Array.from({ length: SKELETON_CARDS }, (_, i) => <SkeletonCard key={i} />)
                : null}
            {leadWithOrigin(rows, fromArticleId).map((row, i) => (
                <Animated.View
                    key={row.id}
                    entering={
                        i < STAGGERED
                            ? FadeInUp.duration(duration)
                                  .delay(i * stagger)
                                  .withInitialValues({ opacity: 0, transform: [{ translateY: rise }] })
                            : undefined
                    }
                >
                    <ArticleStandaloneCompactCard
                        article={row.article}
                        onPress={() => open(row)}
                        subjectExtras={{ surface: 'detail' }}
                        statusLabel={
                            row.id === fromArticleId
                                ? t('articleDetail.youCameFromHere')
                                : openedThisSession.has(row.id)
                                  ? t('feed.opened')
                                  : null
                        }
                    />
                </Animated.View>
            ))}
            {(loading && rows.length > 0) || loadingMore ? (
                <View style={{ alignItems: 'center', paddingVertical: 16 }}>
                    <Spinner size="small" />
                </View>
            ) : null}
            {error && !loading && !loadingMore ? <RelatedErrorRow onRetry={onRetry} /> : null}
        </View>
    );
};

export default RelatedCoverage;
