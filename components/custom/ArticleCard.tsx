// DEPRECATED(app-rethink wave): replaced by components/custom/cards/ArticleSuggestionCard; no live consumers.
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React from 'react';

interface ArticleCardProps {
    suggestion: ForYouSuggestion;
    /**
     * Called with the row's suggestion when the card is pressed. Takes the
     * suggestion (not a zero-arg thunk) so callers can pass a single STABLE
     * handler for every row instead of a per-row inline arrow — that stable
     * identity is what lets the `React.memo` boundary below actually skip
     * re-rendering unchanged rows (perf item A2).
     */
    onPress: (suggestion: ForYouSuggestion) => void;
    timestamp?: string;
    isNew?: boolean;
    /** Number of additional source publications collapsed into this story card. */
    moreSourcesCount?: number;
}

export type { ArticleCardProps };

// Memoized (default shallow compare) so a row only re-renders when its own
// props change. The feed sync's identity-preserving merge keeps the SAME
// `suggestion` object reference for rows whose display fields are unchanged, and
// `onPress` is a stable handler — so shallow compare bails out for untouched
// rows even though the parent list re-renders on every store tick (perf A2).
export const ArticleCard: React.FC<ArticleCardProps> = React.memo(function ArticleCard({
    suggestion,
    onPress,
    timestamp,
    isNew = false,
    moreSourcesCount,
}) {
    return (
        <ArticleSuggestionContainer
            suggestion={suggestion}
            variant="card"
            timestamp={timestamp}
            isNew={isNew}
            moreSourcesCount={moreSourcesCount}
            onPress={() => onPress(suggestion)}
        />
    );
});

export default ArticleCard;
