import { Box } from '@/components/ui/box';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface ExploreSearchBarProps {
    readonly query: string;
    readonly onChangeQuery: (next: string) => void;
    readonly onClear: () => void;
}

/**
 * Explore's search bar (Item 12a) — sits above the scope chips in
 * ExploreScreen's pinned header. Purely presentational: all query state,
 * debouncing and fetching live in `lib/news-search/use-news-search.ts`.
 *
 * testID lives on the wrapping Box, not the Input/InputField — gluestack's
 * InputField is an accessibility container and swallows a testID prop placed
 * directly on it (see AddPhraseModal for the same workaround).
 */
const ExploreSearchBar: React.FC<ExploreSearchBarProps> = ({ query, onChangeQuery, onClear }) => {
    const { t } = useTranslation();

    return (
        <Box testID="explore-search-input" className="mb-2 px-5">
            <Input variant="outline" size="md" className="border-gray-700">
                <InputSlot className="pl-3">
                    <MaterialIcons name="search" size={18} color="#999999" />
                </InputSlot>
                <InputField
                    placeholder={t('explore.searchPlaceholder')}
                    placeholderTextColor="#666666"
                    value={query}
                    onChangeText={onChangeQuery}
                    className="text-white"
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                />
                {query.length > 0 ? (
                    <InputSlot className="pr-3">
                        <Pressable
                            testID="explore-search-clear"
                            onPress={onClear}
                            hitSlop={8}
                            accessibilityRole="button"
                            accessibilityLabel={t('explore.clearSearch')}
                        >
                            <MaterialIcons name="close" size={18} color="#999999" />
                        </Pressable>
                    </InputSlot>
                ) : null}
            </Input>
        </Box>
    );
};

export default ExploreSearchBar;
