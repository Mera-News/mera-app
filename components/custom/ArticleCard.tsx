import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import React from 'react';

interface ArticleCardProps {
    suggestion: ForYouSuggestion;
    onPress: () => void;
    timestamp?: string;
    isNew?: boolean;
}

export type { ArticleCardProps };

export const ArticleCard: React.FC<ArticleCardProps> = ({
    suggestion,
    onPress,
    timestamp,
    isNew = false,
}) => (
    <ArticleSuggestionContainer
        suggestion={suggestion}
        variant="card"
        timestamp={timestamp}
        isNew={isNew}
        onPress={onPress}
    />
);

export default ArticleCard;
