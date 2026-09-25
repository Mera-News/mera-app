import { Box } from '@/components/ui/box';
import { Input, InputField } from '@/components/ui/input';
import { Pressable } from '@/components/ui/pressable';
import { MaterialIcons } from '@expo/vector-icons';
import React from 'react';
import { View } from 'react-native';
import { useTranslation } from 'react-i18next';

// Icons are drawn in plain hidden Views, never an InputSlot (a Pressable) or
// any other accessible element: a glyph under one surfaced on iOS as its own
// StaticText and in a container label (captured). The close tap target is a
// childless 44pt button laid over the bar from OUTSIDE the Input, whose
// overflow-hidden 35pt box would clip it.
const GLYPH = 18;
/** pl-3 / pr-3 at NativeWind's 14pt rem: the slots' old padding. */
const SLOT_PAD = 10.5;
/** The outline variant's 1pt border. */
const INPUT_BORDER = 1;
const CLOSE_TARGET = 44;
const HIDDEN = {
    accessible: false,
    accessibilityElementsHidden: true,
    importantForAccessibility: 'no-hide-descendants',
} as const;
const CLOSE_TARGET_STYLE = {
    position: 'absolute',
    width: CLOSE_TARGET,
    height: CLOSE_TARGET,
    top: '50%',
    marginTop: -CLOSE_TARGET / 2,
    // Centred on the glyph: its centre sits border + pad + half a glyph in
    // from the bar's right edge.
    right: INPUT_BORDER + SLOT_PAD + GLYPH / 2 - CLOSE_TARGET / 2,
} as const;

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
    /** The input lost focus (keyboard dismissed, list scrolled). The screen
     *  collapses the row when the query is empty (F40): an open, empty bar
     *  sat where the "Explore" title belongs. */
    readonly onBlur?: () => void;
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
const ExploreSearchBar: React.FC<ExploreSearchBarProps> = ({ query, onChangeQuery, onClose, onBlur }) => {
    const { t } = useTranslation();

    return (
        // flex-1, no padding/margin of its own: it is a CHILD of the title
        // HStack now, which already owns the row's px-5 and its bottom margin.
        <Box testID="explore-search-input" className="flex-1">
            <Input variant="outline" size="md" className="border-gray-700">
                <View pointerEvents="none" {...HIDDEN} style={{ paddingLeft: SLOT_PAD, justifyContent: 'center', alignItems: 'center' }}>
                    <MaterialIcons name="search" size={GLYPH} color="#999999" {...HIDDEN} />
                </View>
                <InputField
                    // The placeholder is the field's name; gluestack's default
                    // label was the literal "Input Field".
                    aria-label={t('explore.searchPlaceholder')}
                    placeholder={t('explore.searchPlaceholder')}
                    placeholderTextColor="#666666"
                    value={query}
                    onChangeText={onChangeQuery}
                    onBlur={onBlur}
                    className="text-white"
                    autoCorrect={false}
                    autoCapitalize="none"
                    returnKeyType="search"
                    autoFocus
                />
                {/* ALWAYS rendered, unlike the old clear button, which appeared
                    only once there was text. With a query typed it is the only
                    way back to the heading (blur collapses an EMPTY bar only),
                    so it cannot be conditional on the query. The tap target is
                    the button below, outside the Input. */}
                <View pointerEvents="none" {...HIDDEN} style={{ paddingRight: SLOT_PAD, justifyContent: 'center', alignItems: 'center' }}>
                    <MaterialIcons name="close" size={GLYPH} color="#999999" {...HIDDEN} />
                </View>
            </Input>
            <Pressable
                testID="explore-search-close"
                onPress={onClose}
                accessibilityRole="button"
                accessibilityLabel={t('explore.closeSearch')}
                style={CLOSE_TARGET_STYLE}
            />
        </Box>
    );
};

export default ExploreSearchBar;
