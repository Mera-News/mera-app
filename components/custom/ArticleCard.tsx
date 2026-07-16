import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React from 'react';

interface ArticleCardProps {
    suggestion: ForYouSuggestion;
    onPress: () => void;
    timestamp?: string;
    isNew?: boolean;
    /** Number of additional source publications collapsed into this story card. */
    moreSourcesCount?: number;
}

export type { ArticleCardProps };

export const ArticleCard: React.FC<ArticleCardProps> = ({
    suggestion,
    onPress,
    timestamp,
    isNew = false,
    moreSourcesCount,
}) => (
    <ArticleSuggestionContainer
        suggestion={suggestion}
        variant="card"
        timestamp={timestamp}
        isNew={isNew}
        moreSourcesCount={moreSourcesCount}
        onPress={onPress}
    />
);

export default ArticleCard;
