import React from 'react';
import { View } from 'react-native';
import { ArticleSuggestionContainer } from '@/components/custom/ArticleSuggestionContainer';
import { ForYouSuggestion } from '@/lib/stores/for-you-store';
import { Box } from '@/components/ui/box';
import { Text } from '@/components/ui/text';

interface StackedCardsProps {
    /** Suggestions whose cluster sets overlap, ordered with the top card
     *  first (highest relevance). Must contain at least 2 entries —
     *  singletons render as a plain `ArticleCard`. */
    suggestions: ForYouSuggestion[];
    /** Fires for the top card (same contract as `ArticleCard.onPress`).
     *  The detail screen renders the remaining siblings underneath the
     *  primary card via `siblingArticleSuggestions`. */
    onPress: () => void;
    timestamp?: string;
    isNew?: boolean;
}

export const StackedCards: React.FC<StackedCardsProps> = ({
    suggestions,
    onPress,
    timestamp,
    isNew = false,
}) => {
    const top = suggestions[0];
    const siblingCount = suggestions.length - 1;

    return (
        <View className="relative">
            <ArticleSuggestionContainer
                suggestion={top}
                variant="card"
                timestamp={timestamp}
                isNew={isNew}
                onPress={onPress}
            />

            {/* Count chip — surfaces that this card shares its story with
                `siblingCount` other personalized suggestions. Tapping the
                card opens the detail screen, where the siblings render
                underneath the primary card. */}
            <Box
                pointerEvents="none"
                className="absolute right-4 top-4 bg-background-900/90 border border-background-700 rounded-full px-2 py-0.5"
            >
                <Text className="text-xs text-typography-50">
                    +{siblingCount} more
                </Text>
            </Box>
        </View>
    );
};

export default StackedCards;
