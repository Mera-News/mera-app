import { Box } from '@/components/ui/box';
import { Input, InputField, InputSlot } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { useTranslation } from 'react-i18next';

interface ExploreSearchBarProps {
    readonly query: string;
    readonly onChangeQuery: (next: string) => void;
    /**
     * Dismiss search: clears the query AND collapses the row back to the
     * "Explore" heading. One control, not two — a bare "clear" that left the
     * input open would be a second way out of a state that already has one,
     * and leaving the row expanded-but-empty is not a state the user asked for.
     */
    readonly onClose: () => void;
}

/**
 * Explore's search input — the EXPANDED half of the title row.
 *
 * ExploreScreen renders this INSTEAD OF the "Explore" heading, on the same
 * line, once the magnifier is tapped; it is not mounted at all while search is
 * collapsed (mounting-and-hiding it would keep its 40pt of layout in the row).
 * That is why the input `autoFocus`es: it only ever mounts as the direct result
 * of a tap, so focusing on mount is what makes the keyboard come up without a
 * second tap.
 *
 * Purely presentational otherwise: all query state, debouncing and fetching
 * live in `lib/news-search/use-news-search.ts`.
 *
 * testID lives on the wrapping Box, not the Input/InputField — gluestack's
 * InputField is an accessibility container and swallows a testID prop placed
 * directly on it (see AddPhraseModal for the same workaround).
 */
const ExploreSearchBar: React.FC<ExploreSearchBarProps> = ({ query, onChangeQuery, onClose }) => {
    const { t } = useTranslation();

    return (
        // flex-1, no padding/margin of its own: it is a CHILD of the title
        // HStack now, which already owns the row's px-5 and its bottom margin.
        <Box testID="explore-search-input" className="flex-1">
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
                    autoFocus
                />
                {/* ALWAYS rendered, unlike the old clear button, which appeared
                    only once there was text. It is now the only way back to the
                    heading, so it cannot be conditional on the query. */}
                <InputSlot className="pr-3">
                    <Pressable
                        testID="explore-search-close"
                        onPress={onClose}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={t('explore.closeSearch')}
                    >
                        <MaterialIcons name="close" size={18} color="#999999" />
                    </Pressable>
                </InputSlot>
            </Input>
        </Box>
    );
};

export default ExploreSearchBar;
